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
 * and its other tools can't touch the peer-mail directory. Mail interrupts its recipient: the
 * turn is aborted (with its running commands and eval) and its background jobs are cancelled,
 * then the mail starts a new turn. Roles come from the prompt, and an agent can rename itself.
 */
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { isToolCallEventType } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { DEFAULT_GRAPH_PORT, graphRunning } from "./graph";
import { formatForAgent, Membership, POLL_MS } from "./inbox";
import { openSplit, type SplitDirection, splitUnavailable } from "./kitty";
import { cancelBackgroundJobs } from "./jobs";
import {
	autoChoice,
	CHORE_ROLES,
	describeSubscription,
	load,
	type ModelChoice,
	type ModelOptions,
	modelOptions,
	NEARLY_FULL,
	requestedChoice,
} from "./models";
import { RunQueue, type RunTicket } from "./queue";
import { realPath, sandboxedCommand, sandboxProfile, sandboxUnavailable } from "./sandbox";
import { BROADCAST, HEARTBEAT_MS, type Message, StalePhaseError, Swarm } from "./transport";

// Every member gets these; hubs and vertices each add their own.
const MEMBER_TOOLS = ["peer_list", "peer_send", "peer_rename"];
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

export default function peerMail(pi: ExtensionAPI) {
	const z = pi.zod;
	const swarm = new Swarm();
	const runs = new RunQueue(swarm.root);
	// The mailbox directory, however a vertex's tool arguments might spell it.
	const mailPaths = [...new Set([swarm.root, realPath(swarm.root), swarm.root.replace(os.homedir(), "~")])];

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

	/**
	 * Stop everything the session is doing, without asking it: abort the running turn (with its
	 * commands and eval) and cancel its background jobs. Returns labels of the jobs cancelled.
	 */
	function stopWork(ctx: ExtensionContext): string[] {
		if (!ctx.isIdle()) ctx.abort();
		const { cancelled, failed } = cancelBackgroundJobs(ctx);
		if (failed.length > 0) ctx.ui.notify(`peer-mail: couldn't cancel background jobs: ${failed.join(", ")}`, "warning");
		return cancelled;
	}

	/** Hand received mail to the agent and start a turn on it, saying what work the mail stopped. */
	function deliver(messages: Message[], stopped: { turn: boolean; jobs: string[] }) {
		const what = [
			...(stopped.turn ? ["your running turn (its commands and eval)"] : []),
			...(stopped.jobs.length > 0 ? [`background jobs ${stopped.jobs.join(", ")}`] : []),
		];
		const note = what.length > 0 ? [`This mail stopped ${what.join(" and ")}.`] : [];
		pi.sendMessage(
			{ customType: "peer-mail", content: [...messages.map(formatForAgent), ...note].join("\n\n---\n\n"), display: true, details: messages, attribution: "agent" },
			{ triggerTurn: true },
		);
	}

	function startPolling(ctx: ExtensionContext, member: Membership) {
		stopPolling();
		const beatEvery = Math.round(HEARTBEAT_MS / POLL_MS);
		let tick = 0;
		// Mail held while an interrupted turn unwinds; delivered once the session is idle.
		const held: Message[] = [];
		let stopped: { turn: boolean; jobs: string[] } | undefined;
		const timer = ctx.setInterval(() => {
			try {
				if (++tick % beatEvery === 0) {
					const renamed = member.heartbeat(currentModel(ctx));
					if (renamed) {
						showStatus(ctx);
						ctx.ui.notify(`peer-mail: your name was taken while this session was away; you are now ${renamed}`, "warning");
					}
				}
				held.push(...member.receive());
				if (held.length === 0) return;
				if (!stopped) {
					// Mail stops the agent outright, with no say in it: the turn, its tool calls, bash, eval and background jobs.
					const busy = !ctx.isIdle();
					stopped = { turn: busy, jobs: stopWork(ctx) };
					if (busy || stopped.jobs.length > 0) {
						ctx.ui.notify(`peer-mail: mail from ${held.map(message => message.from).join(", ")}; stopped current work`, "info");
					}
				}
				if (!ctx.isIdle()) return;
				// Jobs started while the aborted turn unwound are cancelled too.
				stopped.jobs.push(...stopWork(ctx));
				deliver(held.splice(0), stopped);
				stopped = undefined;
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
				membership.leave();
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
						`You ${verb} the swarm "${runLabel}" as "${member.name}", a hub. Members you can message: ${others.join(", ") || "none yet"}. ` +
						"If your task gives you a role, first rename yourself after it with peer_rename (for example 'reviewer') so the others can address you. " +
						"Use peer_spawn to start another agent in a new terminal split: it works on the prompt you give it and can only message you. " +
						"Each agent can run on a different subscription and model: peer_models lists the user's omp roles and how much of each subscription is used; " +
						"pick a role that fits the agent's work, or leave the model out and the spawn goes to the subscription with the most room. " +
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
			const member = Membership.spawned(swarm, request, ctx.cwd, currentModel(ctx));
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
						"Run tests, builds and anything else heavy with peer_run: it queues them so runs across the machine go one at a time. " +
						"Your commands run in a sandbox: nothing you start can listen on a socket or touch the swarm's mailbox. " +
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

	/**
	 * A vertex can't build its own channel to other agents: its bash runs in the sandbox, it gets no
	 * eval (kernels can't be sandboxed) or long-lived services, and no tool may name the peer-mail directory.
	 * Subagents share this module, so a vertex's subagents are held to the same rules.
	 */
	pi.on("tool_call", event => {
		if (!membership || membership.hub === null) return;
		if (event.toolName === "eval") {
			return { block: true, reason: "Spawned agents can't use eval: run code with bash or peer_run, which are sandboxed." };
		}
		if (isToolCallEventType("bash", event)) {
			if (event.input.name || event.input.ready) {
				return { block: true, reason: "Spawned agents can't start long-lived services; run the command with bash or peer_run." };
			}
			const unavailable = sandboxUnavailable();
			if (unavailable) return { block: true, reason: unavailable };
			return { input: { ...event.input, command: sandboxedCommand(event.input.command, sandboxProfile(swarm.root, DEFAULT_GRAPH_PORT)) } };
		}
		// The peer tools are the sanctioned way in; their text may mention the mailbox freely.
		if (ALL_TOOLS.includes(event.toolName)) return;
		const args = JSON.stringify(event.input);
		if (mailPaths.some(dir => args.includes(dir))) {
			return { block: true, reason: "The swarm's mailbox is off limits: message your hub with peer_send." };
		}
	});

	pi.registerTool({
		name: "peer_run",
		label: "Peer run",
		description:
			"Run a heavy command (tests, builds, benchmarks, anything using shared hardware) through the machine-wide run queue: runs go one at a time, " +
			"in the order they were queued, so agents don't fight over the CPU or devices. It waits its turn, then runs `command` with bash in `cwd` " +
			"inside the same sandbox as your bash (no listening sockets, no access to the swarm's mailbox) and returns the exit code and the end of its output. " +
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
			const timeout = Math.min(Math.max(params.timeout ?? RUN_TIMEOUT_DEFAULT_S, 1), RUN_TIMEOUT_MAX_S);
			const ticket = runs.enqueue(membership.name, params.command, path.resolve(ctx.cwd, params.cwd ?? "."));
			try {
				await runs.waitTurn(ticket, signal, (ahead: RunTicket[]) => {
					const text = `Waiting in the run queue: ${ahead.length} ahead; running now: ${ahead[0].member}: ${ahead[0].command}`;
					onUpdate?.({ content: [{ type: "text", text }], details: { ahead: ahead.length } });
				});
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
		name: "peer_models",
		label: "Peer models",
		description:
			"Before peer_spawn: the subscriptions (providers) this machine can use, how much of each one's usage is spent and how many swarm agents run on it, " +
			"the user's omp model roles with the model each runs, and the model an agent would get by default (the subscription with the most room). " +
			"Spread agents across subscriptions so no single one runs out.",
		parameters: z.object({}),
		approval: "read",
		defaultInactive: true,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (!membership) throw new Error(ISOLATED);
			const options = await modelOptions(ctx, pi.pi.settings, swarm.peers());
			const details = {
				subscriptions: options.subscriptions.map(subscription => ({ ...subscription, summary: describeSubscription(subscription) })),
				roles: options.roles,
				default: autoChoice(ctx, options),
				otherModels: options.models,
			};
			return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
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
			"it can only message you (with peer_send), and its messages arrive in your conversation. Give it a role name and a self-contained prompt " +
			"(it can't see your conversation), including what to report back to you and when. Choose its model with `model` (see peer_models): " +
			"one of the user's omp roles ('@slow', '@plan', …) suited to its work, or a model; leave it out to use the subscription with the most room. " +
			"Only hubs can spawn. The user approves every spawn and may change the model; if they decline, don't retry the same spawn. Waits until the agent has joined.",
		parameters: z.object({
			name: z.string().describe("Its name in the swarm, usually its role, e.g. 'reviewer'."),
			prompt: z.string().describe("Its task, written for an agent that can't see your conversation."),
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
			const spec = params.model ?? (options.roles.some(role => role.role === params.name) ? `@${params.name}` : undefined);
			const proposed = spec ? requestedChoice(ctx, options, spec) : autoChoice(ctx, options);
			if (!proposed) throw new Error("No model is available to run the agent on.");
			const choice = await approveSpawn(ctx, params.name, params.prompt, proposed, options);
			if (!choice) throw new Error(`The user declined to start "${params.name}".`);
			const request = swarm.requestSpawn(membership.peer, params.name, params.prompt);
			const env: Record<string, string> = { PEER_MAIL_SPAWN: request.id, PATH: process.env.PATH ?? "" };
			if (process.env.PEER_MAIL_DIR) env.PEER_MAIL_DIR = process.env.PEER_MAIL_DIR;
			const window = await openSplit({
				command: [Bun.which("omp") ?? "omp", "--model", choice.selector],
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
			const on = `${choice.selector} (${choice.provider}/${choice.model})`;
			const deadline = Date.now() + SPAWN_JOIN_TIMEOUT_MS;
			while (Date.now() < deadline && !signal?.aborted) {
				const joined = swarm.spawned(request.id);
				if (joined) {
					const text = `Started "${joined.name}" on ${on} in kitty window ${window}. It is working on your prompt and will message you.`;
					return { content: [{ type: "text", text }], details: { name: joined.name, window, model: choice } };
				}
				await Bun.sleep(500);
			}
			const text = `Opened kitty window ${window} for ${on}, but the agent hasn't joined the swarm yet; check it with peer_list shortly.`;
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
