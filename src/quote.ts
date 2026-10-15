/**
 * Relaying the user's own words: a member may attach a quote to its mail only if the user really
 * said it in that member's session (a message the user sent, or an answer the user gave in a
 * question box). The recipient is told the quote is the user's, checked by peer-mail rather than
 * typed by the sending agent, so it can act on the user's instruction or approval.
 */
import type { ReadonlySessionManager } from "@oh-my-pi/pi-coding-agent";

/** Collapse whitespace so line wrapping doesn't decide whether a quote matches. */
function normalize(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function textOf(content: string | readonly { type: string; text?: string }[]): string {
	if (typeof content === "string") return content;
	return content.map(part => (part.type === "text" && part.text ? part.text : "")).join("\n");
}

/** Everything the user said in this session: their own messages and their question-box answers. */
export function userWords(session: ReadonlySessionManager): string[] {
	const words: string[] = [];
	for (const entry of session.getBranch()) {
		if (entry.type !== "message") continue;
		const { message } = entry;
		// Prompts an extension sends for the session (a spawned agent's task) are attributed to the agent.
		if (message.role === "user" && message.attribution !== "agent") words.push(textOf(message.content));
		if (message.role === "toolResult" && message.toolName === "ask" && !message.isError) words.push(textOf(message.content));
	}
	return words;
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
