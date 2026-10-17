/**
 * Relaying the user's own words: a member may attach a quote to its mail only if the user really
 * said it in that member's session (a message the user sent, or an answer the user gave in a
 * question box). The recipient is told the quote is the user's, checked by peer-mail rather than
 * typed by the sending agent, so it can act on the user's instruction or approval.
 */
import type { ReadonlySessionManager } from "@oh-my-pi/pi-coding-agent";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";

/** Collapse whitespace so line wrapping doesn't decide whether a quote matches. */
function normalize(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function textOf(content: string | readonly { type: string; text?: string }[]): string {
	if (typeof content === "string") return content;
	return content.map(part => (part.type === "text" && part.text ? part.text : "")).join("\n");
}

/**
 * What the user said in `message`, if it is the user's: a message they sent (prompts an extension
 * sends for the session, like a spawned agent's task, are attributed to the agent) or an answer
 * they gave in a question box.
 */
export function userSaid(message: AgentMessage): { words: string; how: "said" | "answered" } | undefined {
	if (message.role === "user" && message.attribution !== "agent") return { words: textOf(message.content), how: "said" };
	if (message.role === "toolResult" && message.toolName === "ask" && !message.isError) return { words: textOf(message.content), how: "answered" };
	return undefined;
}

/** Everything the user said in this session. */
export function userWords(session: ReadonlySessionManager): string[] {
	return session.getBranch().flatMap(entry => {
		const said = entry.type === "message" ? userSaid(entry.message) : undefined;
		return said ? [said.words] : [];
	});
}

/**
 * `quote` as the user's words, or an error naming why it can't be relayed. It must appear verbatim
 * (whitespace aside) in something the user said in this session.
 */
export function verifiedQuote(session: ReadonlySessionManager, quote: string): string {
	const wanted = normalize(quote);
	if (wanted.length === 0) throw new Error("user_quote is empty.");
	if (!userWords(session).some(text => normalize(text).includes(wanted))) {
		throw new Error(
			"user_quote must be the user's own words, copied exactly from a message they sent you or an answer they gave in a question box. " +
				"It doesn't match anything the user said in this session.",
		);
	}
	return wanted;
}
