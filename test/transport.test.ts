import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Membership } from "../src/inbox";
import { StalePhaseError, Swarm } from "../src/transport";

let root: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "peer-mail-"));
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** A pid that is certainly not running: a child that has already exited. */
function deadPid(): number {
	return Bun.spawnSync(["true"]).pid;
}

/** A member joined from another (finished) process, so it can't collide with this test's pid. */
function otherMember(swarm: Swarm, name: string): string {
	const phase = swarm.current("test").id;
	return swarm.join(name, phase, "/x", deadPid()).name;
}

test("members of a swarm reach each other; other swarms and isolated sessions can't", () => {
	const robot = new Swarm("project_fix_robot", root);
	const docs = new Swarm("docs", root);
	const programmer = Membership.join(robot, "programmer", "/r", true);
	otherMember(robot, "reviewer");
	const writer = Membership.join(docs, "writer", "/d", true);

	programmer.send("reviewer", "please review the gripper fix");
	expect(() => programmer.send("writer", "hi")).toThrow(/has no member "writer". Members: programmer, reviewer/);
	expect(() => writer.send("reviewer", "hi")).toThrow(/has no member "reviewer"/);
	expect(robot.pending("reviewer")).toBe(1);
});

test("/startswarm ends the previous phase: old members go stale and their mail is gone", () => {
	const swarm = new Swarm("project_fix_robot", root);
	const old = Membership.join(swarm, "programmer", "/r", true);
	otherMember(swarm, "reviewer");
	old.send("reviewer", "from the old run");

	const fresh = Membership.join(new Swarm("project_fix_robot", root), "lead", "/r", true);

	expect(fresh.swarm.peers().map(peer => peer.name)).toEqual(["lead"]);
	expect(fresh.swarm.pending("reviewer")).toBe(0);
	expect(() => old.send("lead", "still there?")).toThrow(StalePhaseError);
	expect(() => old.receive()).toThrow(StalePhaseError);
	expect(() => old.heartbeat()).toThrow(StalePhaseError);
});

test("/swarm joins the current phase and can mail the members already there", () => {
	const swarm = new Swarm("project_fix_robot", root);
	const lead = Membership.join(swarm, "lead", "/r", true);
	const joiner = Membership.join(new Swarm("project_fix_robot", root), "agent", "/r", false);

	expect(joiner.swarm.peers().map(peer => peer.name).sort()).toEqual(["agent", "lead"]);
	joiner.send("lead", "I'm in");
	expect(lead.receive().map(message => [message.from, message.body])).toEqual([["agent", "I'm in"]]);
	expect(lead.receive()).toEqual([]);
});

test("mail is delivered once, in sending order, and kept as history", () => {
	const swarm = new Swarm("s", root);
	const ada = Membership.join(swarm, "ada", "/a", true);
	const lee = Membership.join(swarm, "lee", "/b", false);
	ada.send("lee", "first");
	ada.send("lee", "second");

	expect(lee.receive().map(message => message.body)).toEqual(["first", "second"]);
	expect(lee.receive()).toEqual([]);
	expect(swarm.history("lee").map(message => message.body)).toEqual(["first", "second"]);
});

test("a name held by a running session gets a suffix; a dead session's name is taken over", () => {
	const swarm = new Swarm("s", root);
	const phase = swarm.start("test").id;
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
	const swarm = new Swarm("s", root);
	const old = Membership.join(swarm, "ghost", "/g", true);
	Membership.join(new Swarm("s", root), "lead", "/r", true);
	// Its heartbeat raced the restart and landed in the new directory with the old phase.
	fs.writeFileSync(path.join(swarm.dir, "peers", "ghost.json"), JSON.stringify(old.peer));

	expect(swarm.peers().map(peer => peer.name)).toEqual(["lead"]);
});

test("renaming brings waiting mail along", () => {
	const swarm = new Swarm("s", root);
	const session = Membership.join(swarm, "agent", "/r", true);
	Membership.join(swarm, "ada", "/a", false).send("agent", "for the old name");

	expect(session.rename("reviewer")).toBe("reviewer");
	expect(session.receive().map(message => [message.to, message.body])).toEqual([["reviewer", "for the old name"]]);
});
