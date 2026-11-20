import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chooseSwarm, type Identity, Membership } from "../src/inbox";
import { Swarm } from "../src/transport";

let root: string;
let swarm: Swarm;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "peer-mail-"));
	swarm = new Swarm(root, "run");
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** A hub with a plan and two spawned agents, then herdr restarts: every session closes. Returns what each session recorded. */
function crashedSwarm(): { hub: Identity; scout: Identity; coder: Identity } {
	const hub = Membership.start(swarm, "2.0.0", "agent", "/r");
	hub.rename("hub");
	swarm.setPlan(hub.peer, [{ id: "t1", title: "scout", agent: "scout" }, { id: "t2", title: "code", agent: "coder" }]);
	const scout = Membership.spawned(swarm, swarm.requestSpawn(hub.peer, "scout", "look", ["t1"]), "/r");
	const coder = Membership.spawned(swarm, swarm.requestSpawn(hub.peer, "coder", "code", ["t2"]), "/r");
	const identities = { hub: hub.identity(), scout: scout.identity(), coder: coder.identity() };
	hub.send("coder", "sent before the crash");
	for (const member of [hub, scout, coder]) member.leave("closed");
	return identities;
}

test("after the swarm is lost, each relaunched session's /swarm puts it back under its name and hub, in any order", () => {
	const before = crashedSwarm();
	const phase = swarm.phase();

	const coder = Membership.attach(swarm, "agent", "/r", { identity: before.coder });
	const hub = Membership.attach(swarm, "agent", "/r", { identity: before.hub });
	const scout = Membership.attach(swarm, "agent", "/r", { identity: before.scout });

	expect(swarm.phase()).toEqual(phase);
	expect([hub, scout, coder].map(member => [member.name, member.hub])).toEqual([
		["hub", null],
		["scout", "hub"],
		["coder", "hub"],
	]);
	expect(swarm.plan("hub").map(task => `${task.id}:${task.agent}`)).toEqual(["t1:scout", "t2:coder"]);
	expect(coder.receive().map(message => message.body)).toEqual(["sent before the crash"]);
	expect(swarm.reachable("hub").map(peer => peer.name).sort()).toEqual(["coder", "scout"]);
});

test("after the swarm is lost, the first /swarm leads it and every later /swarm joins it as an agent", () => {
	crashedSwarm();

	const first = Membership.attach(swarm, "lead", "/r");
	const second = Membership.attach(swarm, "helper", "/r");
	const third = Membership.attach(swarm, "tester", "/r");

	expect(first.hub).toBeNull();
	expect([second.hub, third.hub]).toEqual(["lead", "lead"]);
	expect(swarm.peers().filter(peer => peer.hub === null && swarm.isOnline(peer)).map(peer => peer.name)).toEqual(["lead"]);
});

test("/swarm with nothing running starts the swarm and leads it", () => {
	const lead = Membership.attach(swarm, "agent", "/home/me/robot");
	const helper = Membership.attach(swarm, "helper", "/home/me/robot");

	expect(swarm.phase()?.label).toBe("robot");
	expect([lead.hub, helper.hub]).toEqual([null, "agent"]);
});

test("when the mailbox itself is gone, the swarm comes back as the one the sessions were in, with the hub's plan", () => {
	const before = crashedSwarm();
	fs.rmSync(swarm.dir, { recursive: true, force: true });

	const scout = Membership.attach(swarm, "agent", "/r", { identity: before.scout });
	const hub = Membership.attach(swarm, "agent", "/r", { identity: before.hub });

	expect(swarm.phase()).toMatchObject({ id: before.hub.phase, label: "2.0.0" });
	expect([hub.name, hub.hub, scout.name, scout.hub]).toEqual(["hub", null, "scout", "hub"]);
	expect(swarm.plan("hub").map(task => `${task.id}:${task.agent}`)).toEqual(["t1:scout", "t2:coder"]);
	scout.send("hub", "back");
	expect(hub.receive().map(message => message.body)).toEqual(["back"]);
});

test("a session from a swarm since replaced by /startswarm joins the new one's lead under its old name", () => {
	const before = crashedSwarm();
	const lead = Membership.start(new Swarm(root, "run"), "fresh", "lead", "/r");

	const scout = Membership.attach(swarm, "agent", "/r", { identity: before.scout });
	expect([scout.name, scout.hub]).toEqual(["scout", lead.name]);
});

test("a relaunched agent follows its hub's rename made while it was away", () => {
	const before = crashedSwarm();
	const hub = Membership.attach(swarm, "agent", "/r", { identity: before.hub });
	hub.rename("lead");

	const scout = Membership.attach(swarm, "agent", "/r", { identity: before.scout });
	expect(scout.hub).toBe("lead");
});

test("/swarm without a label: its earlier swarm, else the one running, else asks which of several", () => {
	const identity = (label: string): Identity => ({ phase: "p", label, name: "x", hub: null });
	// Nothing yet: a swarm named after the directory.
	expect(chooseSwarm(root, "/home/me/Robot Arm", undefined, undefined).name).toBe("robot-arm");
	const two = Membership.start(Swarm.named("2.0.0", root), "2.0.0", "hub2", "/r");
	expect(chooseSwarm(root, "/r", undefined, undefined).name).toBe("2.0.0");
	const three = Membership.start(Swarm.named("3.0.0", root), "3.0.0", "hub3", "/r");
	expect(() => chooseSwarm(root, "/r", undefined, undefined)).toThrow("Several swarms are running: 2.0.0, 3.0.0. Join one with /swarm [label].");
	// Its earlier swarm, even when another is running and that one isn't; a label always wins.
	two.leave("closed");
	expect(chooseSwarm(root, "/r", undefined, undefined).name).toBe("3.0.0");
	expect(chooseSwarm(root, "/r", undefined, identity("2.0.0")).name).toBe("2.0.0");
	expect(chooseSwarm(root, "/r", "2.0.0", identity("3.0.0")).name).toBe("2.0.0");
	three.leave("closed");
	expect(() => chooseSwarm(root, "/r", undefined, undefined)).toThrow("There are several swarms: 2.0.0, 3.0.0.");
});
