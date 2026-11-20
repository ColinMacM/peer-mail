#!/usr/bin/env bun
/**
 * peer-mail from a shell: see the swarms and their members, message a member, read what one received.
 *
 *   peer-mail list [--swarm L]                     each swarm's label, and its members with mail waiting
 *   peer-mail send [--swarm L] <to|all> <message…> sent as "human"
 *   peer-mail history [--swarm L] <name> [--limit N]
 *   peer-mail graph [--port N]                     serve the graph view (stops a minute after its page closes)
 *
 * `--swarm` names a swarm by its label; send and history need it when there are several.
 * Uses the same directory as the extension (PEER_MAIL_DIR, default ~/.omp/peer-mail).
 */
import { parseArgs } from "node:util";
import { DEFAULT_GRAPH_PORT, serveGraph } from "./graph";
import { HUMAN, type Phase, Swarm } from "./transport";
import { codeVersion } from "./version";

const USAGE = `usage:
  peer-mail list [--swarm LABEL]
  peer-mail send [--swarm LABEL] <to|all> <message...>
  peer-mail history [--swarm LABEL] <name> [--limit N]
  peer-mail graph [--port N]`;

const { positionals, values } = parseArgs({
	allowPositionals: true,
	options: {
		limit: { type: "string", default: "20" },
		port: { type: "string", default: String(DEFAULT_GRAPH_PORT) },
		swarm: { type: "string" },
	},
});
const [command, ...rest] = positionals;

function formatTime(ms: number): string {
	return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

/** The swarms a command acts on: the one --swarm names, else all of them. */
function chosen(): Swarm[] {
	if (values.swarm) {
		const swarm = Swarm.named(values.swarm);
		if (!swarm.phase()) throw new Error(`No swarm "${values.swarm}".`);
		return [swarm];
	}
	const swarms = Swarm.all();
	if (swarms.length === 0) throw new Error("No swarm is running.");
	return swarms;
}

/** The one swarm a command acts on. */
function one(): { swarm: Swarm; phase: Phase } {
	const swarms = chosen();
	if (swarms.length > 1) throw new Error(`There are several swarms (${swarms.map(swarm => swarm.phase()?.label).join(", ")}): pick one with --swarm.`);
	return { swarm: swarms[0], phase: swarms[0].phase() as Phase };
}

function list(swarm: Swarm, phase: Phase): void {
	console.log(`swarm ${phase.label}, started ${formatTime(phase.startedAt)} by ${phase.startedBy}`);
	const current = codeVersion();
	for (const peer of swarm.peers()) {
		const state = swarm.isOnline(peer) ? (peer.finished ? "finished" : "online  ") : "offline ";
		const waiting = swarm.pending(peer.name);
		const place = peer.hub === null ? "hub" : `agent of ${peer.hub}`;
		const old = swarm.isOnline(peer) && peer.plugin !== current ? "OLD CODE (restart)  " : "";
		console.log(`  ${peer.name.padEnd(20)} ${state}  ${place.padEnd(20)} ${waiting ? `${waiting} waiting  ` : ""}${old}${peer.status ? `"${peer.status}"  ` : ""}${peer.cwd}`);
	}
}

function run(): void {
	switch (command) {
		case "graph":
			serveGraph(undefined, Number(values.port));
			return;
		case "list":
			for (const swarm of chosen()) list(swarm, swarm.phase() as Phase);
			return;
		case "send": {
			const [to, ...words] = rest;
			if (!to || words.length === 0) throw new Error(USAGE);
			const { swarm, phase } = one();
			for (const message of swarm.send(HUMAN, phase.id, to, words.join(" "))) {
				console.log(`sent to ${message.to} (id ${message.id})`);
			}
			return;
		}
		case "history": {
			const [name] = rest;
			if (!name) throw new Error(USAGE);
			for (const message of one().swarm.history(name, Number(values.limit))) {
				console.log(`[${formatTime(message.sentAt)}] ${message.from} → ${message.to}  (${message.id})\n${message.body}\n`);
			}
			return;
		}
		default:
			throw new Error(USAGE);
	}
}

try {
	run();
} catch (error) {
	console.error((error as Error).message);
	process.exit(1);
}
