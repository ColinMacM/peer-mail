import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Inbox } from "../src/inbox";
import { Transport } from "../src/transport";

let root: string;
let transport: Transport;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "peer-mail-"));
	transport = new Transport(root);
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** A pid that is certainly not running: a child that has already exited. */
function deadPid(): number {
	const child = Bun.spawnSync(["true"]);
	return child.pid;
}

test("mail is delivered once, in sending order", () => {
	transport.join("ada", "/a");
	transport.join("lee", "/b", deadPid());
	transport.send("ada", "lee", "first");
	transport.send("ada", "lee", "second");

	expect(transport.receive("lee").map(message => message.body)).toEqual(["first", "second"]);
	expect(transport.receive("lee")).toEqual([]);
	expect(transport.history("lee").map(message => message.body)).toEqual(["first", "second"]);
});

test("mail to a session that left waits until it joins again", () => {
	const lee = new Inbox(transport, "lee", "/b");
	transport.join("ada", "/a", deadPid());
	lee.leave();
	transport.send("ada", "lee", "while you were out");

	const back = new Inbox(transport, "lee", "/b");
	expect(back.name).toBe("lee");
	expect(back.receive().map(message => message.body)).toEqual(["while you were out"]);
});

test("a name held by a live session gets a suffix; a dead session's name is taken over", () => {
	const holder = Bun.spawn(["sleep", "30"]);
	try {
		transport.join("repo", "/r", holder.pid);
		expect(transport.join("repo", "/r").name).toBe("repo-2");
	} finally {
		holder.kill();
	}
	transport.join("other", "/o", deadPid());
	expect(transport.join("other", "/o").name).toBe("other");
});

test("broadcast reaches every other peer, and unknown names are refused", () => {
	transport.join("ada", "/a");
	transport.join("lee", "/b", deadPid());
	transport.join("kim", "/c", deadPid());

	expect(transport.send("ada", "all", "standup").map(message => message.to).sort()).toEqual(["kim", "lee"]);
	expect(() => transport.send("ada", "nobody", "hi")).toThrow(/Known peers: ada, kim, lee/);
	expect(() => transport.send("ada", "lee", "   ")).toThrow(/empty/);
});

test("renaming brings waiting mail along", () => {
	const session = new Inbox(transport, "repo", "/r");
	transport.join("ada", "/a", deadPid());
	transport.send("ada", "repo", "for the old name");

	expect(session.rename("reviewer")).toBe("reviewer");
	expect(session.receive().map(message => [message.to, message.body])).toEqual([["reviewer", "for the old name"]]);
	expect(transport.isOnline(transport.peer("repo")!)).toBe(false);
});
