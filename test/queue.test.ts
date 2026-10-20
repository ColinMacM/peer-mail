import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunQueue, runsElsewhere } from "../src/queue";
import { SANDBOXED, sandboxedCommand, sandboxProfile, sandboxScript, sandboxUnavailable } from "../src/sandbox";
import { pidAlive, writeJson } from "../src/transport";

let root: string;
let queue: RunQueue;
beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "peer-mail-queue-"));
	queue = new RunQueue(root);
});
afterEach(() => {
	// Each test's root gives its own sandbox profile, and with it a script under SANDBOX_DIR.
	if (sandboxUnavailable() === undefined) {
		for (const other of [root, path.join(root, "other")]) {
			const script = sandboxScript(sandboxProfile(other, 7577));
			fs.rmSync(script, { force: true });
			fs.rmSync(`${script}.sb`, { force: true });
		}
	}
	fs.rmSync(root, { recursive: true, force: true });
});

test("runs wait in the order queued, and a dead session's ticket doesn't hold up the line", async () => {
	writeJson(path.join(queue.dir, "000000000000001-000000000-1.json"), { id: "000000000000001-000000000-1", member: "ghost", pid: 2 ** 22 + 7, command: "x", cwd: root, queuedAt: 1 });
	const first = queue.enqueue("a", "make", root);
	const second = queue.enqueue("b", "make test", root);
	expect(queue.line().map(ticket => ticket.member)).toEqual(["a", "b"]);
	const { promise: heard, resolve } = Promise.withResolvers<string[]>();
	const waiting = queue.waitTurn(second, undefined, ahead => resolve(ahead.map(ticket => ticket.member)));
	expect(await heard).toEqual(["a"]);
	queue.remove(first.id);
	await waiting;
	const aborted = new AbortController();
	const third = queue.enqueue("c", "make", root);
	const blocked = queue.waitTurn(third, aborted.signal, () => {});
	aborted.abort();
	await expect(blocked).rejects.toThrow(/Aborted/);
});

test("a run on another host over ssh takes no place in line, so local runs don't wait behind it", () => {
	expect(runsElsewhere("ssh amr@build-2-1 'cargo test --workspace'")).toBe(true);
	expect(runsElsewhere("  ssh -o BatchMode=yes host make")).toBe(true);
	expect(runsElsewhere("cargo test && ssh host true")).toBe(false);
	expect(runsElsewhere("sshfs host:/ /mnt")).toBe(false);
	expect(runsElsewhere("timeout 600 ssh build-2 'cargo build'")).toBe(true);
	expect(runsElsewhere("SSH_AUTH_SOCK=/tmp/agent env nice -n 5 ssh host make")).toBe(true);
	expect(runsElsewhere("timeout 60 cargo test")).toBe(false);
	queue.ticket("a", "ssh host 'make'", root);
	const local = queue.enqueue("b", "make", root);
	expect(queue.line().map(ticket => ticket.id)).toEqual([local.id]);
});

describe.skipIf(sandboxUnavailable() !== undefined)("sandboxed runs", () => {
	const profile = () => sandboxProfile(root, 7577);

	test.skipIf(!SANDBOXED)("a run can't listen on a socket or reach the mailbox, but works otherwise", async () => {
		fs.mkdirSync(path.join(root, "swarm"), { recursive: true });
		const ticket = queue.enqueue("a", "", os.tmpdir());
		const listen = await queue.run(
			{ ...ticket, command: `python3 -c "import socket; socket.socket().bind(('127.0.0.1', 0))"` },
			profile(),
			10_000,
			undefined,
		);
		expect(listen.exitCode).not.toBe(0);
		expect(listen.output).toContain("Operation not permitted");
		const mailbox = await queue.run({ ...ticket, command: `ls ${root}/swarm` }, profile(), 10_000, undefined);
		expect(mailbox.exitCode).not.toBe(0);
		// The wrapper script holds the profile, so a sandboxed command must not be able to rewrite it.
		const script = sandboxScript(profile());
		const tamper = await queue.run({ ...ticket, command: `echo 'exec "$@"' > ${script}.sb; echo x >> ${script}` }, profile(), 10_000, undefined);
		expect(tamper.exitCode).not.toBe(0);
		expect(sandboxScript(profile())).toBe(script);
		expect(fs.readFileSync(`${script}.sb`, "utf8")).toBe(profile());
		const ok = await queue.run({ ...ticket, command: 'echo $((6 * 7)); test -z "$PEER_MAIL_DIR"' }, profile(), 10_000, undefined);
		expect(ok).toMatchObject({ exitCode: 0, timedOut: false });
		expect(ok.output).toBe("42\n");
	});

	test("a command already sandboxed is not wrapped again, and still runs", () => {
		const once = sandboxedCommand("echo $((6 * 7))", profile());
		expect(sandboxedCommand(once, profile())).toBe(once);
		expect(sandboxedCommand(once, sandboxProfile(path.join(root, "other"), 7577))).not.toBe(once);
		const run = Bun.spawnSync(["/bin/bash", "-c", sandboxedCommand(sandboxedCommand("echo $((6 * 7))", profile()), profile())]);
		expect(run.exitCode).toBe(0);
		expect(run.stdout.toString()).toBe("42\n");
	});

	test("nothing a run starts outlives it, even a process that left its group", async () => {
		const pidFile = path.join(os.tmpdir(), `peer-mail-escapee-${process.pid}`);
		const escape = `python3 -c "import os,time; os.fork() and os._exit(0); os.setsid(); os.fork() and os._exit(0); open('${pidFile}','w').write(str(os.getpid())); time.sleep(60)"`;
		const ticket = queue.enqueue("a", `${escape}; sleep 60 & echo started`, os.tmpdir());
		const result = await queue.run(ticket, profile(), 10_000, undefined);
		expect(result.exitCode).toBe(0);
		expect(result.leftovers).toBe(1);
		// The escapee is SIGKILLed synchronously, but launchd reaps it on its own schedule; there's no event to await.
		await Bun.sleep(100);
		expect(pidAlive(Number(fs.readFileSync(pidFile, "utf8")))).toBe(false);
		fs.rmSync(pidFile, { force: true });
	});

	test("a run past its timeout is killed", async () => {
		const ticket = queue.enqueue("a", "sleep 30", os.tmpdir());
		const result = await queue.run(ticket, profile(), 300, undefined);
		expect(result).toMatchObject({ exitCode: null, timedOut: true });
		expect(result.durationMs).toBeLessThan(5_000);
	});

	test("a run that took no place in line still runs, though nothing was ever queued", async () => {
		const result = await queue.run(queue.ticket("a", "echo $((6 * 7))", os.tmpdir()), profile(), 10_000, undefined);
		expect(result).toMatchObject({ exitCode: 0, output: "42\n" });
	});
});
