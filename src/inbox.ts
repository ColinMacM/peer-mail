/**
 * One session's membership of a swarm: its name, its heartbeat, and its incoming mail.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { currentHerdrPane } from "./herdr";
import { currentKittyWindow } from "./kitty";
import {
	type Activity,
	type JoinOptions,
	type Message,
	normalizeName,
	type Peer,
	type PlanTask,
	type SendOptions,
	type SpawnRequest,
	Swarm,
} from "./transport";
import { LOADED_VERSION } from "./version";

/** How often a member checks its inbox. */
export const POLL_MS = 1_000;

/**
 * A member's place in the swarm, which its session keeps in its own session file: after the swarm
 * is lost (herdr restarted, sessions relaunched, the mailbox gone), /swarm puts it back there.
 */
export interface Identity {
	phase: string;
	label: string;
	name: string;
	hub: string | null;
	/** A hub's plan, restored if the mailbox lost it. */
	plan?: PlanTask[];
}

/** The swarm a label names, or undefined when it can't name one. */
export function swarmName(label: string): string | undefined {
	try {
		return normalizeName(label);
	} catch {
		return undefined;
	}
}

/**
 * The swarm a /swarm in `cwd` joins: the one `label` names; without one, the swarm this session
 * was in before (`identity`), else the one swarm running (or, with none running, the one there
 * is), else a new one named after the directory. Several to choose from is an error naming them.
 */
export function chooseSwarm(root: string, cwd: string, label: string | undefined, identity: Identity | undefined): Swarm {
	if (label) return Swarm.named(label, root);
	const earlier = identity && swarmName(identity.label);
	if (earlier) return new Swarm(root, earlier);
	const swarms = Swarm.all(root);
	const running = swarms.filter(swarm => swarm.lead());
	const choices = running.length > 0 ? running : swarms;
	if (choices.length === 1) return choices[0];
	if (choices.length === 0) return Swarm.named(path.basename(cwd), root);
	const labels = choices.map(swarm => swarm.phase()?.label ?? swarm.name).join(", ");
	throw new Error(`${running.length > 0 ? "Several swarms are running" : "There are several swarms"}: ${labels}. Join one with /swarm [label].`);
}

export interface AttachOptions {
	/** Where this session was in this swarm before, from its session file. */
	identity?: Identity;
	model?: string;
	/** The label a swarm that hasn't begun gets (default: the directory name). */
	label?: string;
}

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
		return new Membership(swarm, swarm.join(desiredName, phase.id, cwd, { ...place(), model, plugin: LOADED_VERSION }));
	}

	/**
	 * `/swarm`: join `swarm` as it is now. A session that was in this swarm before (`identity`)
	 * rejoins under its name and hub. Any other session joins the swarm's lead as one of its agents,
	 * or becomes the lead when no hub is running. When the swarm hasn't begun, the session's previous
	 * phase of it comes back (so its other sessions rejoin it), else a new one labelled `label` begins.
	 */
	static attach(swarm: Swarm, desiredName: string, cwd: string, { identity, model, label }: AttachOptions = {}): Membership {
		return swarm.exclusive(() => {
			const by = `${identity?.name ?? desiredName} (pid ${process.pid})`;
			const phase = swarm.phase() ?? (identity ? swarm.begin(identity.phase, identity.label, by) : swarm.begin(randomUUID(), label ?? path.basename(cwd), by));
			const placement = { ...place(), model, plugin: LOADED_VERSION };
			const lead = swarm.lead();
			if (identity?.phase !== phase.id) {
				return new Membership(swarm, swarm.join(identity?.name ?? desiredName, phase.id, cwd, { ...placement, hub: lead?.name ?? null }));
			}
			// The entry it left behind going offline follows a hub that has renamed since.
			const left = swarm.peer(identity.name);
			const hub = left?.phase === phase.id && !swarm.isOnline(left) ? left.hub : identity.hub;
			// An agent whose hub is no longer in the swarm goes to the lead instead, if there is one.
			const kept = hub === null || swarm.peer(hub)?.phase === phase.id || !lead ? hub : lead.name;
			const member = new Membership(swarm, swarm.join(identity.name, phase.id, cwd, { ...placement, hub: kept }));
			if (kept === null && identity.plan?.length && swarm.plan(member.name).length === 0) swarm.setPlan(member.peer, identity.plan);
			return member;
		});
	}

	/** A session a hub launched with peer_spawn: join as the vertex its request names. */
	static spawned(swarm: Swarm, request: SpawnRequest, cwd: string, model?: string): Membership {
		const placement = { hub: request.hub, spawn: request.id, ...place(), model, plugin: LOADED_VERSION };
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

	/** What this session keeps in its session file to rejoin the swarm after it is lost. */
	identity(): Identity {
		const hub = this.hub;
		const plan = hub === null ? this.swarm.plan(this.name) : [];
		const label = this.swarm.phase()?.label ?? "";
		return { phase: this.#peer.phase, label, name: this.name, hub, ...(plan.length > 0 ? { plan } : {}) };
	}

	/** The join options that keep this member's place in the graph when it joins again. */
	#placement(): JoinOptions {
		const { kitty, herdr, model, spawn } = this.#peer;
		return { hub: this.hub, kitty, herdr, model, plugin: LOADED_VERSION, ...(spawn ? { spawn } : {}) };
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

	/** Switch to `desiredName`, bringing along mail that was still waiting, vertices, the plan, its tasks and steps. Returns the name taken. */
	rename(desiredName: string): string {
		const previous = this.#peer;
		this.#peer = this.swarm.join(desiredName, previous.phase, previous.cwd, this.#placement());
		if (this.name !== previous.name) {
			this.swarm.moveInbox(previous.name, this.name);
			this.swarm.forget(previous);
			this.swarm.reassignHub(previous.name, this.name);
			this.swarm.movePlan(previous.name, this.name);
			this.swarm.moveSteps(previous.name, this.name);
			// The tasks this member owns, in its hub's plan (or its own, for a hub that kept some).
			this.swarm.reassign(this.hub ?? this.name, previous.name, this.name);
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

/** Where this session runs: its kitty window and its herdr pane, whichever it has. */
function place(): Pick<JoinOptions, "kitty" | "herdr"> {
	return { kitty: currentKittyWindow(), herdr: currentHerdrPane() };
}

/**
 * How a received message reads in the recipient's conversation: one JSON header line, then the
 * body. The briefing a member gets on joining explains the header once, so each message is short.
 */
export function formatForAgent(message: Message): string {
	const header = {
		from: message.from,
		id: message.id,
		...(message.replyTo ? { re: message.replyTo } : {}),
		...(message.user ? { user: message.user } : {}),
		...(message.interrupt ? { interrupt: true } : {}),
	};
	return `${JSON.stringify(header)}\n${message.body}`;
}
