import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Membership } from "../src/inbox";
import { StalePhaseError, Swarm } from "../src/transport";

let root: string;
let swarm: Swarm;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "peer-mail-"));
	swarm = new Swarm(root);
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** A pid that is certainly not running: a child that has already exited. */
function deadPid(): number {
	return Bun.spawnSync(["true"]).pid;
}

test("/swarm attaches to the running swarm and can mail the members already there", () => {
	const lead = Membership.start(swarm, "project_fix_robot", "lead", "/r");
	const joiner = Membership.attach(new Swarm(root), "agent", "/r");

	expect(swarm.peers().map(peer => peer.name).sort()).toEqual(["agent", "lead"]);
	expect(swarm.phase()?.label).toBe("project_fix_robot");
	joiner.send("lead", "I'm in");
	expect(lead.receive().map(message => [message.from, message.body])).toEqual([["agent", "I'm in"]]);
	expect(lead.receive()).toEqual([]);
});

test("/swarm with nothing running is refused rather than starting a swarm", () => {
	expect(() => Membership.attach(swarm, "agent", "/r")).toThrow(/No swarm is running/);
	expect(swarm.phase()).toBeUndefined();
});

test("only members can be addressed", () => {
	const programmer = Membership.start(swarm, "s", "programmer", "/r");
	expect(() => programmer.send("loner", "hi")).toThrow(/no member "loner". Members: programmer/);
});

test("/startswarm ends the previous phase: old members go stale and their mail is gone", () => {
	const old = Membership.start(swarm, "first run", "programmer", "/r");
	swarm.join("reviewer", old.peer.phase, "/x", deadPid());
	old.send("reviewer", "from the old run");

	const fresh = Membership.start(new Swarm(root), "second run", "lead", "/r");

	expect(swarm.peers().map(peer => peer.name)).toEqual(["lead"]);
	expect(swarm.pending("reviewer")).toBe(0);
	expect(() => old.send("lead", "still there?")).toThrow(StalePhaseError);
	expect(() => old.receive()).toThrow(StalePhaseError);
	expect(() => old.heartbeat()).toThrow(StalePhaseError);
	expect(fresh.receive()).toEqual([]);
});

test("mail is delivered once, in sending order, and kept as history", () => {
	const ada = Membership.start(swarm, "s", "ada", "/a");
	const lee = Membership.attach(swarm, "lee", "/b");
	ada.send("lee", "first");
	ada.send("lee", "second");

	expect(lee.receive().map(message => message.body)).toEqual(["first", "second"]);
	expect(lee.receive()).toEqual([]);
	expect(swarm.history("lee").map(message => message.body)).toEqual(["first", "second"]);
});

test("a name held by a running session gets a suffix; a dead session's name is taken over", () => {
	const phase = swarm.start("s", "test").id;
	const holder = Bun.spawn(["sleep", "30"]);
	try {
		swarm.join("agent", phase, "/r", holder.pid);
		expect(swarm.join("agent", phase, "/r").name).toBe("agent-2");
	} finally {
		holder.kill();
	}
	swarm.join("other", phase, "/o", deadPid());
	expect(swarm.join("other", phase, "/o").name).toBe("other");
});

test("a stale session's late write doesn't put it back in the new phase", () => {
	const old = Membership.start(swarm, "s", "ghost", "/g");
	Membership.start(new Swarm(root), "s", "lead", "/r");
	// Its heartbeat raced the restart and landed in the new directory with the old phase.
	fs.writeFileSync(path.join(swarm.dir, "peers", "ghost.json"), JSON.stringify(old.peer));

	expect(swarm.peers().map(peer => peer.name)).toEqual(["lead"]);
});

test("renaming to a role brings waiting mail along and frees the old name", () => {
	const session = Membership.start(swarm, "s", "agent", "/r");
	const ada = Membership.attach(swarm, "ada", "/a");
	ada.send("agent", "for the old name");

	expect(session.rename("Reviewer Bot")).toBe("reviewer-bot");
	expect(session.receive().map(message => [message.to, message.body])).toEqual([["reviewer-bot", "for the old name"]]);
	ada.send("reviewer-bot", "for the new name");
	expect(session.receive().map(message => message.body)).toEqual(["for the new name"]);
	expect(swarm.peers().map(peer => peer.name).sort()).toEqual(["ada", "reviewer-bot"]);
	expect(() => ada.send("agent", "to the old name")).toThrow(/no member "agent"/);
});
