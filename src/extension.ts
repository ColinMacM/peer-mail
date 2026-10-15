/**
 * peer-mail: omp sessions message each other inside named swarms.
 *
 *   /startswarm [name] <prompt>   start swarm `name` afresh (earlier members and mail are deleted), join it, run <prompt>
 *   /swarm [name] <prompt>        join swarm `name` as it is now (begin it if it doesn't exist), run <prompt>
 *   /swarm                        show this session's swarm and its members
 *   /swarm-leave                  leave the swarm; the session is isolated again
 *   /peer-name [name]             show or change this session's name in its swarm
 *
 * Without `[name]` the swarm is named after the session's directory. A session that hasn't joined
 * is isolated: it has no peer tools and no one can mail it. Members get `peer_list` and
 * `peer_send`; mail arrives in their conversation and starts a turn if they are idle, or is read
 * at their next step if they are working. Roles come from the prompt, not from configuration.
 */
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { formatForAgent, Membership, POLL_MS } from "./inbox";
import { BROADCAST, HEARTBEAT_MS, StalePhaseError, Swarm } from "./transport";

const TOOLS = ["peer_list", "peer_send"];
const ISOLATED = "This session is isolated: it hasn't joined a swarm (/swarm or /startswarm).";
const DEFAULT_NAME = "agent";

// Subagent sessions rebind this factory but share the module, so they act as their main session.
let membership: Membership | undefined;
let poller: { ctx: ExtensionContext; timer: Timer } | undefined;

/** `[name] rest` → name and rest; without brackets the whole text is the prompt. */
function parseSwarmArgs(args: string): { swarm?: string; prompt: string } {
	const match = /^\s*\[([^\]]*)\]\s*([\s\S]*)$/.exec(args);
	return match ? { swarm: match[1].trim(), prompt: match[2].trim() } : { prompt: args.trim() };
}

export default function peerMail(pi: ExtensionAPI) {
	const z = pi.zod;

	async function setTools(active: boolean) {
		const others = pi.getActiveTools().filter(name => !TOOLS.includes(name));
		await pi.setActiveTools(active ? [...others, ...TOOLS] : others);
	}

	function stopPolling() {
		if (poller) poller.ctx.clearTimer(poller.timer);
		poller = undefined;
	}

	/** Drop out of the swarm (left, restarted elsewhere, or session ending) and go back to isolated. */
	async function isolate(ctx: ExtensionContext) {
		stopPolling();
		membership = undefined;
		ctx.ui.setStatus("peer-mail", undefined);
		await setTools(false);
	}

	function startPolling(ctx: ExtensionContext, member: Membership) {
		stopPolling();
		const beatEvery = Math.round(HEARTBEAT_MS / POLL_MS);
		let tick = 0;
		const timer = ctx.setInterval(() => {
			try {
				if (++tick % beatEvery === 0) {
					const renamed = member.heartbeat();
					if (renamed) {
						ctx.ui.setStatus("peer-mail", `✉ ${member.swarm.name}/${renamed}`);
						ctx.ui.notify(`peer-mail: your name was taken while this session was away; you are now ${renamed}`, "warning");
					}
				}
				for (const message of member.receive()) {
					// "aside": read at the agent's next step if it is working, or start a turn if idle.
					pi.sendMessage(
						{
							customType: "peer-mail",
							content: formatForAgent(member.swarm.name, message),
							display: true,
							details: message,
							attribution: "agent",
						},
						{ deliverAs: "aside" },
					);
				}
			} catch (error) {
				if (!(error instanceof StalePhaseError)) throw error;
				void isolate(ctx);
				ctx.ui.notify(`peer-mail: ${error.message} Run /swarm [${member.swarm.name}] to join the new one.`, "warning");
				pi.sendMessage(
					{ customType: "peer-mail", content: `${error.message} Don't use peer_list or peer_send.`, display: true, attribution: "agent" },
					{ deliverAs: "nextTurn" },
				);
			}
		}, POLL_MS);
		poller = { ctx, timer };
	}

	async function joinSwarm(args: string, ctx: ExtensionCommandContext, restart: boolean) {
		if (ctx.agent.kind !== "main") return;
		const { swarm: requested, prompt } = parseSwarmArgs(args);
		try {
			const swarm = new Swarm(requested || path.basename(ctx.cwd));
			if (membership) {
				membership.leave();
				await isolate(ctx);
			}
			const member = Membership.join(swarm, process.env.PEER_MAIL_NAME || DEFAULT_NAME, ctx.cwd, restart);
			membership = member;
			await setTools(true);
			startPolling(ctx, member);
			ctx.ui.setStatus("peer-mail", `✉ ${swarm.name}/${member.name}`);

			const others = swarm
				.peers()
				.filter(peer => peer.name !== member.name)
				.map(peer => peer.name);
			const verb = restart ? "started" : "joined";
			ctx.ui.notify(`peer-mail: ${verb} swarm ${swarm.name} as ${member.name}`, "info");
			pi.sendMessage(
				{
					customType: "peer-mail",
					content:
						`You ${verb} swarm "${swarm.name}" as "${member.name}". Other members: ${others.join(", ") || "none yet"}. ` +
						"Use peer_list to see who is in the swarm and peer_send to message them; their messages arrive in this conversation. " +
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
			"List the members of your swarm you can message with peer_send: their name, whether they are running now, and their working directory. Also says your own name.",
		parameters: z.object({}),
		approval: "read",
		defaultInactive: true,
		async execute() {
			if (!membership) throw new Error(ISOLATED);
			const swarm = membership.swarm;
			const you = membership.name;
			const peers = swarm
				.peers()
				.filter(peer => peer.name !== you)
				.map(peer => ({ name: peer.name, online: swarm.isOnline(peer), cwd: peer.cwd }));
			const details = { swarm: swarm.name, you, peers };
			return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
		},
	});

	pi.registerTool({
		name: "peer_send",
		label: "Peer send",
		description:
			`Send a message to a member of your swarm by name (see peer_list), or to '${BROADCAST}'. It appears in that member's conversation and wakes it if idle; ` +
			"a member that isn't running gets it when it rejoins. Write a self-contained request: the other agent can't see your conversation. " +
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

	pi.registerCommand("startswarm", {
		description: "Start a swarm afresh (old members and mail are deleted) and join it: /startswarm [name] <prompt>",
		handler: (args, ctx) => joinSwarm(args, ctx, true),
	});

	pi.registerCommand("swarm", {
		description: "Join a swarm as it is now: /swarm [name] <prompt>. With no arguments, show this session's swarm.",
		handler: async (args, ctx) => {
			if (args.trim()) return joinSwarm(args, ctx, false);
			if (!membership) {
				ctx.ui.notify(`peer-mail: ${ISOLATED}`, "info");
				return;
			}
			const swarm = membership.swarm;
			const members = swarm.peers().map(peer => `${peer.name}${swarm.isOnline(peer) ? "" : " (offline)"}`);
			ctx.ui.notify(`peer-mail: swarm ${swarm.name}, you are ${membership.name}. Members: ${members.join(", ")}`, "info");
		},
	});

	pi.registerCommand("swarm-leave", {
		description: "Leave this session's swarm; it becomes isolated again",
		handler: async (_args, ctx) => {
			if (!membership) {
				ctx.ui.notify(`peer-mail: ${ISOLATED}`, "info");
				return;
			}
			const name = membership.swarm.name;
			membership.leave();
			await isolate(ctx);
			ctx.ui.notify(`peer-mail: left swarm ${name}; this session is isolated`, "info");
		},
	});

	pi.registerCommand("peer-name", {
		description: "Show or change this session's name in its swarm: /peer-name [name]",
		handler: async (args, ctx) => {
			if (!membership) {
				ctx.ui.notify(`peer-mail: ${ISOLATED}`, "warning");
				return;
			}
			try {
				const wanted = args.trim();
				const name = wanted ? membership.rename(wanted) : membership.name;
				ctx.ui.setStatus("peer-mail", `✉ ${membership.swarm.name}/${name}`);
				ctx.ui.notify(`peer-mail: you are ${name}`, "info");
			} catch (error) {
				ctx.ui.notify(`peer-mail: ${(error as Error).message}`, "error");
			}
		},
	});
}
