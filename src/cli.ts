#!/usr/bin/env bun
/**
 * peer-mail from a shell: see the swarms and their members, message a member, read what one received.
 *
 *   peer-mail swarms
 *   peer-mail list <swarm>
 *   peer-mail send <swarm> <to|all> <message…>     (sent as "human")
 *   peer-mail history <swarm> <name> [--limit N]
 *
 * Uses the same directory as the extension (PEER_MAIL_DIR, default ~/.omp/peer-mail).
 */
import { parseArgs } from "node:util";
import { HUMAN, listSwarms, Swarm } from "./transport";

const USAGE = `usage:
  peer-mail swarms
  peer-mail list <swarm>
  peer-mail send <swarm> <to|all> <message...>
  peer-mail history <swarm> <name> [--limit N]`;

const { positionals, values } = parseArgs({
	allowPositionals: true,
	options: { limit: { type: "string", default: "20" } },
});
const [command, swarmName, ...rest] = positionals;

try {
	if (command === "swarms") {
		const names = listSwarms();
		if (names.length === 0) console.log("No swarms yet.");
		for (const name of names) {
			const swarm = new Swarm(name);
			const peers = swarm.peers();
			const online = peers.filter(peer => swarm.isOnline(peer)).length;
			const started = new Date(swarm.phase()?.startedAt ?? 0).toISOString().replace("T", " ").slice(0, 19);
			console.log(`${name.padEnd(28)} ${online}/${peers.length} online  started ${started}`);
		}
	} else {
		if (!swarmName) throw new Error(USAGE);
		const swarm = new Swarm(swarmName);
		const phase = swarm.phase();
		if (!phase) throw new Error(`No swarm called "${swarmName}".`);
		switch (command) {
			case "list": {
				const peers = swarm.peers();
				if (peers.length === 0) console.log("No members.");
				for (const peer of peers) {
					const state = swarm.isOnline(peer) ? "online " : "offline";
					const waiting = swarm.pending(peer.name);
					console.log(`${peer.name.padEnd(24)} ${state}  ${waiting ? `${waiting} waiting  ` : ""}${peer.cwd}`);
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
	}
} catch (error) {
	console.error((error as Error).message);
	process.exit(1);
}
