/**
 * peer-mail: lets interactive omp sessions on this machine message each other.
 *
 * Each interactive session joins under a name (PEER_MAIL_NAME, else its directory's name,
 * suffixed -2, -3… when taken; `/peer-name` changes it). The agent gets `peer_list` and
 * `peer_send`; mail sent to the session shows up in its conversation and starts a turn if it is
 * idle, or is read at its next step if it is working. Mail to a session that isn't running
 * waits until it joins again. Non-interactive runs (`omp -p`) don't join.
 */
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { formatForAgent, Inbox, POLL_MS } from "./inbox";
import { BROADCAST, HEARTBEAT_MS, Transport } from "./transport";

// Subagent sessions rebind this factory but share the module, so they send as their main session.
let inbox: Inbox | undefined;

const NOT_JOINED = "This session hasn't joined peer-mail (only interactive omp sessions do).";

export default function peerMail(pi: ExtensionAPI) {
	const z = pi.zod;
	const transport = new Transport();

	function showName(ctx: ExtensionContext, name: string) {
		ctx.ui.setStatus("peer-mail", `✉ ${name}`);
	}

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.agent.kind !== "main" || (ctx.mode !== "tui" && ctx.mode !== "rpc")) return;
		// A session switch (/new, /resume) starts again in the same process: keep the name and timers.
		if (inbox) {
			showName(ctx, inbox.name);
			return;
		}
		const joined = new Inbox(transport, process.env.PEER_MAIL_NAME || path.basename(ctx.cwd), ctx.cwd);
		inbox = joined;
		showName(ctx, joined.name);

		ctx.setInterval(() => {
			const renamed = joined.heartbeat();
			if (renamed) {
				showName(ctx, renamed);
				ctx.ui.notify(`peer-mail: your name was taken while this session was away; you are now ${renamed}`, "warning");
			}
		}, HEARTBEAT_MS);

		ctx.setInterval(() => {
			for (const message of joined.receive()) {
				// "aside": read at the agent's next step if it is working, or start a turn if idle.
				pi.sendMessage(
					{ customType: "peer-mail", content: formatForAgent(message), display: true, details: message, attribution: "agent" },
					{ deliverAs: "aside" },
				);
			}
		}, POLL_MS);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.agent.kind !== "main" || !inbox) return;
		inbox.leave();
		inbox = undefined;
	});

	pi.registerTool({
		name: "peer_list",
		label: "Peer list",
		description:
			"List the other omp sessions on this machine you can message with peer_send: their name, whether they are running now, and their working directory. Also says your own name.",
		parameters: z.object({}),
		approval: "read",
		async execute() {
			if (!inbox) throw new Error(NOT_JOINED);
			const you = inbox.name;
			const peers = transport
				.peers()
				.filter(peer => peer.name !== you)
				.map(peer => ({ name: peer.name, online: transport.isOnline(peer), cwd: peer.cwd }));
			return { content: [{ type: "text", text: JSON.stringify({ you, peers }, null, 2) }], details: { you, peers } };
		},
	});

	pi.registerTool({
		name: "peer_send",
		label: "Peer send",
		description:
			`Send a message to another omp session by name (see peer_list), or to '${BROADCAST}'. It appears in that session's conversation and wakes it if idle; ` +
			"a session that isn't running gets it when it next starts. Write a self-contained request: the other agent can't see your conversation. " +
			"Don't send acknowledgements or thanks.",
		parameters: z.object({
			to: z.string().describe(`Peer name from peer_list, or '${BROADCAST}' for every peer.`),
			message: z.string().describe("The message, written for an agent that can't see your conversation."),
			reply_to: z.string().optional().describe("Id of the message you are answering."),
		}),
		approval: "write",
		// The published typings don't infer zod schemas into `params`; this matches the schema above.
		async execute(_toolCallId, params: { to: string; message: string; reply_to?: string }) {
			if (!inbox) throw new Error(NOT_JOINED);
			const sent = transport.send(inbox.name, params.to, params.message, params.reply_to);
			const recipients = sent.map(message => message.to);
			const ids = sent.map(message => message.id);
			return {
				content: [{ type: "text", text: `Sent to ${recipients.join(", ")} (id ${ids.join(", ")}).` }],
				details: { recipients, ids },
			};
		},
	});

	pi.registerCommand("peer-name", {
		description: "Show or change this session's peer-mail name: /peer-name [new-name]",
		handler: async (args, ctx) => {
			if (!inbox) {
				ctx.ui.notify(`peer-mail: ${NOT_JOINED}`, "warning");
				return;
			}
			try {
				const wanted = args.trim();
				const name = wanted ? inbox.rename(wanted) : inbox.name;
				showName(ctx, name);
				ctx.ui.notify(`peer-mail: you are ${name}`, "info");
			} catch (error) {
				ctx.ui.notify(`peer-mail: ${(error as Error).message}`, "error");
			}
		},
	});
}
