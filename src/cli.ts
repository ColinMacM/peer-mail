#!/usr/bin/env bun
/**
 * peer-mail from a shell: see the swarm and its members, message a member, read what one received.
 *
 *   peer-mail list                        the swarm's label, and its members with mail waiting
 *   peer-mail send <to|all> <message…>    sent as "human"
 *   peer-mail history <name> [--limit N]
 *
 * Uses the same directory as the extension (PEER_MAIL_DIR, default ~/.omp/peer-mail).
 */
import { parseArgs } from "node:util";
import { HUMAN, Swarm } from "./transport";

const USAGE = `usage:
  peer-mail list
  peer-mail send <to|all> <message...>
  peer-mail history <name> [--limit N]`;

const { positionals, values } = parseArgs({
	allowPositionals: true,
	options: { limit: { type: "string", default: "20" } },
});
const [command, ...rest] = positionals;
const swarm = new Swarm();

try {
	const phase = swarm.phase();
	if (!phase) throw new Error("No swarm is running.");
	switch (command) {
		case "list": {
			const started = new Date(phase.startedAt).toISOString().replace("T", " ").slice(0, 19);
			console.log(`swarm ${phase.label}, started ${started} by ${phase.startedBy}`);
			for (const peer of swarm.peers()) {
				const state = swarm.isOnline(peer) ? "online " : "offline";
				const waiting = swarm.pending(peer.name);
				console.log(`  ${peer.name.padEnd(24)} ${state}  ${waiting ? `${waiting} waiting  ` : ""}${peer.cwd}`);
			}
			break;
		}
		case "send": {
			const [to, ...words] = rest;
			if (!to || words.length === 0) throw new Error(USAGE);
			for (const message of swarm.send(HUMAN, phase.id, to, words.join(" "))) {
				console.log(`sent to ${message.to} (id ${message.id})`);
			}
			break;
		}
		case "history": {
			const [name] = rest;
			if (!name) throw new Error(USAGE);
			for (const message of swarm.history(name, Number(values.limit))) {
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
