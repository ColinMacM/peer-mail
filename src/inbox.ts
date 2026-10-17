/**
 * One session's membership of a swarm: its name, its heartbeat, and its incoming mail.
 */
import { currentKittyWindow } from "./kitty";
import { type Activity, type JoinOptions, type Message, type Peer, type SendOptions, type SpawnRequest, Swarm } from "./transport";
import { LOADED_VERSION } from "./version";

/** How often a member checks its inbox. */
export const POLL_MS = 1_000;

export class Membership {
	#peer: Peer;

	private constructor(
		readonly swarm: Swarm,
		peer: Peer,
	) {
		this.#peer = peer;
	}

	/** `/startswarm`: delete the swarm's members and mail, begin a new phase labelled `label`, and join it. */
	static start(swarm: Swarm, label: string, desiredName: string, cwd: string, model?: string): Membership {
		const phase = swarm.start(label, `${desiredName} (pid ${process.pid})`);
		return new Membership(swarm, swarm.join(desiredName, phase.id, cwd, { kitty: currentKittyWindow(), model, plugin: LOADED_VERSION }));
	}

	/** `/swarm`: join the swarm as it is now. Fails when no swarm has been started. */
	static attach(swarm: Swarm, desiredName: string, cwd: string, model?: string): Membership {
		const phase = swarm.phase();
		if (!phase) throw new Error("No swarm is running. Start one with /startswarm.");
		return new Membership(swarm, swarm.join(desiredName, phase.id, cwd, { kitty: currentKittyWindow(), model, plugin: LOADED_VERSION }));
	}

	/** A session a hub launched with peer_spawn: join as the vertex its request names. */
	static spawned(swarm: Swarm, request: SpawnRequest, cwd: string, model?: string): Membership {
		const placement = { hub: request.hub, spawn: request.id, kitty: currentKittyWindow(), model, plugin: LOADED_VERSION };
		return new Membership(swarm, swarm.join(request.name, request.phase, cwd, placement));
	}

	get name(): string {
		return this.#peer.name;
	}

	get peer(): Peer {
		return this.#peer;
	}

	/** The hub this member reports to, or null when it is a hub itself. Read fresh: hubs can rename. */
	get hub(): string | null {
		const current = this.swarm.peer(this.name);
		return current && current.pid === this.#peer.pid ? current.hub : this.#peer.hub;
	}

	/** The join options that keep this member's place in the graph when it joins again. */
	#placement(): JoinOptions {
		const { kitty, model, spawn } = this.#peer;
		return { hub: this.hub, kitty, model, plugin: LOADED_VERSION, ...(spawn ? { spawn } : {}) };
	}

	/**
	 * Keep the name alive, recording the model and activity of the session now. When another
	 * session has taken the name over (this one's entry was lost or rewritten), join again, possibly under a
	 * suffixed name; returns that name if it changed. Throws StalePhaseError once the swarm has
	 * been restarted.
	 */
	heartbeat(model?: string, activity?: Activity): string | undefined {
		if (model) this.#peer = { ...this.#peer, model };
		if (this.swarm.heartbeat(this.#peer, model, activity)) return undefined;
		this.#peer = this.swarm.join(this.name, this.#peer.phase, this.#peer.cwd, this.#placement());
		return this.name;
	}

	/** Switch to `desiredName`, bringing along mail that was still waiting and any vertices. Returns the name taken. */
	rename(desiredName: string): string {
		const previous = this.#peer;
		this.#peer = this.swarm.join(desiredName, previous.phase, previous.cwd, this.#placement());
		if (this.name !== previous.name) {
			this.swarm.moveInbox(previous.name, this.name);
			this.swarm.forget(previous);
			this.swarm.reassignHub(previous.name, this.name);
		}
		return this.name;
	}

	/** Take waiting mail. Mail means more work, so a member that had finished no longer is. */
	receive(): Message[] {
		const messages = this.swarm.receive(this.#peer);
		if (messages.length > 0 && this.swarm.peer(this.name)?.finished) this.swarm.setStatus(this.#peer, { finished: false });
		return messages;
	}

	send(to: string, body: string, options?: SendOptions): Message[] {
		return this.swarm.send(this.name, this.#peer.phase, to, body, options);
	}

	setStatus(update: { status?: string; finished?: boolean }): void {
		this.swarm.setStatus(this.#peer, update);
	}

	leave(how: "closed" | "left"): void {
		this.swarm.leave(this.#peer, how);
	}
}

/**
 * How a received message reads in the recipient's conversation: one JSON header line, then the
 * body. The briefing a member gets on joining explains the header once, so each message is short.
 */
export function formatForAgent(message: Message): string {
	const header = { from: message.from, id: message.id, ...(message.replyTo ? { re: message.replyTo } : {}), ...(message.user ? { user: message.user } : {}) };
	return `${JSON.stringify(header)}\n${message.body}`;
}
