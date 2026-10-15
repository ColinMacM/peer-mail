#!/usr/bin/env bun
/**
 * peer-mail from a shell: see who has joined, message a session, read what a session received.
 *
 *   peer-mail list
 *   peer-mail send <to|all> <message…> [--from <name>]    (default sender: human)
 *   peer-mail history <name> [--limit N]
 *
 * Uses the same directory as the extension (PEER_MAIL_DIR, default ~/.omp/peer-mail).
 */
import { parseArgs } from "node:util";
import { HUMAN, Transport } from "./transport";

const USAGE = `usage:
  peer-mail list
  peer-mail send <to|all> <message...> [--from <name>]
  peer-mail history <name> [--limit N]`;

const { positionals, values } = parseArgs({
	allowPositionals: true,
	options: { from: { type: "string", default: HUMAN }, limit: { type: "string", default: "20" } },
});
const [command, ...rest] = positionals;
const transport = new Transport();

try {
	switch (command) {
		case "list": {
			const peers = transport.peers();
			if (peers.length === 0) console.log("No peers have joined yet.");
			for (const peer of peers) {
				const state = transport.isOnline(peer) ? "online " : "offline";
				const waiting = transport.pending(peer.name);
				console.log(`${peer.name.padEnd(24)} ${state}  ${waiting ? `${waiting} waiting  ` : ""}${peer.cwd}`);
			}
			break;
		}
		case "send": {
			const [to, ...words] = rest;
			if (!to || words.length === 0) throw new Error(USAGE);
			for (const message of transport.send(values.from, to, words.join(" "))) {
				console.log(`sent to ${message.to} (id ${message.id})`);
			}
			break;
		}
		case "history": {
			const [name] = rest;
			if (!name) throw new Error(USAGE);
			for (const message of transport.history(name, Number(values.limit))) {
				const when = new Date(message.sentAt).toISOString().replace("T", " ").slice(0, 19);
				console.log(`[${when}] ${message.from} → ${message.to}  (${message.id})\n${message.body}\n`);
			}
			break;
		}
		default:
			throw new Error(USAGE);
	}
} catch (error) {
	console.error((error as Error).message);
	process.exit(1);
}
