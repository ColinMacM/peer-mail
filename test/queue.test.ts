import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunQueue } from "../src/queue";
import { sandboxProfile, sandboxUnavailable } from "../src/sandbox";
import { pidAlive, writeJson } from "../src/transport";

let root: string;
let queue: RunQueue;
beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "peer-mail-queue-"));
	queue = new RunQueue(root);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

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

describe.skipIf(sandboxUnavailable() !== undefined)("sandboxed runs", () => {
	const profile = () => sandboxProfile(root, 7577);

	test("a run can't listen on a socket or reach the mailbox, but works otherwise", async () => {
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
		const ok = await queue.run({ ...ticket, command: 'echo $((6 * 7)); test -z "$PEER_MAIL_DIR"' }, profile(), 10_000, undefined);
		expect(ok).toMatchObject({ exitCode: 0, timedOut: false });
		expect(ok.output).toBe("42\n");
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
});
