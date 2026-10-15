/**
 * The one shared swarm mailbox. Only sessions that joined the swarm can mail; every other
 * session is isolated.
 *
 *   <root>/swarm/phase.json                   the current phase: its label, who started it, when
 *   <root>/swarm/peers/<name>.json            a member: pid, cwd, phase, hub, last heartbeat
 *   <root>/swarm/inbox/<name>/<id>.json       mail waiting for <name>
 *   <root>/swarm/delivered/<name>/<id>.json   mail <name> has received (its history)
 *   <root>/swarm/spawns/<id>.json             a hub's request for a new vertex, until it starts
 *
 * Members form a graph: hubs (joined by hand) and vertices (spawned by a hub). A vertex can
 * message only its hub; a hub can message its vertices and the other hubs.
 *
 * `/startswarm` begins a new phase: the directory is deleted and recreated, so earlier members
 * and their mail are gone. A session still holding the old phase id is stale: its heartbeat,
 * sends and receives are refused, and anything it manages to write carries the old phase and is
 * ignored by the new one.
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
	/** The model the member's session runs, as `provider/id`, refreshed with each heartbeat. */
	model?: string;
	/** What the member was doing at its last heartbeat. */
	activity?: Activity;
	/** When the member's session ended (it left or exited); unset while it runs or if it crashed. */
	leftAt?: number;
}

/** What a member is doing: thinking, running a tool (the latest one it started), or idle. */
export interface Activity {
	state: "thinking" | "running" | "idle";
	/** The tool it is running, or ran last. */
	tool?: string;
	/** The tool call's stated intent, when it gave one. */
	intent?: string;
	since: number;
}

/** A kitty window, and the remote-control socket of the kitty instance that owns it. */
export interface KittyWindow {
	window: number;
	socket: string;
}

/** A hub's request for a new vertex, read by the session the hub launches. */
export interface SpawnRequest {
	id: string;
	phase: string;
	hub: string;
	name: string;
	prompt: string;
	createdAt: number;
}

export interface JoinOptions {
	pid?: number;
	hub?: string | null;
	spawn?: string;
	kitty?: KittyWindow;
	model?: string;
}

export interface Message {
	id: string;
	phase: string;
	from: string;
	to: string;
	body: string;
	sentAt: number;
	replyTo?: string;
}

/** How often a member refreshes its peers/ entry. */
export const HEARTBEAT_MS = 5_000;
/** A member silent for longer than this is offline, whatever its pid says (crashed, or asleep). */
export const STALE_MS = 3 * HEARTBEAT_MS;
/** Sender name for mail from the command line rather than a member. */
export const HUMAN = "human";
/** `to` value that sends one copy to every other member. */
export const BROADCAST = "all";

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,47}$/;
// Orders messages one process sends within the same millisecond.
let sendCounter = 0;

/** Raised when a session acts on a phase that `/startswarm` has since replaced. */
export class StalePhaseError extends Error {
	constructor() {
		super("The swarm was restarted with /startswarm; this session is no longer in it.");
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

/** The swarm mailbox. Every method that acts for a member checks that its phase is current. */
export class Swarm {
	readonly dir: string;

	constructor(readonly root: string = defaultRoot()) {
		this.dir = path.join(root, "swarm");
	}

	private path(...parts: string[]): string {
		return path.join(this.dir, ...parts);
	}

	phase(): Phase | undefined {
		return readJson<Phase>(this.path("phase.json"));
	}

	/** Delete every member and message and begin a new phase. */
	start(label: string, by: string): Phase {
		fs.rmSync(this.dir, { recursive: true, force: true });
		const phase: Phase = { id: randomUUID(), label, startedAt: Date.now(), startedBy: by };
		writeJson(this.path("phase.json"), phase);
		return phase;
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
		if (peer.pid === null || now - peer.seenAt > STALE_MS) return false;
		return peer.host !== os.hostname() || pidAlive(peer.pid);
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
				...(options.model ? { model: options.model } : {}),
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

	/** Record a hub's request for a new vertex; the launched session finds it by id. */
	requestSpawn(hub: Peer, name: string, prompt: string): SpawnRequest {
		this.requireCurrent(hub.phase);
		const request: SpawnRequest = { id: randomUUID(), phase: hub.phase, hub: hub.name, name, prompt, createdAt: Date.now() };
		writeJson(this.path("spawns", `${request.id}.json`), request);
		return request;
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
	leave(member: Peer): void {
		const peer = this.peer(member.name);
		if (peer && peer.pid === member.pid && peer.phase === member.phase && this.phase()?.id === member.phase) {
			writeJson(this.path("peers", `${member.name}.json`), { ...peer, pid: null, leftAt: Date.now() });
		}
	}

	/** Remove a member's entry entirely (it renamed itself), so no one mails the old name. */
	forget(member: Peer): void {
		const peer = this.peer(member.name);
		if (peer && peer.pid === member.pid && peer.phase === member.phase) {
			fs.rmSync(this.path("peers", `${member.name}.json`), { force: true });
		}
	}

	/**
	 * Post `body` from `from` to `to`: a member, or `all` (every running member it can reach).
	 * An offline member keeps its mail until it rejoins. Returns one message per recipient.
	 */
	send(from: string, phase: string, to: string, body: string, replyTo?: string): Message[] {
		this.requireCurrent(phase);
		if (!body.trim()) throw new Error("The message is empty.");
		const reachable = this.reachable(from).map(peer => peer.name);
		let recipients: string[];
		if (to === BROADCAST) {
			recipients = this.reachable(from)
				.filter(peer => this.isOnline(peer))
				.map(peer => peer.name);
			if (recipients.length === 0) throw new Error("No member you can message is running.");
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
			const message: Message = { id, phase, from, to: recipient, body, sentAt, ...(replyTo ? { replyTo } : {}) };
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
}
