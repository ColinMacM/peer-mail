#!/usr/bin/env bun
/**
 * peer-mail from a shell: see the swarm and its members, message a member, read what one received.
 *
 *   peer-mail list                        the swarm's label, and its members with mail waiting
 *   peer-mail send <to|all> <message…>    sent as "human"
 *   peer-mail history <name> [--limit N]
 *   peer-mail graph [--port N]            serve the graph view (stops a minute after its page closes)
 *
 * Uses the same directory as the extension (PEER_MAIL_DIR, default ~/.omp/peer-mail).
 */
import { parseArgs } from "node:util";
import { DEFAULT_GRAPH_PORT, serveGraph } from "./graph";
import { HUMAN, type Phase, Swarm } from "./transport";
import { codeVersion } from "./version";

const USAGE = `usage:
  peer-mail list
  peer-mail send <to|all> <message...>
  peer-mail history <name> [--limit N]
  peer-mail graph [--port N]`;

const { positionals, values } = parseArgs({
	allowPositionals: true,
	options: { limit: { type: "string", default: "20" }, port: { type: "string", default: String(DEFAULT_GRAPH_PORT) } },
});
const [command, ...rest] = positionals;
const swarm = new Swarm();

function formatTime(ms: number): string {
	return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

function runSwarmCommand(phase: Phase): void {
	switch (command) {
		case "list": {
			console.log(`swarm ${phase.label}, started ${formatTime(phase.startedAt)} by ${phase.startedBy}`);
			const current = codeVersion();
			for (const peer of swarm.peers()) {
				const state = swarm.isOnline(peer) ? (peer.finished ? "finished" : "online  ") : "offline ";
				const waiting = swarm.pending(peer.name);
				const place = peer.hub === null ? "hub" : `agent of ${peer.hub}`;
				const old = swarm.isOnline(peer) && peer.plugin !== current ? "OLD CODE (restart)  " : "";
				console.log(`  ${peer.name.padEnd(20)} ${state}  ${place.padEnd(20)} ${waiting ? `${waiting} waiting  ` : ""}${old}${peer.status ? `"${peer.status}"  ` : ""}${peer.cwd}`);
			}
			return;
		}
		case "send": {
			const [to, ...words] = rest;
			if (!to || words.length === 0) throw new Error(USAGE);
			for (const message of swarm.send(HUMAN, phase.id, to, words.join(" "))) {
				console.log(`sent to ${message.to} (id ${message.id})`);
			}
			return;
		}
		case "history": {
			const [name] = rest;
			if (!name) throw new Error(USAGE);
			for (const message of swarm.history(name, Number(values.limit))) {
				console.log(`[${formatTime(message.sentAt)}] ${message.from} → ${message.to}  (${message.id})\n${message.body}\n`);
			}
			return;
		}
		default:
			throw new Error(USAGE);
	}
}

try {
	if (command === "graph") {
		serveGraph(swarm, Number(values.port));
	} else {
		const phase = swarm.phase();
		if (!phase) throw new Error("No swarm is running.");
		runSwarmCommand(phase);
	}
} catch (error) {
	console.error((error as Error).message);
	process.exit(1);
}
