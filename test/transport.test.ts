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
	expect(() => programmer.send("loner", "hi")).toThrow(/Can't send to "loner": the swarm has no such member/);
});

test("/startswarm ends the previous phase: old members go stale and their mail is gone", () => {
	const old = Membership.start(swarm, "first run", "programmer", "/r");
	swarm.join("reviewer", old.peer.phase, "/x", { pid: deadPid() });
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
		swarm.join("agent", phase, "/r", { pid: holder.pid });
		expect(swarm.join("agent", phase, "/r").name).toBe("agent-2");
	} finally {
		holder.kill();
	}
	swarm.join("other", phase, "/o", { pid: deadPid() });
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
	expect(() => ada.send("agent", "to the old name")).toThrow(/Can't send to "agent": the swarm has no such member/);
});

test("a vertex reaches only its hub; a hub reaches its vertices and other hubs, not their vertices", () => {
	const lead = Membership.start(swarm, "s", "lead", "/r");
	const other = Membership.attach(swarm, "other", "/o");
	const reviewer = Membership.spawned(swarm, swarm.requestSpawn(lead.peer, "reviewer", "review"), "/r");
	const tester = Membership.spawned(swarm, swarm.requestSpawn(lead.peer, "tester", "test"), "/r");
	const helper = Membership.spawned(swarm, swarm.requestSpawn(other.peer, "helper", "help"), "/o");

	const names = (member: Membership) => swarm.reachable(member.name).map(peer => peer.name).sort();
	expect(names(reviewer)).toEqual(["lead"]);
	expect(names(lead)).toEqual(["other", "reviewer", "tester"]);
	expect(names(other)).toEqual(["helper", "lead"]);
	expect(() => reviewer.send("tester", "hi")).toThrow(/Can't send to "tester": you can't message it. You can message: lead/);
	expect(() => lead.send("helper", "hi")).toThrow(/you can't message it/);
	expect(reviewer.send("all", "done").map(message => message.to)).toEqual(["lead"]);
	expect(helper.hub).toBe("other");
});

test("a spawn request is used once and finds the member that joined for it", () => {
	const lead = Membership.start(swarm, "s", "lead", "/r");
	const request = swarm.requestSpawn(lead.peer, "reviewer", "review the diff");
	expect(swarm.spawned(request.id)).toBeUndefined();

	const taken = swarm.takeSpawn(request.id)!;
	expect(taken.prompt).toBe("review the diff");
	expect(swarm.takeSpawn(request.id)).toBeUndefined();
	const vertex = Membership.spawned(swarm, taken, "/r");
	expect(swarm.spawned(request.id)?.name).toBe(vertex.name);
});

test("/startswarm throws away spawn requests that haven't been taken", () => {
	const lead = Membership.start(swarm, "first", "lead", "/r");
	const request = swarm.requestSpawn(lead.peer, "reviewer", "review");
	Membership.start(new Swarm(root), "second", "lead", "/r");
	expect(swarm.takeSpawn(request.id)).toBeUndefined();
});

test("a hub that renames itself keeps its vertices", () => {
	const lead = Membership.start(swarm, "s", "agent", "/r");
	const reviewer = Membership.spawned(swarm, swarm.requestSpawn(lead.peer, "reviewer", "review"), "/r");

	lead.rename("lead");
	expect(reviewer.hub).toBe("lead");
	expect(reviewer.send("lead", "done").map(message => message.to)).toEqual(["lead"]);
	expect(swarm.reachable("lead").map(peer => peer.name)).toEqual(["reviewer"]);
});

test("the graph view draws exactly the edges mail can travel", async () => {
	const { graphState } = await import("../src/graph");
	const lead = Membership.start(swarm, "s", "lead", "/r");
	const other = Membership.attach(swarm, "other", "/o");
	Membership.spawned(swarm, swarm.requestSpawn(lead.peer, "reviewer", "review"), "/r");
	Membership.spawned(swarm, swarm.requestSpawn(other.peer, "helper", "help"), "/o");

	const edges = graphState(swarm).edges.map(edge => [...edge].sort().join("-")).sort();
	const reachable = swarm
		.peers()
		.flatMap(peer => swarm.reachable(peer.name).map(to => [peer.name, to.name].sort().join("-")));
	expect(edges).toEqual([...new Set(reachable)].sort());
	expect(edges).toEqual(["helper-other", "lead-other", "lead-reviewer"]);
});

test("a finished agent is skipped by broadcasts until mail sent to it by name brings it back", () => {
	const lead = Membership.start(swarm, "s", "lead", "/r");
	const reviewer = Membership.spawned(swarm, swarm.requestSpawn(lead.peer, "reviewer", "review"), "/r");
	const tester = Membership.spawned(swarm, swarm.requestSpawn(lead.peer, "tester", "test"), "/r");
	reviewer.setStatus({ status: "review done", finished: true });

	expect(lead.send("all", "rebase on main").map(message => message.to)).toEqual(["tester"]);
	lead.send("reviewer", "one more file");
	expect(reviewer.receive().map(message => message.body)).toEqual(["one more file"]);
	expect(swarm.peer("reviewer")).toMatchObject({ status: "review done", finished: false });
	expect(lead.send("all", "stop").map(message => message.to).sort()).toEqual(["reviewer", "tester"]);
	expect(tester.receive().map(message => message.body)).toEqual(["rebase on main", "stop"]);
});
