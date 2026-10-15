/**
 * peer-mail: omp sessions message each other through one shared swarm mailbox.
 *
 *   /startswarm [label] <prompt>   start the swarm afresh (earlier members and mail are deleted), join it, run <prompt>
 *   /swarm <prompt>                join the swarm that is running, run <prompt>
 *   /swarm                         show the swarm and its members
 *   /swarm-leave                   leave the swarm; the session is isolated again
 *   /peer-name [name]              show or change this session's name in the swarm
 *
 * `[label]` says what the run is for (default: the session's directory name). A session that
 * hasn't joined is isolated: it has no peer tools and no one can mail it.
 *
 * The swarm is a graph. Sessions joined by hand (/startswarm, /swarm) are hubs; a hub's
 * `peer_spawn` opens a kitty split running a new omp session that joins as one of its vertices.
 * A vertex can message only its hub; a hub can message its vertices and the other hubs. Members
 * get `peer_list`, `peer_send` and `peer_rename` (hubs also `peer_spawn`). Mail interrupts its
 * recipient: a working agent's turn is aborted (with its running commands and eval), then the
 * mail starts a new turn. Roles come from the prompt, and an agent can rename itself after its role.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { DEFAULT_GRAPH_PORT, graphRunning } from "./graph";
import { formatForAgent, Membership, POLL_MS } from "./inbox";
import { openSplit, type SplitDirection, splitUnavailable } from "./kitty";
import { BROADCAST, HEARTBEAT_MS, type Message, StalePhaseError, Swarm } from "./transport";

// Every member gets these; only hubs also get peer_spawn.
const MEMBER_TOOLS = ["peer_list", "peer_send", "peer_rename"];
const ALL_TOOLS = [...MEMBER_TOOLS, "peer_spawn"];
const ISOLATED = "This session is isolated: it hasn't joined the swarm (/swarm or /startswarm).";
const DEFAULT_NAME = "agent";
/** How long peer_spawn waits for the new session to join before reporting it as still starting. */
const SPAWN_JOIN_TIMEOUT_MS = 45_000;

// Subagent sessions rebind this factory but share the module, so they act as their main session.
let membership: Membership | undefined;
let poller: { ctx: ExtensionContext; timer: Timer } | undefined;
// A spawned session's request is taken once per process, on its first session start.
let spawnHandled = false;

/** `[label] rest` → label and rest; without brackets the whole text is the prompt. */
function parseStartArgs(args: string): { label?: string; prompt: string } {
	const match = /^\s*\[([^\]]*)\]\s*([\s\S]*)$/.exec(args);
	return match ? { label: match[1].trim(), prompt: match[2].trim() } : { prompt: args.trim() };
}

export default function peerMail(pi: ExtensionAPI) {
	const z = pi.zod;
	const swarm = new Swarm();

	/** Activate the peer tools this member's place allows (none when isolated). */
	async function setTools(member: Membership | undefined) {
		const others = pi.getActiveTools().filter(name => !ALL_TOOLS.includes(name));
		const mine = !member ? [] : member.hub === null ? ALL_TOOLS : MEMBER_TOOLS;
		await pi.setActiveTools([...others, ...mine]);
	}

	function showStatus(ctx: ExtensionContext) {
		ctx.ui.setStatus("peer-mail", membership ? `✉ ${swarm.phase()?.label ?? "swarm"}/${membership.name}` : undefined);
	}

	function stopPolling() {
		if (poller) poller.ctx.clearTimer(poller.timer);
		poller = undefined;
	}

	/** Drop out of the swarm (left, restarted elsewhere, or session ending) and go back to isolated. */
	async function isolate(ctx: ExtensionContext) {
		stopPolling();
		membership = undefined;
		showStatus(ctx);
		await setTools(undefined);
	}

	/**
	 * Hand received mail to the agent and start a turn on it. `interrupted` says its previous work
	 * was just aborted. Background jobs can't be cancelled from an extension, so any still
	 * running are listed for the agent to kill first.
	 */
	function deliver(ctx: ExtensionContext, messages: Message[], interrupted: boolean) {
		const notes: string[] = [];
		if (interrupted) {
			notes.push(
				"Your previous work was stopped (the running turn, its commands and eval) by this mail. " +
					"Don't go back to it unless this mail or the user asks you to.",
			);
		}
		const jobs = ctx.getAsyncJobSnapshot()?.running ?? [];
		if (jobs.length > 0) {
			const list = jobs.map(job => `${job.id} (${job.label})`).join(", ");
			notes.push(`Background jobs are still running: ${list}. Before anything else, stop each one with write proc://<id>/kill.`);
		}
		const content = [...messages.map(formatForAgent), ...notes].join("\n\n---\n\n");
		pi.sendMessage(
			{ customType: "peer-mail", content, display: true, details: messages, attribution: "agent" },
			{ triggerTurn: true },
		);
	}

	function startPolling(ctx: ExtensionContext, member: Membership) {
		stopPolling();
		const beatEvery = Math.round(HEARTBEAT_MS / POLL_MS);
		let tick = 0;
		// Mail held while an interrupted turn unwinds; delivered once the session is idle.
		const held: Message[] = [];
		let interrupting = false;
		const timer = ctx.setInterval(() => {
			try {
				if (++tick % beatEvery === 0) {
					const renamed = member.heartbeat();
					if (renamed) {
						showStatus(ctx);
						ctx.ui.notify(`peer-mail: your name was taken while this session was away; you are now ${renamed}`, "warning");
					}
				}
				held.push(...member.receive());
				if (held.length === 0) return;
				if (ctx.isIdle()) {
					deliver(ctx, held.splice(0), interrupting);
					interrupting = false;
				} else if (!interrupting) {
					// New mail stops the agent outright: the turn, its tool calls, bash and eval.
					interrupting = true;
					ctx.ui.notify(`peer-mail: mail from ${held.map(message => message.from).join(", ")}; stopping current work`, "info");
					ctx.abort();
				}
			} catch (error) {
				if (!(error instanceof StalePhaseError)) throw error;
				void isolate(ctx);
				ctx.ui.notify(`peer-mail: ${error.message} Run /swarm to join the new one.`, "warning");
				pi.sendMessage(
					{ customType: "peer-mail", content: `${error.message} Don't use the peer tools.`, display: true, attribution: "agent" },
					{ deliverAs: "nextTurn" },
				);
			}
		}, POLL_MS);
		poller = { ctx, timer };
	}

	async function join(ctx: ExtensionCommandContext, prompt: string, label: string | undefined) {
		if (ctx.agent.kind !== "main") return;
		try {
			if (membership) {
				membership.leave();
				await isolate(ctx);
			}
			const desired = process.env.PEER_MAIL_NAME || DEFAULT_NAME;
			const member =
				label === undefined
					? Membership.attach(swarm, desired, ctx.cwd)
					: Membership.start(swarm, label, desired, ctx.cwd);
			membership = member;
			await setTools(member);
			startPolling(ctx, member);
			showStatus(ctx);

			const runLabel = swarm.phase()?.label ?? "swarm";
			const others = swarm.reachable(member.name).map(peer => peer.name);
			const verb = label === undefined ? "joined" : "started";
			ctx.ui.notify(`peer-mail: ${verb} swarm ${runLabel} as ${member.name}`, "info");
			pi.sendMessage(
				{
					customType: "peer-mail",
					content:
						`You ${verb} the swarm "${runLabel}" as "${member.name}", a hub. Members you can message: ${others.join(", ") || "none yet"}. ` +
						"If your task gives you a role, first rename yourself after it with peer_rename (for example 'reviewer') so the others can address you. " +
						"Use peer_spawn to start another agent in a new terminal split: it works on the prompt you give it and can only message you. " +
						"Use peer_list to see who you can reach and peer_send to message them; their messages arrive in this conversation. " +
						"Sessions outside the swarm can't reach you, and you can't reach them.",
					display: true,
					attribution: "agent",
				},
				{ deliverAs: "nextTurn" },
			);
			if (prompt) pi.sendUserMessage(prompt);
		} catch (error) {
			ctx.ui.notify(`peer-mail: ${(error as Error).message}`, "error");
		}
	}

	/** A session peer_spawn launched (PEER_MAIL_SPAWN is set): join as that vertex and start on its prompt. */
	pi.on("session_start", async (_event, ctx) => {
		const id = process.env.PEER_MAIL_SPAWN;
		if (!id || spawnHandled || ctx.agent.kind !== "main" || (ctx.mode !== "tui" && ctx.mode !== "rpc")) return;
		spawnHandled = true;
		try {
			const request = swarm.takeSpawn(id);
			if (!request || request.phase !== swarm.phase()?.id) {
				ctx.ui.notify("peer-mail: the swarm this session was started for has been restarted; staying isolated.", "warning");
				return;
			}
			const member = Membership.spawned(swarm, request, ctx.cwd);
			membership = member;
			await setTools(member);
			startPolling(ctx, member);
			showStatus(ctx);
			pi.sendMessage(
				{
					customType: "peer-mail",
					content:
						`You were started by "${request.hub}" in the swarm "${swarm.phase()?.label ?? "swarm"}" as "${member.name}". ` +
						`You can only message ${request.hub}, with peer_send; its messages arrive in this conversation. ` +
						`When you finish, or need something, tell ${request.hub}: it is waiting on you.`,
					display: true,
					attribution: "agent",
				},
				{ deliverAs: "nextTurn" },
			);
			pi.sendUserMessage(request.prompt);
		} catch (error) {
			ctx.ui.notify(`peer-mail: couldn't join as a spawned agent: ${(error as Error).message}`, "error");
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.agent.kind !== "main" || !membership) return;
		membership.leave();
		stopPolling();
		membership = undefined;
	});

	pi.registerTool({
		name: "peer_list",
		label: "Peer list",
		description:
			"List the swarm members you can message with peer_send (a spawned agent reaches only its hub; a hub reaches its own agents and other hubs): " +
			"their name, whether they are running now, their hub, and their working directory. Also says your own name and hub.",
		parameters: z.object({}),
		approval: "read",
		defaultInactive: true,
		async execute() {
			if (!membership) throw new Error(ISOLATED);
			const you = membership.name;
			const peers = swarm
				.reachable(you)
				.map(peer => ({ name: peer.name, online: swarm.isOnline(peer), hub: peer.hub, cwd: peer.cwd }));
			const details = { swarm: swarm.phase()?.label, you, hub: membership.hub, peers };
			return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
		},
	});

	pi.registerTool({
		name: "peer_send",
		label: "Peer send",
		description:
			`Send a message to a swarm member by name (see peer_list), or to '${BROADCAST}'. It interrupts that member: whatever it is doing is stopped and it handles your message next. ` +
			"A member that isn't running gets it when it rejoins. Write a self-contained request: the other agent can't see your conversation. " +
			"Don't send acknowledgements or thanks.",
		parameters: z.object({
			to: z.string().describe(`Member name from peer_list, or '${BROADCAST}' for every member.`),
			message: z.string().describe("The message, written for an agent that can't see your conversation."),
			reply_to: z.string().optional().describe("Id of the message you are answering."),
		}),
		approval: "write",
		defaultInactive: true,
		// The published typings don't infer zod schemas into `params`; this matches the schema above.
		async execute(_toolCallId, params: { to: string; message: string; reply_to?: string }) {
			if (!membership) throw new Error(ISOLATED);
			const sent = membership.send(params.to, params.message, params.reply_to);
			const recipients = sent.map(message => message.to);
			const ids = sent.map(message => message.id);
			return {
				content: [{ type: "text", text: `Sent to ${recipients.join(", ")} (id ${ids.join(", ")}).` }],
				details: { recipients, ids },
			};
		},
	});

	pi.registerTool({
		name: "peer_rename",
		label: "Peer rename",
		description:
			"Change your name in the swarm to whatever is most convenient for the others to address you by, usually your role (for example 'reviewer' or 'programmer'). " +
			"Mail still waiting under your old name comes along. If the name is taken by a running member you get a numbered variant; the result says which.",
		parameters: z.object({
			name: z.string().describe("Lowercase letters, digits, '.', '_' or '-'; other characters become '-'."),
		}),
		approval: "write",
		defaultInactive: true,
		async execute(_toolCallId, params: { name: string }, _signal, _onUpdate, ctx) {
			if (!membership) throw new Error(ISOLATED);
			const previous = membership.name;
			const name = membership.rename(params.name);
			showStatus(ctx);
			return { content: [{ type: "text", text: `You are now "${name}" (was "${previous}").` }], details: { name, previous } };
		},
	});

	pi.registerTool({
		name: "peer_spawn",
		label: "Peer spawn",
		description:
			"Start another agent: a new omp session in a kitty split beside this one, working on `prompt`. It joins the swarm as one of your vertices: " +
			"it can only message you (with peer_send), and its messages arrive in your conversation. Give it a role name and a self-contained prompt " +
			"(it can't see your conversation), including what to report back to you and when. Only hubs can spawn. The user is asked to approve every spawn; " +
			"if they decline, don't retry the same spawn. Waits until the agent has joined.",
		parameters: z.object({
			name: z.string().describe("Its name in the swarm, usually its role, e.g. 'reviewer'."),
			prompt: z.string().describe("Its task, written for an agent that can't see your conversation."),
			split: z.enum(["auto", "vertical", "horizontal"]).optional().describe("How to split this window (default auto)."),
		}),
		// The tool asks the user itself (below), showing the name and prompt, so the generic approval gate doesn't ask twice.
		approval: { tier: "exec", policy: "allow" },
		defaultInactive: true,
		async execute(
			_toolCallId,
			params: { name: string; prompt: string; split?: SplitDirection },
			signal,
			_onUpdate,
			ctx,
		) {
			if (!membership) throw new Error(ISOLATED);
			const hub = membership.hub;
			if (hub !== null) throw new Error(`Only hubs can spawn agents; you are an agent of ${hub}.`);
			const unavailable = splitUnavailable();
			if (unavailable) throw new Error(unavailable);
			// A spawn always needs the user's say-so, whatever the approval mode; with no one to ask, it's refused.
			if (!ctx.hasUI) throw new Error("Spawning an agent needs the user's permission, and this session has no one to ask.");
			const approved = await ctx.ui.confirm(
				`Start a new agent "${params.name}"?`,
				`${membership.name} wants to open a kitty split running omp in ${ctx.cwd}, with this task:\n\n${params.prompt}`,
			);
			if (!approved) throw new Error(`The user declined to start "${params.name}".`);
			const request = swarm.requestSpawn(membership.peer, params.name, params.prompt);
			const env: Record<string, string> = { PEER_MAIL_SPAWN: request.id, PATH: process.env.PATH ?? "" };
			if (process.env.PEER_MAIL_DIR) env.PEER_MAIL_DIR = process.env.PEER_MAIL_DIR;
			const window = await openSplit({
				command: [Bun.which("omp") ?? "omp"],
				cwd: ctx.cwd,
				title: `omp · ${params.name}`,
				env,
				direction: params.split ?? "auto",
			});
			const deadline = Date.now() + SPAWN_JOIN_TIMEOUT_MS;
			while (Date.now() < deadline && !signal?.aborted) {
				const joined = swarm.spawned(request.id);
				if (joined) {
					const text = `Started "${joined.name}" in kitty window ${window}. It is working on your prompt and will message you.`;
					return { content: [{ type: "text", text }], details: { name: joined.name, window } };
				}
				await Bun.sleep(500);
			}
			const text = `Opened kitty window ${window}, but the agent hasn't joined the swarm yet; check it with peer_list shortly.`;
			return { content: [{ type: "text", text }], details: { name: params.name, window } };
		},
	});

	pi.registerCommand("startswarm", {
		description: "Start the swarm afresh (old members and mail are deleted) and join it: /startswarm [label] <prompt>",
		handler: async (args, ctx) => {
			const { label, prompt } = parseStartArgs(args);
			await join(ctx, prompt, label || path.basename(ctx.cwd));
		},
	});

	pi.registerCommand("swarm", {
		description: "Join the running swarm and run <prompt>: /swarm <prompt>. Already in it: show the swarm, or run <prompt>.",
		handler: async (args, ctx) => {
			const prompt = args.trim();
			if (!membership) return join(ctx, prompt, undefined);
			if (prompt) {
				pi.sendUserMessage(prompt);
				return;
			}
			const members = swarm.peers().map(peer => `${peer.name}${swarm.isOnline(peer) ? "" : " (offline)"}`);
			ctx.ui.notify(`peer-mail: swarm ${swarm.phase()?.label}, you are ${membership.name}. Members: ${members.join(", ")}`, "info");
		},
	});

	pi.registerCommand("swarm-graph", {
		description: "Open the swarm's graph view in the browser; click a member to bring its omp window to the front",
		handler: async (_args, ctx) => {
			const url = `http://127.0.0.1:${DEFAULT_GRAPH_PORT}/`;
			if (!(await graphRunning())) {
				// Its own process, so the view outlives this session; it stops a minute after its page closes.
				const cli = new URL("./cli.ts", import.meta.url).pathname;
				spawn(Bun.which("bun") ?? process.execPath, [cli, "graph"], { detached: true, stdio: "ignore" }).unref();
				const deadline = Date.now() + 5_000;
				while (!(await graphRunning()) && Date.now() < deadline) await Bun.sleep(150);
				if (!(await graphRunning())) {
					ctx.ui.notify(`peer-mail: the graph view didn't start (is port ${DEFAULT_GRAPH_PORT} taken?)`, "error");
					return;
				}
			}
			Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", url], { stdout: "ignore", stderr: "ignore" });
			ctx.ui.notify(`peer-mail: graph view at ${url}`, "info");
		},
	});

	pi.registerCommand("swarm-leave", {
		description: "Leave the swarm; this session becomes isolated again",
		handler: async (_args, ctx) => {
			if (!membership) {
				ctx.ui.notify(`peer-mail: ${ISOLATED}`, "info");
				return;
			}
			membership.leave();
			await isolate(ctx);
			ctx.ui.notify("peer-mail: left the swarm; this session is isolated", "info");
		},
	});

	pi.registerCommand("peer-name", {
		description: "Show or change this session's name in the swarm: /peer-name [name]",
		handler: async (args, ctx) => {
			if (!membership) {
				ctx.ui.notify(`peer-mail: ${ISOLATED}`, "warning");
				return;
			}
			try {
				const wanted = args.trim();
				const name = wanted ? membership.rename(wanted) : membership.name;
				showStatus(ctx);
				ctx.ui.notify(`peer-mail: you are ${name}`, "info");
			} catch (error) {
				ctx.ui.notify(`peer-mail: ${(error as Error).message}`, "error");
			}
		},
	});
}
