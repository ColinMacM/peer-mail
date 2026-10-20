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
 * get `peer_list`, `peer_send` and `peer_rename`; hubs also `peer_spawn` and `peer_models`;
 * vertices also `peer_run`, the machine-wide queue for heavy runs. A vertex is locked down: its
 * bash and queued runs execute in a sandbox (sandbox.ts), it has no eval or long-lived services,
 * and its other tools can't touch the peer-mail directory. Mail never interrupts a hub: it arrives
 * between steps. Mail to a vertex stops its thinking, but tools in flight (commands, questions,
 * queued runs) finish first; background jobs are never touched. Roles come from the prompt, and an
 * agent can rename itself.
 */
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { isToolCallEventType } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { DEFAULT_GRAPH_PORT, graphRunning } from "./graph";
import { formatForAgent, Membership, POLL_MS } from "./inbox";
import { openSplit, type SplitDirection, splitUnavailable } from "./kitty";
import {
	autoChoice,
	CHORE_ROLES,
	describeSubscription,
	load,
	type ModelChoice,
	type ModelOptions,
	modelOptions,
	NEARLY_FULL,
	NO_SUBAGENTS,
	requestedChoice,
} from "./models";
import { RunQueue, type RunTicket, runsElsewhere } from "./queue";
import { userSaid, verifiedQuote } from "./quote";
import { realPath, SANDBOX_DIR, SANDBOXED, sandboxedCommand, sandboxProfile, sandboxScript, sandboxUnavailable } from "./sandbox";
import { type Activity, BROADCAST, HEARTBEAT_MS, type Message, StalePhaseError, Swarm } from "./transport";
import { codeVersion } from "./version";

// Every member gets these; hubs and vertices each add their own.
const MEMBER_TOOLS = ["peer_list", "peer_send", "peer_rename", "peer_status"];
const HUB_TOOLS = [...MEMBER_TOOLS, "peer_spawn", "peer_models"];
const VERTEX_TOOLS = [...MEMBER_TOOLS, "peer_run"];
const ALL_TOOLS = [...HUB_TOOLS, "peer_run"];
const ISOLATED = "This session is isolated: it hasn't joined the swarm (/swarm or /startswarm).";
const DEFAULT_NAME = "agent";
/** How long peer_spawn waits for the new session to join before reporting it as still starting. */
const SPAWN_JOIN_TIMEOUT_MS = 45_000;
const RUN_TIMEOUT_DEFAULT_S = 600;
const RUN_TIMEOUT_MAX_S = 3600;

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

/** `running bash: Run tests 3m`, or `idle 40s, last ran bash: Run tests` (`age` is how long it has been so). */
function describeActivity(activity: Activity, age?: string): string {
	const tool = activity.tool ? `${activity.tool}${activity.intent ? `: ${activity.intent}` : ""}` : "";
	const since = age ? ` ${age}` : "";
	const jobs = activity.jobs ? `; ${activity.jobs} background job${activity.jobs === 1 ? "" : "s"}` : "";
	if (activity.state === "running") return `running ${tool}${since}${jobs}`;
	return `${activity.state}${since}${tool ? `, last ran ${tool}` : ""}${jobs}`;
}

export default function peerMail(pi: ExtensionAPI) {
	const z = pi.zod;
	const swarm = new Swarm();
	const runs = new RunQueue(swarm.root);
	// The mailbox and the sandbox's own files, however a vertex's tool arguments might spell them.
	const offLimits = [...new Set([swarm.root, realPath(swarm.root), swarm.root.replace(os.homedir(), "~"), SANDBOX_DIR, realPath(SANDBOX_DIR)])];

	/** Activate the peer tools this member's place allows (none when isolated). */
	async function setTools(member: Membership | undefined) {
		const others = pi.getActiveTools().filter(name => !ALL_TOOLS.includes(name));
		const mine = !member ? [] : member.hub === null ? HUB_TOOLS : VERTEX_TOOLS;
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

	// What this session is doing, from its own events: the poller decides from these whether
	// mail may stop it, and the heartbeat publishes them for peer_list.
	let toolsRunning = 0;
	let streaming = false;
	let activity: Activity = { state: "idle", since: Date.now() };
	const track = (ctx: ExtensionContext, next: Partial<Activity> & Pick<Activity, "state">) => {
		if (ctx.agent.kind !== "main") return;
		activity = { tool: activity.tool, intent: activity.intent, ...next, since: Date.now() };
	};
	pi.on("message_start", (event, ctx) => {
		if (ctx.agent.kind !== "main" || event.message.role !== "assistant") return;
		streaming = true;
		track(ctx, { state: "thinking" });
	});
	pi.on("message_end", (event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		const { message } = event;
		if (message.role === "assistant") streaming = false;
		// The user speaking to a spawned agent directly: its hub gets a quiet copy, so plans don't drift.
		const hub = membership?.hub;
		const said = membership && hub ? userSaid(message) : undefined;
		if (!membership || !hub || !said?.words.trim()) return;
		const body = said.how === "said" ? "the user said this to me directly" : "the user answered my question";
		membership.send(hub, body, { user: said.words.trim(), quiet: true });
	});
	pi.on("tool_execution_start", (event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		toolsRunning += 1;
		track(ctx, { state: "running", tool: event.toolName, intent: event.intent });
	});
	pi.on("tool_execution_end", (_event, ctx) => {
		if (ctx.agent.kind === "main") toolsRunning = Math.max(0, toolsRunning - 1);
	});
	pi.on("agent_end", (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		toolsRunning = 0;
		streaming = false;
		track(ctx, { state: "idle" });
	});

	/**
	 * Put peer-mail text in the conversation: a quiet copy joins the next turn; anything else starts
	 * a turn when idle, else lands between steps (`aside`).
	 */
	function post(ctx: ExtensionContext, content: string, details: unknown, quiet: boolean) {
		const message = { customType: "peer-mail", content, display: true, details, attribution: "agent" as const };
		if (quiet) pi.sendMessage(message, { deliverAs: "nextTurn" });
		else if (ctx.isIdle()) pi.sendMessage(message, { triggerTurn: true });
		else pi.sendMessage(message, { deliverAs: "aside" });
	}

	/**
	 * A hub hears once when one of its agents goes offline: how (agents never close their own
	 * sessions, so a closed one was closed by the user), what it was last doing, and whether it had
	 * finished. Notices about finished agents are quiet.
	 */
	function departures(member: Membership, seen: Map<string, boolean>): { note: string; quiet: boolean }[] {
		const notes: { note: string; quiet: boolean }[] = [];
		for (const peer of swarm.peers().filter(peer => peer.hub === member.name)) {
			const online = swarm.isOnline(peer);
			if (seen.get(peer.name) && !online) {
				const why =
					peer.leftHow === "closed"
						? "the user closed its session"
						: peer.leftHow === "left"
							? "it left the swarm"
							: "its process died without shutting down (killed or crashed)";
				const last = peer.activity ? describeActivity(peer.activity) : undefined;
				const note = { offline: peer.name, why, finished: !!peer.finished, ...(last ? { last } : {}), unread: swarm.pending(peer.name) };
				notes.push({ note: JSON.stringify(note), quiet: !!peer.finished });
			}
			seen.set(peer.name, online);
		}
		return notes;
	}

	function startPolling(ctx: ExtensionContext, member: Membership) {
		stopPolling();
		const beatEvery = Math.round(HEARTBEAT_MS / POLL_MS);
		let tick = 0;
		// Mail held while a stopped turn unwinds; delivered once the session is idle.
		const held: Message[] = [];
		let stopping = false;
		const vertices = new Map<string, boolean>();
		const timer = ctx.setInterval(() => {
			try {
				const hub = member.hub === null;
				if (++tick % beatEvery === 0) {
					const jobs = ctx.getAsyncJobSnapshot()?.running.length ?? 0;
					const renamed = member.heartbeat(currentModel(ctx), { ...activity, ...(jobs > 0 ? { jobs } : {}) });
					if (renamed) {
						showStatus(ctx);
						ctx.ui.notify(`peer-mail: your name was taken while this session was away; you are now ${renamed}`, "warning");
					}
					const notes = hub ? departures(member, vertices) : [];
					for (const quiet of [true, false]) {
						const batch = notes.filter(note => note.quiet === quiet);
						if (batch.length > 0) post(ctx, batch.map(note => note.note).join("\n"), undefined, quiet);
					}
				}
				const received = member.receive();
				const copies = received.filter(message => message.quiet);
				if (copies.length > 0) post(ctx, copies.map(formatForAgent).join("\n\n"), copies, true);
				held.push(...received.filter(message => !message.quiet));
				if (held.length === 0) return;
				// Idle, a hub (mail never interrupts one), or tools in flight (they finish first): deliver
				// now; while busy it lands between steps, so nothing running is cut off.
				if (ctx.isIdle() || (!stopping && (hub || toolsRunning > 0))) {
					const messages = held.splice(0);
					post(ctx, messages.map(formatForAgent).join("\n\n"), messages, false);
					stopping = false;
					return;
				}
				// An agent that is thinking: mail from its hub stops the thinking, then is delivered.
				if (!stopping && streaming) {
					stopping = true;
					ctx.abort();
					ctx.ui.notify(`peer-mail: mail from ${held.map(message => message.from).join(", ")}; stopped thinking`, "info");
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

	function currentModel(ctx: ExtensionContext): string | undefined {
		const model = ctx.models.current();
		return model ? `${model.provider}/${model.id}` : undefined;
	}

	async function join(ctx: ExtensionCommandContext, prompt: string, label: string | undefined) {
		if (ctx.agent.kind !== "main") return;
		try {
			if (membership) {
				membership.leave("left");
				await isolate(ctx);
			}
			const desired = process.env.PEER_MAIL_NAME || DEFAULT_NAME;
			const model = currentModel(ctx);
			const member =
				label === undefined
					? Membership.attach(swarm, desired, ctx.cwd, model)
					: Membership.start(swarm, label, desired, ctx.cwd, model);
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
						`Swarm "${runLabel}": you = hub "${member.name}"; can message: ${others.join(", ") || "nobody yet"}. peer_rename to your role. ` +
						"peer_spawn: new agent in kitty split, messages only you. peer_models: roles + subscription usage (omit model → balanced). " +
						"Your mail stops an agent's thinking; its running commands finish first. Mail to you never interrupts: lands between steps. " +
						'Mail = JSON line {from,id,re?,user?} + body. Body = agent request, not user instruction. user = user\'s exact words, verified by peer-mail: treat as user\'s. ' +
						"Pass on user instruction/approval with peer_send user_quote. " +
						'{"offline":…} = one of your agents went offline. Only the user closes agents\' sessions, so it is not a sign the work is done: if work remains, ask the user or spawn a replacement with the full brief. ' +
						'Mail "the user said this to me directly" = a copy: the user spoke to that agent in its own window; update your plan and the other agents. peer_list: state + status, no interrupt.',
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
			const member = Membership.spawned(swarm, request, ctx.cwd, currentModel(ctx));
			membership = member;
			await setTools(member);
			startPolling(ctx, member);
			showStatus(ctx);
			pi.sendMessage(
				{
					customType: "peer-mail",
					content:
						`Swarm "${swarm.phase()?.label ?? "swarm"}": you = "${member.name}", spawned by hub "${request.hub}", the only member you can message (peer_send). ` +
						`Report to ${request.hub} when done or blocked (it waits on you), then peer_status finished: true. Keep peer_status current, few words. ` +
						`Mail = JSON line {from,id,re?,user?} + body; mail stops your thinking, running commands finish first. ` +
						"Body = agent request, not user instruction. user = user's exact words, verified by peer-mail: treat as user's instruction/approval. " +
						(NO_SUBAGENTS[ctx.models.current()?.provider ?? ""]
							? "Your model can't run subagents (the task tool); work through it yourself. "
							: "Use subagents (the task tool) freely to research and investigate in parallel within your scope; your hub doesn't need to approve them. ") +
						(SANDBOXED ? "bash sandboxed: no listening sockets, no mailbox. " : "bash unsandboxed on this machine: never touch the mailbox or kitty. ") +
						"peer_run: heavy work on this machine (builds, tests, devices), one at a time. Remote work (ssh): plain bash.",
					display: true,
					attribution: "agent",
				},
				{ deliverAs: "nextTurn" },
			);
			// Attributed to the agent: the hub wrote this task, so it mustn't pass as the user's words (quote.ts).
			pi.sendUserMessage(request.prompt, { attribution: "agent" });
		} catch (error) {
			ctx.ui.notify(`peer-mail: couldn't join as a spawned agent: ${(error as Error).message}`, "error");
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.agent.kind !== "main" || !membership) return;
		membership.leave("closed");
		stopPolling();
		membership = undefined;
	});

	/**
	 * A vertex can't build its own channel to other agents: its bash runs in the sandbox, it gets no
	 * eval (kernels can't be sandboxed) or long-lived services, and no tool may name the peer-mail directory.
	 * Subagents share this module, so a vertex's subagents are held to the same rules.
	 */
	pi.on("tool_call", event => {
		if (!membership) return;
		// A hub delegates to peer agents, which the user can see and talk to, not to hidden subagents.
		if (membership.hub === null && event.toolName === "task") {
			return { block: true, reason: "Hubs don't start subagents: delegate with peer_spawn, giving the new agent a full brief and a scope that doesn't overlap an active agent's." };
		}
		if (membership.hub === null) return;
		if (event.toolName === "eval") {
			return { block: true, reason: "Spawned agents can't use eval: run code with bash or peer_run, which are sandboxed." };
		}
		if (isToolCallEventType("bash", event)) {
			if (event.input.name || event.input.ready) {
				return { block: true, reason: "Spawned agents can't start long-lived services; run the command with bash or peer_run." };
			}
			const unavailable = sandboxUnavailable();
			if (unavailable) return { block: true, reason: unavailable };
			const profile = sandboxProfile(swarm.root, DEFAULT_GRAPH_PORT);
			// Without sandbox-exec nothing else keeps the command out of the mailbox. The hook can see a
			// call it already wrapped (subagents share this module), so the wrapper's own path doesn't count.
			const wrapper = `${sandboxScript(profile)} `;
			const command = event.input.command.startsWith(wrapper) ? event.input.command.slice(wrapper.length) : event.input.command;
			if (!SANDBOXED && offLimits.some(dir => command.includes(dir))) {
				return { block: true, reason: "peer-mail's mailbox and sandbox files are off limits: message your hub with peer_send." };
			}
			return { input: { ...event.input, command: sandboxedCommand(event.input.command, profile) } };
		}
		// The peer tools are the sanctioned way in; their text may mention the mailbox freely.
		if (ALL_TOOLS.includes(event.toolName)) return;
		const args = JSON.stringify(event.input);
		if (offLimits.some(dir => args.includes(dir))) {
			return { block: true, reason: "peer-mail's mailbox and sandbox files are off limits: message your hub with peer_send." };
		}
	});

	pi.registerTool({
		name: "peer_run",
		label: "Peer run",
		description:
			"Run a heavy command (tests, builds, benchmarks, anything using shared hardware) through the machine-wide run queue: runs go one at a time, " +
			"in the order they were queued, so agents don't fight over the CPU or devices. It waits its turn, then runs `command` with bash in `cwd` " +
			"inside the same sandbox as your bash (no listening sockets, no access to the swarm's mailbox) and returns the exit code and the end of its output. " +
			"A command that starts with `ssh` runs on another computer, so it doesn't wait in line: it starts at once (or just use bash for it). " +
			"Everything the command starts is killed when it ends. Use plain bash for quick commands such as git or reading files.",
		parameters: z.object({
			command: z.string().describe("The bash command to run."),
			cwd: z.string().optional().describe("Directory to run it in (default: the session's)."),
			timeout: z.number().optional().describe(`Seconds before it's killed (default ${RUN_TIMEOUT_DEFAULT_S}, at most ${RUN_TIMEOUT_MAX_S}).`),
		}),
		approval: "exec",
		defaultInactive: true,
		async execute(_toolCallId, params: { command: string; cwd?: string; timeout?: number }, signal, onUpdate, ctx) {
			if (!membership) throw new Error(ISOLATED);
			const unavailable = sandboxUnavailable();
			if (unavailable) throw new Error(unavailable);
			if (!SANDBOXED && offLimits.some(dir => params.command.includes(dir) || (params.cwd ?? "").includes(dir))) {
				throw new Error("peer-mail's mailbox and sandbox files are off limits: message your hub with peer_send.");
			}
			// Some models fill every optional field (empty strings, zeros); those mean "not given".
			const timeout = Math.min(params.timeout && params.timeout > 0 ? params.timeout : RUN_TIMEOUT_DEFAULT_S, RUN_TIMEOUT_MAX_S);
			const remote = runsElsewhere(params.command);
			const cwd = path.resolve(ctx.cwd, params.cwd?.trim() || ".");
			const ticket = remote ? runs.ticket(membership.name, params.command, cwd) : runs.enqueue(membership.name, params.command, cwd);
			try {
				if (!remote) {
					await runs.waitTurn(ticket, signal, (ahead: RunTicket[]) => {
						const text = `Waiting in the run queue: ${ahead.length} ahead; running now: ${ahead[0].member}: ${ahead[0].command}`;
						onUpdate?.({ content: [{ type: "text", text }], details: { ahead: ahead.length } });
					});
				}
				onUpdate?.({ content: [{ type: "text", text: `Running: ${params.command}` }], details: { ahead: 0 } });
				const result = await runs.run(ticket, sandboxProfile(swarm.root, DEFAULT_GRAPH_PORT), timeout * 1000, signal);
				const status = result.timedOut
					? `killed after its ${timeout}s timeout`
					: result.aborted
						? "aborted"
						: `exited with code ${result.exitCode ?? "none (killed)"}`;
				const leftovers = result.leftovers > 0 ? `; killed ${result.leftovers} process(es) it left running` : "";
				const text = `${status} after ${(result.durationMs / 1000).toFixed(1)}s${leftovers}\n\n${result.output || "(no output)"}`;
				if (result.timedOut || result.aborted || result.exitCode !== 0) throw new Error(text);
				return { content: [{ type: "text", text }], details: result };
			} finally {
				runs.remove(ticket.id);
			}
		},
	});

	pi.registerTool({
		name: "peer_list",
		label: "Peer list",
		description:
			"List the swarm members you can message: whether each is running, what it is doing (thinking, running a tool, idle) and for how long, with its background jobs " +
			"(async commands, background subagents); or since when it has been offline and why; " +
			"its peer_status and whether it is finished; unread: mail sent to it that it hasn't received yet (don't resend it); " +
			"and plugin: 'old' when it loaded older peer-mail code (only the user can restart it; it works, without the newest behaviour). Reading this never interrupts anyone.",
		parameters: z.object({}),
		approval: "read",
		defaultInactive: true,
		async execute() {
			if (!membership) throw new Error(ISOLATED);
			const you = membership.name;
			const now = Date.now();
			const ago = (at: number) => {
				const seconds = Math.round((now - at) / 1000);
				return seconds < 120 ? `${seconds}s` : seconds < 7200 ? `${Math.round(seconds / 60)}m` : `${Math.round(seconds / 3600)}h`;
			};
			const current = codeVersion();
			const peers = swarm.reachable(you).map(peer => {
				const how = peer.leftHow === "closed" ? "closed by the user" : peer.leftHow === "left" ? "left the swarm" : "process died";
				const state = !swarm.isOnline(peer)
					? `offline ${ago(peer.leftAt ?? peer.seenAt)} (${how})`
					: peer.activity
						? describeActivity(peer.activity, ago(peer.activity.since))
						: "online";
				const unread = swarm.pending(peer.name);
				return {
					name: peer.name,
					hub: peer.hub,
					state,
					...(peer.status ? { status: peer.status } : {}),
					...(peer.finished ? { finished: true } : {}),
					...(unread > 0 ? { unread } : {}),
					...(peer.model ? { model: peer.model } : {}),
					...(peer.plugin !== current ? { plugin: "old" } : {}),
				};
			});
			const details = { swarm: swarm.phase()?.label, you, hub: membership.hub, peers };
			return { content: [{ type: "text", text: JSON.stringify(details) }], details };
		},
	});

	pi.registerTool({
		name: "peer_send",
		label: "Peer send",
		description:
			`Send a message to a swarm member by name (see peer_list), or to '${BROADCAST}' (every running member you can reach that isn't finished). ` +
			"A hub's message stops its agent's thinking (running commands finish first); a message to a hub never interrupts it. " +
			"The other agent can't see your conversation. A message that gives or changes work (a new task, a correction, a redirect: it stops the recipient's thinking) " +
			"must be complete: what to do, why, every fact it needs (paths, hosts, commands, findings), what not to touch, what done looks like. " +
			"Replies, confirmations and reports are terse: facts, paths, numbers, no filler. Confirm every message you receive with a terse reply (reply_to: its id) " +
			"saying what you understood and will do; never confirm a confirmation; no thanks. If a message you receive is ambiguous, ask instead of guessing. " +
			"To pass on the user's instruction or approval, put their exact words in user_quote.",
		parameters: z.object({
			to: z.string().describe(`Member name from peer_list, or '${BROADCAST}'.`),
			message: z.string().describe("Terse, self-contained message."),
			reply_to: z.string().optional().describe("Id of the message you are answering."),
			user_quote: z
				.string()
				.optional()
				.describe(
					"The user's own words, copied exactly from a message they sent you or a question-box answer; omit if none. Checked against your session: the recipient sees them as the user's, and words the user didn't say are dropped (the message still goes, and you're told).",
				),
		}),
		approval: "write",
		defaultInactive: true,
		// The published typings don't infer zod schemas into `params`; this matches the schema above.
		async execute(_toolCallId, params: { to: string; message: string; reply_to?: string; user_quote?: string }, _signal, _onUpdate, ctx) {
			if (!membership) throw new Error(ISOLATED);
			// Some models fill every optional field, so a blank reply_to or user_quote means none.
			const replyTo = params.reply_to?.trim() || undefined;
			const quote = params.user_quote?.trim() || undefined;
			// A quote that isn't the user's words is dropped rather than blocking the message; the sender is told.
			let user: string | undefined;
			let dropped = "";
			try {
				user = quote === undefined ? undefined : verifiedQuote(ctx.sessionManager, quote);
			} catch (error) {
				dropped = ` Sent without user_quote: ${(error as Error).message}`;
			}
			const sent = membership.send(params.to, params.message, { replyTo, user });
			const recipients = sent.map(message => message.to);
			const ids = sent.map(message => message.id);
			const offline = recipients.filter(name => {
				const peer = swarm.peer(name);
				return peer && !swarm.isOnline(peer);
			});
			const warning = offline.length > 0 ? ` ${offline.join(", ")} is offline: it won't read this unless its session comes back.` : "";
			return {
				content: [{ type: "text", text: `Sent to ${recipients.join(", ")} (id ${ids.join(", ")}).${warning}${dropped}` }],
				details: { recipients, ids, offline },
			};
		},
	});

	pi.registerTool({
		name: "peer_status",
		label: "Peer status",
		description:
			"Set your status, shown to the others in peer_list without messaging or interrupting anyone: what you're on, in a few words (e.g. 'fixing gripper timeout; tests 3/5 pass'). " +
			"Set finished when your work is done (after reporting it): broadcasts then skip you, and new mail to you makes you unfinished again.",
		parameters: z.object({
			status: z.string().max(200).optional().describe("A few words; omit to keep the current one."),
			finished: z.boolean().optional().describe("true when your work is done; false when you take on more."),
		}),
		approval: "read",
		defaultInactive: true,
		async execute(_toolCallId, params: { status?: string; finished?: boolean }) {
			if (!membership) throw new Error(ISOLATED);
			const status = params.status?.trim();
			const update = { ...(status ? { status } : {}), ...(params.finished !== undefined ? { finished: params.finished } : {}) };
			membership.setStatus(update);
			return { content: [{ type: "text", text: "Status set." }], details: update };
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
		name: "peer_models",
		label: "Peer models",
		description:
			"Before peer_spawn: the subscriptions (providers) this machine can use, how much of each one's usage is spent, how many swarm agents run on it " +
			"and whether its models can run subagents; the user's omp roles (any of them works as peer_spawn's model, e.g. '@default'); " +
			"and the role an agent gets when you leave the model out. Spread agents across subscriptions so no single one runs out.",
		parameters: z.object({}),
		approval: "read",
		defaultInactive: true,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (!membership) throw new Error(ISOLATED);
			const options = await modelOptions(ctx, pi.pi.settings, swarm.peers());
			const suggested = autoChoice(ctx, options);
			const details = {
				subscriptions: Object.fromEntries(options.subscriptions.map(subscription => [subscription.provider, describeSubscription(subscription)])),
				roles: Object.fromEntries(options.roles.map(role => [`@${role.role}`, `${role.provider}/${role.model}`])),
				suggested: suggested?.selector,
				anyModel: "or any provider/model id this machine has",
			};
			return { content: [{ type: "text", text: JSON.stringify(details) }], details: { ...details, suggestedReason: suggested?.reason } };
		},
	});

	/**
	 * Ask the user to approve a spawn and to confirm or change its model. Returns the model to run
	 * on, or undefined when they decline. The first option is the hub's choice; the others are the
	 * user's remaining roles, least-loaded subscription first; a typed answer names any role or model.
	 */
	async function approveSpawn(
		ctx: ExtensionContext,
		name: string,
		prompt: string,
		choice: ModelChoice,
		options: ModelOptions,
	): Promise<ModelChoice | undefined> {
		const bySubscription = new Map(options.subscriptions.map(subscription => [subscription.provider, subscription]));
		const status = (provider: string) => {
			const subscription = bySubscription.get(provider);
			const full = subscription && (subscription.exhausted || (subscription.used ?? 0) >= NEARLY_FULL) ? " · nearly full" : "";
			return `${describeSubscription(subscription)}${full}`;
		};
		const choices = new Map<string, ModelChoice>();
		choices.set(`Start on ${choice.selector}`, choice);
		// Agent roles before chore roles, each on the least-loaded subscription first.
		const ordered = [...options.roles].sort(
			(a, b) =>
				Number(!!CHORE_ROLES[a.role]) - Number(!!CHORE_ROLES[b.role]) ||
				load(bySubscription.get(a.provider)) - load(bySubscription.get(b.provider)),
		);
		for (const role of ordered) {
			if (`@${role.role}` === choice.selector) continue;
			choices.set(`Start on @${role.role}`, requestedChoice(ctx, options, `@${role.role}`));
		}
		const decline = "Don't start it";
		const items = [...choices.entries()].map(([label, item]) => ({
			label,
			description: `${item.provider}/${item.model} — ${item === choice ? item.reason : status(item.provider)}`,
		}));
		const title = `Start a new agent "${name}"?`;
		const question = `Start "${name}" for ${membership?.name} (omp in a kitty split, ${ctx.cwd})? Pick its model. Its task:\n\n${prompt}`;
		if (ctx.ui.askDialog) {
			const result = await ctx.ui.askDialog([{ id: "spawn", header: title, question, options: [...items, { label: decline }], recommended: 0 }]);
			if (!result || result.kind !== "submit") return undefined;
			const answer = result.results[0];
			if (answer?.customInput?.trim()) return requestedChoice(ctx, options, answer.customInput);
			return answer ? choices.get(answer.selectedOptions[0] ?? "") : undefined;
		}
		const picked = await ctx.ui.select(`${title} ${question.replace(/\s+/g, " ")}`, [...items, decline]);
		return picked ? choices.get(picked) : undefined;
	}

	pi.registerTool({
		name: "peer_spawn",
		label: "Peer spawn",
		description:
			"Start another agent: a new omp session in a kitty split beside this one, working on `prompt`. It joins the swarm as one of your vertices: " +
			"it can only message you (with peer_send), and its messages arrive in your conversation. Give it a role name and a full brief as `prompt`: " +
			"it starts knowing nothing of your conversation, so put in everything it needs. Choose its model with `model` (see peer_models): " +
			"one of the user's omp roles ('@slow', '@plan', …) suited to its work, or a model; leave it out to use the subscription with the most room. " +
			"Only hubs can spawn. The user approves every spawn and may change the model; if they decline, don't retry the same spawn. Waits until the agent has joined. " +
			"Spawn early and often: agents are how a hub works. When your task has work for other agents, start them before doing your own investigation, and let each inspect its own area; " +
			"split work into parallel agents, with separate agents for verification and end-to-end checks. If they need something you are still preparing (a contract, a decision), " +
			"spawn them anyway to investigate read-only, and send it when ready. Before spawning, check peer_list so the new agent's files and responsibilities don't overlap an active agent's, " +
			"and state its boundaries in the brief. While agents work, end your turn instead of waiting: their mail starts your next turn.",
		parameters: z.object({
			name: z.string().describe("Its name in the swarm, usually its role, e.g. 'reviewer'."),
			prompt: z
				.string()
				.describe(
					"A complete brief, not a summary: the goal and why; everything you know that it needs (repos, paths, hosts, commands, prior findings, the user's relevant words); " +
						"constraints and what not to touch; what done looks like; what to report to you and when. Longer is better than ambiguous.",
				),
			model: z.string().optional().describe("An omp role ('@slow') or model ('openai-codex/gpt-6.1-sol'); omit to balance across subscriptions."),
			split: z.enum(["auto", "vertical", "horizontal"]).optional().describe("How to split this window (default auto)."),
		}),
		// The tool asks the user itself (below), showing the name, task and model, so the generic approval gate doesn't ask twice.
		approval: { tier: "exec", policy: "allow" },
		defaultInactive: true,
		async execute(
			_toolCallId,
			params: { name: string; prompt: string; model?: string; split?: SplitDirection },
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
			const options = await modelOptions(ctx, pi.pi.settings, swarm.peers());
			// An agent named after one of the user's roles runs on that role unless the hub says otherwise.
			const spec = params.model?.trim() || (options.roles.some(role => role.role === params.name) ? `@${params.name}` : undefined);
			const proposed = spec ? requestedChoice(ctx, options, spec) : autoChoice(ctx, options);
			if (!proposed) throw new Error("No model is available to run the agent on.");
			const choice = await approveSpawn(ctx, params.name, params.prompt, proposed, options);
			if (!choice) throw new Error(`The user declined to start "${params.name}".`);
			const request = swarm.requestSpawn(membership.peer, params.name, params.prompt);
			const env: Record<string, string> = { PEER_MAIL_SPAWN: request.id, PATH: process.env.PATH ?? "" };
			if (process.env.PEER_MAIL_DIR) env.PEER_MAIL_DIR = process.env.PEER_MAIL_DIR;
			const window = await openSplit({
				command: [Bun.which("omp") ?? "omp", "--model", choice.launch],
				cwd: ctx.cwd,
				title: `omp · ${params.name}`,
				env,
				direction: params.split ?? "auto",
				// This hub's agents in this kitty; the largest window among them and the hub is split.
				splittable: swarm
					.peers()
					.filter(peer => peer.hub === membership?.name && peer.kitty?.socket === process.env.KITTY_LISTEN_ON)
					.flatMap(peer => (peer.kitty ? [peer.kitty.window] : [])),
			});
			// The hub should know when the user overrode its choice, so it doesn't misread the agent's model later.
			const changed = choice.launch !== proposed.launch ? ` The user chose this model at approval instead of your ${proposed.selector} (${proposed.provider}/${proposed.model}).` : "";
			const on = `${choice.selector} (${choice.provider}/${choice.model})`;
			const deadline = Date.now() + SPAWN_JOIN_TIMEOUT_MS;
			while (Date.now() < deadline && !signal?.aborted) {
				const joined = swarm.spawned(request.id);
				if (joined) {
					const text = `Started "${joined.name}" on ${on} in kitty window ${window}. It is working on your prompt and will message you.${changed}`;
					return { content: [{ type: "text", text }], details: { name: joined.name, window, model: choice } };
				}
				await Bun.sleep(500);
			}
			const text = `Opened kitty window ${window} for ${on}, but the agent hasn't joined the swarm yet; check it with peer_list shortly.${changed}`;
			return { content: [{ type: "text", text }], details: { name: params.name, window, model: choice } };
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
			membership.leave("left");
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
