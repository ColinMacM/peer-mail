/**
 * The shared swarm mailbox. It holds any number of swarms side by side, each named after its
 * label (`/startswarm [2.0.0]` is the swarm `2.0.0`). Only sessions that joined a swarm can mail,
 * and only within it; every other session is isolated.
 *
 *   <root>/swarms/<swarm>/phase.json                   the current phase: its label, who started it, when
 *   <root>/swarms/<swarm>/peers/<name>.json            a member: pid, cwd, phase, hub, last heartbeat
 *   <root>/swarms/<swarm>/inbox/<name>/<id>.json       mail waiting for <name>
 *   <root>/swarms/<swarm>/delivered/<name>/<id>.json   mail <name> has received (its history)
 *   <root>/swarms/<swarm>/spawns/<id>.json             a hub's request for a new vertex, until it starts
 *
 * Members form a graph: hubs (joined by hand) and vertices (spawned by a hub). A vertex can
 * message only its hub; a hub can message its vertices and the other hubs of its swarm.
 *
 * `/startswarm` begins a new phase of one swarm: its directory is deleted and recreated, so its
 * earlier members and their mail are gone; other swarms are untouched. A session still holding
 * the old phase id is stale: its heartbeat, sends and receives are refused, and anything it
 * manages to write carries the old phase and is ignored by the new one.
 *
 * Older peer-mail kept its one swarm in <root>/swarm. It is used there, under its label's name,
 * while any of its members runs, and moves to swarms/<name> once none does (adoptLegacy).
 *
 * Files are written to a temp name and renamed into place, so a reader never sees half a message.
 * A message is received by renaming it from inbox/ to delivered/: rename is atomic, so exactly one
 * session gets each message even if two poll at once.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Phase {
	id: string;
	/** What this run is for, as given to /startswarm (shown to members and in status). */
	label: string;
	startedAt: number;
	startedBy: string;
}

export interface Peer {
	name: string;
	phase: string;
	/** null once the session has left (its name and mail stay for when it returns). */
	pid: number | null;
	host: string;
	cwd: string;
	joinedAt: number;
	seenAt: number;
	/**
	 * The member that spawned this one, or null for a hub (a session someone started and joined
	 * by hand). A vertex can only message its hub; a hub can message its vertices and other hubs.
	 */
	hub: string | null;
	/** The spawn request this member was started for, if it was spawned. */
	spawn?: string;
	/** Where the member's session runs in kitty, so the graph view can focus it. */
	kitty?: KittyWindow;
	/** Where the member's session runs in herdr, so the graph view can focus it and a hub can split beside it. */
	herdr?: HerdrPane;
	/** The model the member's session runs, as `provider/id`, refreshed with each heartbeat. */
	model?: string;
	/** What the member was doing at its last heartbeat. */
	activity?: Activity;
	/** When the member's session ended; unset while it runs or if its process died without shutting down. */
	leftAt?: number;
	/** How it ended: its session was closed (only the user closes agents' sessions), or it left the swarm. */
	leftHow?: "closed" | "left";
	/** A short status the member set itself with peer_status. */
	status?: string;
	/** Set by the member when its work is done; broadcasts skip it, and mail to it clears it. */
	finished?: boolean;
	/** Which peer-mail code the member's session loaded (see version.ts). */
	plugin?: string;
}

/** What a member is doing: thinking, running a tool (the latest one it started), or idle. */
export interface Activity {
	state: "thinking" | "running" | "idle";
	/** The tool it is running, or ran last. */
	tool?: string;
	/** The tool call's stated intent, when it gave one. */
	intent?: string;
	since: number;
	/** Background jobs it has running (async commands, background subagents). */
	jobs?: number;
}

/** A kitty window, and the remote-control socket of the kitty instance that owns it. */
export interface KittyWindow {
	window: number;
	socket: string;
}

/** A herdr pane, the herdr agent name of the omp running in it (spawned members), and the server's socket. */
export interface HerdrPane {
	socket: string;
	/** The pane at join time; herdr gives a pane a new id when it moves to another workspace. */
	pane: string;
	/** The name `herdr agent start` gave it: follows the agent wherever its pane goes. */
	agent?: string;
}

/** One task of a hub's plan, shown on its agents in the swarm view. */
export interface PlanTask {
	id: string;
	title: string;
	/** The member doing it: one of the hub's agents, possibly not spawned yet. */
	agent?: string;
	/** Ids of the tasks it waits for. */
	after?: string[];
	/** Set by the hub; a task is also done once its agent has finished all its steps. */
	done?: boolean;
}

/**
 * One step of a task, as the agent doing it drew the task out (peer_steps). The swarm view draws
 * an agent's steps left to right from its task's box: each from the step it continues (`after`),
 * the first from the task itself.
 */
export interface Step {
	/** Short and unique within the task, e.g. 's1'. */
	id: string;
	title: string;
	done?: boolean;
	/** The id of the step it continues from; unset for the step right after the previous one. */
	after?: string;
	/** The code it stands for, as `path:line` (relative to the agent's directory). */
	code?: string;
}

/** An agent's steps, by the id of the task they expand. */
export type Steps = Record<string, Step[]>;

/** Whether a task is done: the hub marked it so, or its agent expanded it into steps and finished them all. */
export function taskDone(task: PlanTask, steps: Step[] | undefined): boolean {
	return !!task.done || (!!steps && steps.length > 0 && steps.every(step => step.done));
}

/** A hub's request for a new vertex, read by the session the hub launches. */
export interface SpawnRequest {
	id: string;
	phase: string;
	hub: string;
	name: string;
	prompt: string;
	/** Ids of the plan's tasks the new agent owns. */
	tasks: string[];
	createdAt: number;
}

export interface JoinOptions {
	pid?: number;
	hub?: string | null;
	spawn?: string;
	kitty?: KittyWindow;
	herdr?: HerdrPane;
	model?: string;
	plugin?: string;
}

export interface SendOptions {
	/** Id of the message this answers. */
	replyTo?: string;
	/** The user's own words, verified by the sender's extension against its session (see quote.ts). */
	user?: string;
	/** A copy for the record: it joins the recipient's next turn instead of starting or interrupting one. */
	quiet?: boolean;
	/** peer_interrupt: the recipient's work is stopped, running commands too, before this is delivered. */
	interrupt?: boolean;
}

export interface Message {
	id: string;
	phase: string;
	from: string;
	to: string;
	body: string;
	sentAt: number;
	replyTo?: string;
	/** The user's own words, quoted verbatim from the sender's session. */
	user?: string;
	quiet?: boolean;
	interrupt?: boolean;
}

/** How often a member refreshes its peers/ entry. */
export const HEARTBEAT_MS = 5_000;
/**
 * A member on another machine silent for longer than this is offline. On this machine its pid
 * decides instead: after the Mac sleeps every member's heartbeat is late, and that isn't leaving.
 */
export const STALE_MS = 3 * HEARTBEAT_MS;
/** Sender name for mail from the command line rather than a member. */
export const HUMAN = "human";
/** `to` value that sends one copy to every other member. */
export const BROADCAST = "all";
/** A join lock older than this was left by a session that died mid-join (a join takes milliseconds). */
const JOIN_LOCK_STALE_MS = 5_000;

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,47}$/;
// Orders messages one process sends within the same millisecond.
let sendCounter = 0;

/** Raised when a session acts on a phase that `/startswarm` has since replaced. */
export class StalePhaseError extends Error {
	constructor() {
		super("The swarm was restarted with /startswarm; this session is no longer in it.");
	}
}

/** Whether a member's session runs: on this machine its pid decides, elsewhere its last heartbeat. */
export function peerOnline(peer: Peer, now = Date.now()): boolean {
	if (peer.pid === null) return false;
	if (peer.host === os.hostname()) return pidAlive(peer.pid);
	return now - peer.seenAt <= STALE_MS;
}

/** The name of the one swarm older peer-mail kept in <root>/swarm, if it is there. */
function legacyName(root: string): string | undefined {
	const phase = readJson<Phase>(path.join(root, "swarm", "phase.json"));
	if (!phase) return undefined;
	try {
		return normalizeName(phase.label);
	} catch {
		return "swarm";
	}
}

/**
 * Move the one swarm older peer-mail kept in <root>/swarm to swarms/<its name>, once none of its
 * members runs; until then it is used where it is (Swarm's constructor), so its running sessions
 * and newer ones share it. A swarm already under that name is left alone, and so is the old one.
 */
function adoptLegacy(root: string): void {
	const name = legacyName(root);
	if (!name) return;
	const legacy = path.join(root, "swarm");
	const phase = readJson<Phase>(path.join(legacy, "phase.json"));
	const running = listDir(path.join(legacy, "peers"))
		.filter(file => file.endsWith(".json"))
		.map(file => readJson<Peer>(path.join(legacy, "peers", file)))
		.some(peer => peer !== undefined && peer.phase === phase?.id && peerOnline(peer));
	const target = path.join(root, "swarms", name);
	if (running || fs.existsSync(target)) return;
	fs.mkdirSync(path.dirname(target), { recursive: true });
	try {
		fs.renameSync(legacy, target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; // another session moved it
	}
}

export function defaultRoot(): string {
	return process.env.PEER_MAIL_DIR || path.join(os.homedir(), ".omp", "peer-mail");
}

/** A raw name (a swarm, a member) made safe for a directory name, or an error. */
export function normalizeName(raw: string): string {
	const name = raw
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[^a-z0-9]+/, "")
		.slice(0, 48);
	if (!NAME_PATTERN.test(name)) throw new Error(`"${raw}" can't be used as a name`);
	if (name === BROADCAST) throw new Error(`"${BROADCAST}" is reserved for broadcasts`);
	return name;
}

export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: it exists but belongs to another user.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
	fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
	fs.renameSync(temp, file);
}

export function readJson<T>(file: string): T | undefined {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export function listDir(dir: string): string[] {
	try {
		return fs.readdirSync(dir).sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

/** One swarm of the mailbox. Every method that acts for a member checks that its phase is current. */
export class Swarm {
	readonly dir: string;

	/**
	 * The swarm `name` (a normalized label, see Swarm.named) in the mailbox at `root`: swarms/<name>,
	 * or older peer-mail's <root>/swarm while that is where this swarm still lives.
	 */
	constructor(
		readonly root: string,
		readonly name: string,
	) {
		const own = path.join(root, "swarms", name);
		this.dir = !fs.existsSync(own) && legacyName(root) === name ? path.join(root, "swarm") : own;
	}

	/** The swarm a label names: `2.0.0` → swarms/2.0.0. Throws for a label that can't name one. */
	static named(label: string, root: string = defaultRoot()): Swarm {
		return new Swarm(root, normalizeName(label));
	}

	/** Every swarm in the mailbox that has begun, oldest first. */
	static all(root: string = defaultRoot()): Swarm[] {
		adoptLegacy(root);
		const legacy = legacyName(root);
		const names = new Set([...listDir(path.join(root, "swarms")), ...(legacy ? [legacy] : [])]);
		return [...names]
			.map(name => new Swarm(root, name))
			.filter(swarm => swarm.phase() !== undefined)
			.sort((a, b) => (a.phase()?.startedAt ?? 0) - (b.phase()?.startedAt ?? 0));
	}

	/** The swarm whose hub left spawn request `id` (a session peer_spawn launched), if any. */
	static ofSpawn(id: string, root: string = defaultRoot()): Swarm | undefined {
		return Swarm.all(root).find(swarm => fs.existsSync(swarm.path("spawns", `${id}.json`)));
	}

	private path(...parts: string[]): string {
		return path.join(this.dir, ...parts);
	}

	phase(): Phase | undefined {
		return readJson<Phase>(this.path("phase.json"));
	}

	/** Delete this swarm's members and messages and begin a new phase; other swarms are untouched. */
	start(label: string, by: string): Phase {
		fs.rmSync(this.dir, { recursive: true, force: true });
		return this.begin(randomUUID(), label, by);
	}

	/**
	 * Begin phase `id` without deleting anything: /swarm finding no swarm. Given the id of a phase
	 * whose mailbox was lost, it brings that swarm back, so its sessions rejoin it.
	 */
	begin(id: string, label: string, by: string): Phase {
		const phase: Phase = { id, label, startedAt: Date.now(), startedBy: by };
		writeJson(this.path("phase.json"), phase);
		return phase;
	}

	/**
	 * Run `fn` holding the join lock (outside swarms/, so /startswarm can't delete it), so that
	 * sessions running /swarm at once take turns: only one of them can find no lead and become it.
	 */
	exclusive<T>(fn: () => T): T {
		const lock = path.join(this.root, "join.lock");
		fs.mkdirSync(this.root, { recursive: true });
		for (;;) {
			try {
				fs.mkdirSync(lock);
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			const since = fs.statSync(lock, { throwIfNoEntry: false })?.mtimeMs;
			if (since !== undefined && Date.now() - since > JOIN_LOCK_STALE_MS) fs.rmSync(lock, { recursive: true, force: true });
			else Bun.sleepSync(10);
		}
		try {
			return fn();
		} finally {
			fs.rmSync(lock, { recursive: true, force: true });
		}
	}

	private requireCurrent(phase: string): void {
		if (this.phase()?.id !== phase) throw new StalePhaseError();
	}

	peer(name: string): Peer | undefined {
		return readJson<Peer>(this.path("peers", `${name}.json`));
	}

	/** Members of the current phase. */
	peers(): Peer[] {
		const phase = this.phase()?.id;
		return listDir(this.path("peers"))
			.filter(file => file.endsWith(".json"))
			.map(file => readJson<Peer>(this.path("peers", file)))
			.filter((peer): peer is Peer => peer !== undefined && peer.phase === phase);
	}

	isOnline(peer: Peer, now = Date.now()): boolean {
		return peerOnline(peer, now);
	}

	/** The swarm's lead: the running hub that joined first. A /swarm with no place of its own joins it as an agent. */
	lead(): Peer | undefined {
		return this.peers()
			.filter(peer => peer.hub === null && this.isOnline(peer))
			.sort((a, b) => a.joinedAt - b.joinedAt)[0];
	}

	/**
	 * Join `phase` as `desired`, or as `desired-2`, `-3`… when another live member holds it.
	 * A name whose member has left is taken over, along with any mail waiting for it.
	 */
	join(desired: string, phase: string, cwd: string, options: JoinOptions = {}): Peer {
		this.requireCurrent(phase);
		const pid = options.pid ?? process.pid;
		const base = normalizeName(desired);
		for (let n = 1; ; n++) {
			const name = n === 1 ? base : `${base}-${n}`;
			const held = this.peer(name);
			if (held && held.phase === phase && held.pid !== pid && this.isOnline(held)) continue;
			const now = Date.now();
			const peer: Peer = {
				name,
				phase,
				pid,
				host: os.hostname(),
				cwd,
				joinedAt: now,
				seenAt: now,
				hub: options.hub ?? null,
				...(options.spawn ? { spawn: options.spawn } : {}),
				...(options.kitty ? { kitty: options.kitty } : {}),
				...(options.herdr ? { herdr: options.herdr } : {}),
				...(options.model ? { model: options.model } : {}),
				...(options.plugin ? { plugin: options.plugin } : {}),
			};
			writeJson(this.path("peers", `${name}.json`), peer);
			return peer;
		}
	}

	/**
	 * The members `from` may message. A vertex reaches only its hub; a hub reaches its own
	 * vertices and the other hubs. Mail from the command line (`human`) reaches everyone.
	 */
	reachable(from: string): Peer[] {
		const peers = this.peers().filter(peer => peer.name !== from);
		if (from === HUMAN) return peers;
		const sender = this.peer(from);
		if (!sender) return [];
		if (sender.hub !== null) return peers.filter(peer => peer.name === sender.hub);
		return peers.filter(peer => peer.hub === null || peer.hub === sender.name);
	}

	/** Point the vertices of a hub that renamed itself at its new name. */
	reassignHub(from: string, to: string): void {
		for (const peer of this.peers().filter(peer => peer.hub === from)) {
			writeJson(this.path("peers", `${peer.name}.json`), { ...peer, hub: to });
		}
	}

	/** Record a hub's request for a new vertex; the launched session finds it by id. Its brief is kept for the swarm view. */
	requestSpawn(hub: Peer, name: string, prompt: string, tasks: string[]): SpawnRequest {
		this.requireCurrent(hub.phase);
		const request: SpawnRequest = { id: randomUUID(), phase: hub.phase, hub: hub.name, name, prompt, tasks, createdAt: Date.now() };
		writeJson(this.path("spawns", `${request.id}.json`), request);
		writeJson(this.path("briefs", `${request.id}.json`), request);
		return request;
	}

	/** The request a member was spawned for, kept after the spawn took it: the hub's brief and the tasks it gave. */
	brief(spawn: string): SpawnRequest | undefined {
		return readJson<SpawnRequest>(this.path("briefs", `${spawn}.json`));
	}

	/** Take a spawn request (it is used once). Undefined when it is gone, e.g. after /startswarm. */
	takeSpawn(id: string): SpawnRequest | undefined {
		const file = this.path("spawns", `${id}.json`);
		const request = readJson<SpawnRequest>(file);
		fs.rmSync(file, { force: true });
		return request;
	}

	/** The member that joined for spawn request `id`, once it has. */
	spawned(id: string): Peer | undefined {
		return this.peers().find(peer => peer.spawn === id);
	}

	/** Refresh a member's heartbeat, model and activity; false when another session has since taken its name. */
	heartbeat(member: Peer, model?: string, activity?: Activity): boolean {
		this.requireCurrent(member.phase);
		const peer = this.peer(member.name);
		if (!peer || peer.pid !== member.pid || peer.phase !== member.phase) return false;
		writeJson(this.path("peers", `${member.name}.json`), { ...peer, seenAt: Date.now(), ...(model ? { model } : {}), ...(activity ? { activity } : {}) });
		return true;
	}

	/** Mark a member as gone, keeping its entry so mail can still be addressed to it. */
	leave(member: Peer, how: "closed" | "left"): void {
		const peer = this.peer(member.name);
		if (peer && peer.pid === member.pid && peer.phase === member.phase && this.phase()?.id === member.phase) {
			writeJson(this.path("peers", `${member.name}.json`), { ...peer, pid: null, leftAt: Date.now(), leftHow: how });
		}
	}

	/** Record a member's own status and whether its work is finished. */
	setStatus(member: Peer, update: { status?: string; finished?: boolean }): void {
		this.requireCurrent(member.phase);
		const peer = this.peer(member.name);
		if (!peer || peer.pid !== member.pid) return;
		writeJson(this.path("peers", `${member.name}.json`), { ...peer, ...update });
	}

	/** Remove a member's entry entirely (it renamed itself), so no one mails the old name. */
	forget(member: Peer): void {
		const peer = this.peer(member.name);
		if (peer && peer.pid === member.pid && peer.phase === member.phase) {
			fs.rmSync(this.path("peers", `${member.name}.json`), { force: true });
		}
	}

	/**
	 * Post `body` from `from` to `to`: a member, or `all` (every running, unfinished member it can reach).
	 * An offline member keeps its mail until it rejoins. Returns one message per recipient.
	 */
	send(from: string, phase: string, to: string, body: string, options: SendOptions = {}): Message[] {
		this.requireCurrent(phase);
		if (!body.trim()) throw new Error("The message is empty.");
		const reachable = this.reachable(from).map(peer => peer.name);
		let recipients: string[];
		if (to === BROADCAST) {
			recipients = this.reachable(from)
				.filter(peer => this.isOnline(peer) && !peer.finished)
				.map(peer => peer.name);
			if (recipients.length === 0) throw new Error("No member you can message is running and unfinished.");
		} else {
			if (!reachable.includes(to)) {
				const why = this.peer(to)?.phase === phase ? "you can't message it" : "the swarm has no such member";
				throw new Error(`Can't send to "${to}": ${why}. You can message: ${reachable.join(", ") || "nobody yet"}.`);
			}
			recipients = [to];
		}
		const sentAt = Date.now();
		return recipients.map(recipient => {
			// Ids sort in sending order, which is the order they are delivered: time first, then this
			// process's counter for sends within the same millisecond. Short, since agents quote them.
			sendCounter += 1;
			const id = `${sentAt.toString(36).padStart(9, "0")}-${sendCounter.toString(36).padStart(4, "0")}-${randomUUID().slice(0, 4)}`;
			const message: Message = {
				id,
				phase,
				from,
				to: recipient,
				body,
				sentAt,
				...(options.replyTo ? { replyTo: options.replyTo } : {}),
				...(options.user ? { user: options.user } : {}),
				...(options.quiet ? { quiet: true } : {}),
				...(options.interrupt ? { interrupt: true } : {}),
			};
			writeJson(this.path("inbox", recipient, `${id}.json`), message);
			return message;
		});
	}

	/** Take every current-phase message waiting for `member`, oldest first; each goes to one caller only. */
	receive(member: Peer): Message[] {
		this.requireCurrent(member.phase);
		const received: Message[] = [];
		for (const file of listDir(this.path("inbox", member.name)).filter(file => file.endsWith(".json"))) {
			const delivered = this.path("delivered", member.name, file);
			fs.mkdirSync(path.dirname(delivered), { recursive: true });
			try {
				fs.renameSync(this.path("inbox", member.name, file), delivered);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // another poller took it
				throw error;
			}
			const message = readJson<Message>(delivered);
			if (message && message.phase === member.phase) received.push(message);
		}
		return received;
	}

	/** Messages waiting for `name`, without taking them. */
	pending(name: string): number {
		return listDir(this.path("inbox", name)).filter(file => file.endsWith(".json")).length;
	}

	/** The messages waiting for `name`, read without taking them. */
	waiting(name: string): Message[] {
		return listDir(this.path("inbox", name))
			.filter(file => file.endsWith(".json"))
			.map(file => readJson<Message>(this.path("inbox", name, file)))
			.filter((message): message is Message => message !== undefined);
	}

	/** The last `limit` messages `name` has received in this phase. */
	history(name: string, limit = 20): Message[] {
		return listDir(this.path("delivered", name))
			.filter(file => file.endsWith(".json"))
			.slice(-limit)
			.map(file => readJson<Message>(this.path("delivered", name, file)))
			.filter((message): message is Message => message !== undefined);
	}

	/** Move mail still waiting for `from` to `to` (a member that renamed itself). */
	moveInbox(from: string, to: string): void {
		for (const file of listDir(this.path("inbox", from)).filter(file => file.endsWith(".json"))) {
			const message = readJson<Message>(this.path("inbox", from, file));
			if (!message) continue;
			writeJson(this.path("inbox", to, file), { ...message, to });
			fs.rmSync(this.path("inbox", from, file), { force: true });
		}
	}

	/** Replace `hub`'s plan. */
	setPlan(hub: Peer, tasks: PlanTask[]): void {
		this.requireCurrent(hub.phase);
		writeJson(this.path("plans", `${hub.name}.json`), tasks);
	}

	/** The plan of the hub named `name`, empty when it has set none. */
	plan(name: string): PlanTask[] {
		return readJson<PlanTask[]>(this.path("plans", `${name}.json`)) ?? [];
	}

	/** Carry a hub's plan over to its new name. */
	movePlan(from: string, to: string): void {
		const file = this.path("plans", `${from}.json`);
		if (!fs.existsSync(file)) return;
		fs.renameSync(file, this.path("plans", `${to}.json`));
	}

	/** Make `agent` the owner of `hub`'s tasks `ids`. */
	assign(hub: string, ids: string[], agent: string): void {
		const plan = this.plan(hub);
		if (plan.length === 0) return;
		writeJson(this.path("plans", `${hub}.json`), plan.map(task => (ids.includes(task.id) ? { ...task, agent } : task)));
	}

	/** Hand every task of `hub`'s plan owned by `from` to `to` (a vertex that renamed itself). */
	reassign(hub: string, from: string, to: string): void {
		const ids = this.plan(hub).filter(task => task.agent === from).map(task => task.id);
		if (ids.length > 0) this.assign(hub, ids, to);
	}

	/** Replace `member`'s steps for task `task`. */
	setSteps(member: Peer, task: string, steps: Step[]): void {
		this.requireCurrent(member.phase);
		writeJson(this.path("steps", `${member.name}.json`), { ...this.steps(member.name), [task]: steps });
	}

	/** The steps of the member named `name`, by task id. */
	steps(name: string): Steps {
		return readJson<Steps>(this.path("steps", `${name}.json`)) ?? {};
	}

	/** Carry a member's steps over to its new name. */
	moveSteps(from: string, to: string): void {
		const file = this.path("steps", `${from}.json`);
		if (!fs.existsSync(file)) return;
		fs.renameSync(file, this.path("steps", `${to}.json`));
	}
}
