/**
 * The shared mail directory every omp session on this machine reads and writes.
 *
 *   <root>/peers/<name>.json             a session that has joined: pid, cwd, last heartbeat
 *   <root>/inbox/<name>/<id>.json        mail waiting for <name>
 *   <root>/delivered/<name>/<id>.json    mail <name> has received (its history)
 *
 * Files are written to a temp name and renamed into place, so a reader never sees half a
 * message. A session receives a message by renaming it from inbox/ to delivered/: rename is
 * atomic, so exactly one session gets each message even if two poll at once.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Peer {
	name: string;
	/** null once the session has left (its name and mail stay for when it returns). */
	pid: number | null;
	host: string;
	cwd: string;
	joinedAt: number;
	seenAt: number;
}

export interface Message {
	id: string;
	from: string;
	to: string;
	body: string;
	sentAt: number;
	replyTo?: string;
}

/** How often a joined session refreshes its peers/ entry. */
export const HEARTBEAT_MS = 5_000;
/** A peer silent for longer than this is offline, whatever its pid says (crashed, or asleep). */
export const STALE_MS = 3 * HEARTBEAT_MS;
/** Name for mail sent from the command line rather than a session. */
export const HUMAN = "human";
/** `to` value that sends one copy to every other known peer. */
export const BROADCAST = "all";

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,47}$/;

export function defaultRoot(): string {
	return process.env.PEER_MAIL_DIR || path.join(os.homedir(), ".omp", "peer-mail");
}

/** A raw name (a directory name, a user's choice) made safe as a peer name, or an error. */
export function normalizeName(raw: string): string {
	const name = raw
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[^a-z0-9]+/, "")
		.slice(0, 48);
	if (!NAME_PATTERN.test(name)) throw new Error(`"${raw}" can't be made into a peer name`);
	if (name === BROADCAST) throw new Error(`"${BROADCAST}" is reserved for broadcasts`);
	return name;
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: it exists but belongs to another user.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export class Transport {
	constructor(readonly root: string = defaultRoot()) {}

	private path(...parts: string[]): string {
		return path.join(this.root, ...parts);
	}

	private writeJson(file: string, value: unknown): void {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
		fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
		fs.renameSync(temp, file);
	}

	private readJson<T>(file: string): T | undefined {
		try {
			return JSON.parse(fs.readFileSync(file, "utf8")) as T;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	private listJson(dir: string): string[] {
		try {
			return fs
				.readdirSync(dir)
				.filter(file => file.endsWith(".json"))
				.sort();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	}

	peer(name: string): Peer | undefined {
		return this.readJson<Peer>(this.path("peers", `${name}.json`));
	}

	/** Every peer that has ever joined, by name. */
	peers(): Peer[] {
		return this.listJson(this.path("peers"))
			.map(file => this.readJson<Peer>(this.path("peers", file)))
			.filter((peer): peer is Peer => peer !== undefined);
	}

	isOnline(peer: Peer, now = Date.now()): boolean {
		if (peer.pid === null || now - peer.seenAt > STALE_MS) return false;
		return peer.host !== os.hostname() || pidAlive(peer.pid);
	}

	/**
	 * Join as `desired`, or as `desired-2`, `-3`… when another live session holds it.
	 * A name whose session has left is taken over, along with any mail waiting for it.
	 */
	join(desired: string, cwd: string, pid = process.pid): Peer {
		const base = normalizeName(desired);
		for (let n = 1; ; n++) {
			const name = n === 1 ? base : `${base}-${n}`;
			const held = this.peer(name);
			if (held && held.pid !== pid && this.isOnline(held)) continue;
			const now = Date.now();
			const peer: Peer = { name, pid, host: os.hostname(), cwd, joinedAt: now, seenAt: now };
			this.writeJson(this.path("peers", `${name}.json`), peer);
			return peer;
		}
	}

	/** Refresh `name`'s heartbeat; false when another session has since taken the name. */
	heartbeat(name: string, pid = process.pid): boolean {
		const peer = this.peer(name);
		if (!peer || peer.pid !== pid) return false;
		this.writeJson(this.path("peers", `${name}.json`), { ...peer, seenAt: Date.now() });
		return true;
	}

	/** Mark `name` as gone, keeping its entry so mail can still be addressed to it. */
	leave(name: string, pid = process.pid): void {
		const peer = this.peer(name);
		if (peer && peer.pid === pid) this.writeJson(this.path("peers", `${name}.json`), { ...peer, pid: null });
	}

	/**
	 * Post `body` to `to`, a known peer or `all` (every known peer except the sender).
	 * Offline peers keep their mail until they rejoin. Returns one message per recipient.
	 */
	send(from: string, to: string, body: string, replyTo?: string): Message[] {
		if (!body.trim()) throw new Error("The message is empty.");
		const known = this.peers().map(peer => peer.name);
		let recipients: string[];
		if (to === BROADCAST) {
			recipients = known.filter(name => name !== from);
			if (recipients.length === 0) throw new Error("No other peers have joined yet.");
		} else {
			if (!known.includes(to)) {
				throw new Error(`No peer is called "${to}". Known peers: ${known.join(", ") || "none"}.`);
			}
			recipients = [to];
		}
		const sentAt = Date.now();
		return recipients.map(recipient => {
			// Time-first ids sort in sending order, which is the order they are delivered.
			const id = `${sentAt.toString().padStart(13, "0")}-${randomUUID().slice(0, 8)}`;
			const message: Message = { id, from, to: recipient, body, sentAt, ...(replyTo ? { replyTo } : {}) };
			this.writeJson(this.path("inbox", recipient, `${id}.json`), message);
			return message;
		});
	}

	/** Take every message waiting for `name`, oldest first. Each is returned to one caller only. */
	receive(name: string): Message[] {
		const received: Message[] = [];
		for (const file of this.listJson(this.path("inbox", name))) {
			const delivered = this.path("delivered", name, file);
			fs.mkdirSync(path.dirname(delivered), { recursive: true });
			try {
				fs.renameSync(this.path("inbox", name, file), delivered);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // another poller took it
				throw error;
			}
			const message = this.readJson<Message>(delivered);
			if (message) received.push(message);
		}
		return received;
	}

	/** Messages waiting for `name`, without taking them. */
	pending(name: string): number {
		return this.listJson(this.path("inbox", name)).length;
	}

	/** The last `limit` messages `name` has received. */
	history(name: string, limit = 20): Message[] {
		return this.listJson(this.path("delivered", name))
			.slice(-limit)
			.map(file => this.readJson<Message>(this.path("delivered", name, file)))
			.filter((message): message is Message => message !== undefined);
	}

	/** Move mail still waiting for `from` to `to` (a session that renamed itself). */
	moveInbox(from: string, to: string): void {
		for (const file of this.listJson(this.path("inbox", from))) {
			const message = this.readJson<Message>(this.path("inbox", from, file));
			if (!message) continue;
			this.writeJson(this.path("inbox", to, file), { ...message, to });
			fs.rmSync(this.path("inbox", from, file), { force: true });
		}
	}
}
