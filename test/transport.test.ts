import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatForAgent, Membership } from "../src/inbox";
import { StalePhaseError, Swarm, taskDone } from "../src/transport";

let root: string;
let swarm: Swarm;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "peer-mail-"));
	swarm = new Swarm(root, "run");
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** A pid that is certainly not running: a child that has already exited. */
function deadPid(): number {
	return Bun.spawnSync(["true"]).pid;
}

/** A second hub: one only arises from a session rejoining under its earlier place as a hub. */
function otherHub(lead: Membership): Membership {
	return Membership.attach(swarm, "agent", "/o", { identity: { phase: lead.peer.phase, label: "s", name: "other", hub: null } });
}

test("/swarm joins the running swarm as an agent of its lead", () => {
	const lead = Membership.start(swarm, "project_fix_robot", "lead", "/r");
	const joiner = Membership.attach(new Swarm(root, "run"), "agent", "/r");
	expect(joiner.hub).toBe("lead");

	expect(swarm.peers().map(peer => peer.name).sort()).toEqual(["agent", "lead"]);
	expect(swarm.phase()?.label).toBe("project_fix_robot");
	joiner.send("lead", "I'm in");
	expect(lead.receive().map(message => [message.from, message.body])).toEqual([["agent", "I'm in"]]);
	expect(lead.receive()).toEqual([]);
});

test("only members can be addressed", () => {
	const programmer = Membership.start(swarm, "s", "programmer", "/r");
	expect(() => programmer.send("loner", "hi")).toThrow(/Can't send to "loner": the swarm has no such member/);
});

test("an interrupt is marked as one all the way to the agent's conversation", () => {
	const hub = Membership.start(swarm, "s", "hub", "/r");
	const agent = Membership.attach(swarm, "agent", "/r");
	hub.send(agent.name, "stop and do t2", { interrupt: true });
	hub.send(agent.name, "plain");
	const [stop, plain] = agent.receive();
	expect(formatForAgent(stop).split("\n")[0]).toContain('"interrupt":true');
	expect(formatForAgent(plain)).not.toContain("interrupt");
});

test("/startswarm ends the previous phase: old members go stale and their mail is gone", () => {
	const old = Membership.start(swarm, "first run", "programmer", "/r");
	swarm.join("reviewer", old.peer.phase, "/x", { pid: deadPid() });
	old.send("reviewer", "from the old run");

	const fresh = Membership.start(new Swarm(root, "run"), "second run", "lead", "/r");

	expect(swarm.peers().map(peer => peer.name)).toEqual(["lead"]);
	expect(swarm.pending("reviewer")).toBe(0);
	expect(() => old.send("lead", "still there?")).toThrow(StalePhaseError);
	expect(() => old.receive()).toThrow(StalePhaseError);
	expect(() => old.heartbeat()).toThrow(StalePhaseError);
	expect(fresh.receive()).toEqual([]);
});

test("swarms run side by side: /startswarm [3.0.0] leaves 2.0.0 running, and each label's /swarm joins its own lead", () => {
	const two = Swarm.named("2.0.0", root);
	const three = Swarm.named("3.0.0", root);
	const lead2 = Membership.start(two, "2.0.0", "lead2", "/r");
	const lead3 = Membership.start(three, "3.0.0", "lead3", "/r");
	const agent2 = Membership.attach(Swarm.named("2.0.0", root), "agent", "/r");
	const agent3 = Membership.attach(Swarm.named("3.0.0", root), "agent", "/r");

	expect([agent2.hub, agent3.hub]).toEqual(["lead2", "lead3"]);
	expect(Swarm.all(root).map(swarm => swarm.phase()?.label)).toEqual(["2.0.0", "3.0.0"]);
	// Mail stays inside a swarm, and the same name can be taken in each.
	expect(agent2.name).toBe(agent3.name);
	agent2.send("lead2", "for 2.0.0");
	expect(() => agent3.send("lead2", "across")).toThrow(/no such member/);
	expect(lead2.receive().map(message => message.body)).toEqual(["for 2.0.0"]);
	expect(lead3.receive()).toEqual([]);
	// Starting 3.0.0 afresh leaves 2.0.0 as it was.
	Membership.start(Swarm.named("3.0.0", root), "3.0.0", "lead3", "/r");
	expect(() => agent3.receive()).toThrow(StalePhaseError);
	expect(two.peers().map(peer => peer.name).sort()).toEqual(["agent", "lead2"]);
	agent2.send("lead2", "still here");
	expect(lead2.receive().map(message => message.body)).toEqual(["still here"]);
});

test("older peer-mail's one swarm is joined where it is while it runs, and moves under its name once none of its members does", () => {
	const legacy = path.join(root, "swarm");
	const write = (file: string, value: unknown) => {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify(value));
	};
	write(path.join(legacy, "phase.json"), { id: "p1", label: "2.0.0", startedAt: 1, startedBy: "hub" });
	const peer = { name: "hub", phase: "p1", pid: process.pid, host: os.hostname(), cwd: "/r", joinedAt: 1, seenAt: 1, hub: null };
	write(path.join(legacy, "peers", "hub.json"), peer);
	write(path.join(legacy, "plans", "hub.json"), [{ id: "t1", title: "kept" }]);
	// Its hub still runs (on older code): /swarm [2.0.0] joins it there, as that hub's agent.
	const agent = Membership.attach(Swarm.named("2.0.0", root), "agent", "/r");
	expect([agent.swarm.dir, agent.hub]).toEqual([legacy, "hub"]);
	expect(Swarm.all(root).map(swarm => swarm.dir)).toEqual([legacy]);
	// Nobody runs any more: it moves under its name, plan and all.
	agent.leave("closed");
	write(path.join(legacy, "peers", "hub.json"), { ...peer, pid: deadPid() });
	const [adopted] = Swarm.all(root);
	expect([adopted.dir, adopted.phase()?.id, adopted.plan("hub")[0].title]).toEqual([path.join(root, "swarms", "2.0.0"), "p1", "kept"]);
	expect(fs.existsSync(legacy)).toBe(false);
});

test("a spawned session finds the swarm whose hub left its request", () => {
	const hub = Membership.start(Swarm.named("3.0.0", root), "3.0.0", "hub", "/r");
	Membership.start(Swarm.named("2.0.0", root), "2.0.0", "other", "/r");
	const request = hub.swarm.requestSpawn(hub.peer, "tester", "test it", []);
	expect(Swarm.ofSpawn(request.id, root)?.name).toBe("3.0.0");
	expect(Swarm.ofSpawn("no-such-request", root)).toBeUndefined();
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
	Membership.start(new Swarm(root, "run"), "s", "lead", "/r");
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
	const other = otherHub(lead);
	const reviewer = Membership.spawned(swarm, swarm.requestSpawn(lead.peer, "reviewer", "review", []), "/r");
	const tester = Membership.spawned(swarm, swarm.requestSpawn(lead.peer, "tester", "test", []), "/r");
	const helper = Membership.spawned(swarm, swarm.requestSpawn(other.peer, "helper", "help", []), "/o");

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
	const request = swarm.requestSpawn(lead.peer, "reviewer", "review the diff", []);
	expect(swarm.spawned(request.id)).toBeUndefined();

	const taken = swarm.takeSpawn(request.id)!;
	expect(taken.prompt).toBe("review the diff");
	expect(swarm.takeSpawn(request.id)).toBeUndefined();
	const vertex = Membership.spawned(swarm, taken, "/r");
	expect(swarm.spawned(request.id)?.name).toBe(vertex.name);
});

test("/startswarm throws away spawn requests that haven't been taken", () => {
	const lead = Membership.start(swarm, "first", "lead", "/r");
	const request = swarm.requestSpawn(lead.peer, "reviewer", "review", []);
	Membership.start(new Swarm(root, "run"), "second", "lead", "/r");
	expect(swarm.takeSpawn(request.id)).toBeUndefined();
});

test("a hub that renames itself keeps its vertices", () => {
	const lead = Membership.start(swarm, "s", "agent", "/r");
	const reviewer = Membership.spawned(swarm, swarm.requestSpawn(lead.peer, "reviewer", "review", []), "/r");

	lead.rename("lead");
	expect(reviewer.hub).toBe("lead");
	expect(reviewer.send("lead", "done").map(message => message.to)).toEqual(["lead"]);
	expect(swarm.reachable("lead").map(peer => peer.name)).toEqual(["reviewer"]);
});

test("renames keep the plan: a hub keeps its plan, an agent keeps its tasks and steps", () => {
	const lead = Membership.start(swarm, "s", "agent", "/r");
	swarm.setPlan(lead.peer, [{ id: "t1", title: "review", agent: "reviewer" }, { id: "t2", title: "merge" }]);
	const reviewer = Membership.spawned(swarm, swarm.requestSpawn(lead.peer, "reviewer", "review", ["t1"]), "/r");
	swarm.setSteps(reviewer.peer, "t1", [{ id: "s1", title: "read diff", done: true }]);

	lead.rename("lead");
	reviewer.rename("critic");
	expect(swarm.plan("lead").map(task => `${task.id}:${task.agent ?? "-"}`)).toEqual(["t1:critic", "t2:-"]);
	expect(swarm.steps("critic")).toEqual({ t1: [{ id: "s1", title: "read diff", done: true }] });
	expect(taskDone(swarm.plan("lead")[0], swarm.steps("critic").t1)).toBe(true);
});

test("the graph view draws exactly the edges mail can travel", async () => {
	const { graphState } = await import("../src/graph");
	const lead = Membership.start(swarm, "s", "lead", "/r");
	const other = otherHub(lead);
	Membership.spawned(swarm, swarm.requestSpawn(lead.peer, "reviewer", "review", []), "/r");
	Membership.spawned(swarm, swarm.requestSpawn(other.peer, "helper", "help", []), "/o");

	const edges = graphState(swarm).edges.map(edge => [...edge].sort().join("-")).sort();
	const reachable = swarm
		.peers()
		.flatMap(peer => swarm.reachable(peer.name).map(to => [peer.name, to.name].sort().join("-")));
	expect(edges).toEqual([...new Set(reachable)].sort());
	expect(edges).toEqual(["helper-other", "lead-other", "lead-reviewer"]);
});

test("a finished agent is skipped by broadcasts until mail sent to it by name brings it back", () => {
	const lead = Membership.start(swarm, "s", "lead", "/r");
	const reviewer = Membership.spawned(swarm, swarm.requestSpawn(lead.peer, "reviewer", "review", []), "/r");
	const tester = Membership.spawned(swarm, swarm.requestSpawn(lead.peer, "tester", "test", []), "/r");
	reviewer.setStatus({ status: "review done", finished: true });

	expect(lead.send("all", "rebase on main").map(message => message.to)).toEqual(["tester"]);
	lead.send("reviewer", "one more file");
	expect(reviewer.receive().map(message => message.body)).toEqual(["one more file"]);
	expect(swarm.peer("reviewer")).toMatchObject({ status: "review done", finished: false });
	expect(lead.send("all", "stop").map(message => message.to).sort()).toEqual(["reviewer", "tester"]);
	expect(tester.receive().map(message => message.body)).toEqual(["rebase on main", "stop"]);
});

test("a member whose heartbeat is late is still online while its process runs: after the Mac sleeps every heartbeat is late", () => {
	const lead = Membership.start(swarm, "s", "lead", "/r");
	const reviewer = Membership.spawned(swarm, swarm.requestSpawn(lead.peer, "reviewer", "review", []), "/r");
	const late = Date.now() + 10 * 60_000;
	expect(swarm.isOnline(swarm.peer("reviewer")!, late)).toBe(true);

	reviewer.leave("closed");
	expect(swarm.peer("reviewer")).toMatchObject({ pid: null, leftHow: "closed" });
	expect(swarm.isOnline(swarm.peer("reviewer")!)).toBe(false);
});
