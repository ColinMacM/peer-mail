/**
 * The graph view: a page on 127.0.0.1 that draws the swarm (hubs, their agents, the edges mail can
 * travel) live from the mail directory. Clicking a member brings its omp session's kitty window to
 * the front. The server stops by itself once no page has asked it anything for IDLE_EXIT_MS.
 */
import { focusWindow } from "./kitty";
import { type Message, Swarm } from "./transport";

export const DEFAULT_GRAPH_PORT = Number(process.env.PEER_MAIL_GRAPH_PORT) || 7577;
/** The page polls every 1.5 s, so a minute of silence means no page is open. */
const IDLE_EXIT_MS = 60_000;
const RECENT_MESSAGES = 40;

export interface GraphNode {
	name: string;
	hub: string | null;
	online: boolean;
	pending: number;
	cwd: string;
	/** Whether clicking can focus it: it runs, in a kitty with a remote-control socket. */
	focusable: boolean;
}

export interface GraphState {
	label: string | null;
	startedAt: number | null;
	nodes: GraphNode[];
	/** Pairs that can message each other: each agent with its hub, and every pair of hubs. */
	edges: [string, string][];
	messages: Message[];
}

export function graphState(swarm: Swarm): GraphState {
	const phase = swarm.phase();
	const peers = swarm.peers();
	const nodes = peers.map(peer => {
		const online = swarm.isOnline(peer);
		return { name: peer.name, hub: peer.hub, online, pending: swarm.pending(peer.name), cwd: peer.cwd, focusable: online && !!peer.kitty };
	});
	const hubs = nodes.filter(node => node.hub === null).map(node => node.name);
	const edges: [string, string][] = [];
	for (const node of nodes) if (node.hub !== null) edges.push([node.hub, node.name]);
	for (let i = 0; i < hubs.length; i++) for (let j = i + 1; j < hubs.length; j++) edges.push([hubs[i], hubs[j]]);
	const messages = peers
		.flatMap(peer => swarm.history(peer.name, RECENT_MESSAGES))
		.sort((a, b) => a.id.localeCompare(b.id))
		.slice(-RECENT_MESSAGES);
	return { label: phase?.label ?? null, startedAt: phase?.startedAt ?? null, nodes, edges, messages };
}

/** Serve the graph view on `port` until no page has polled it for a minute. */
export function serveGraph(swarm: Swarm, port = DEFAULT_GRAPH_PORT): void {
	const page = Bun.file(new URL("./graph.html", import.meta.url));
	let lastRequest = Date.now();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port,
		async fetch(request) {
			lastRequest = Date.now();
			const url = new URL(request.url);
			if (url.pathname === "/") return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
			if (url.pathname === "/health") return Response.json({ ok: true, app: "peer-mail-graph" });
			if (url.pathname === "/state") return Response.json(graphState(swarm));
			const focus = /^\/focus\/([^/]+)$/.exec(url.pathname);
			if (focus && request.method === "POST") {
				const peer = swarm.peer(decodeURIComponent(focus[1]));
				if (!peer || !swarm.isOnline(peer)) return Response.json({ error: "That agent isn't running." }, { status: 409 });
				if (!peer.kitty) return Response.json({ error: "That agent isn't in a kitty window this can reach." }, { status: 409 });
				try {
					await focusWindow(peer.kitty);
					return Response.json({ ok: true });
				} catch (error) {
					return Response.json({ error: (error as Error).message }, { status: 500 });
				}
			}
			return new Response("not found", { status: 404 });
		},
	});
	const timer = setInterval(() => {
		if (Date.now() - lastRequest < IDLE_EXIT_MS) return;
		clearInterval(timer);
		server.stop();
	}, 5_000);
	console.log(`peer-mail graph on http://127.0.0.1:${server.port}/`);
}

/** Whether a graph server already answers on `port`. */
export async function graphRunning(port = DEFAULT_GRAPH_PORT): Promise<boolean> {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
		const body: unknown = await response.json();
		return !!body && typeof body === "object" && "app" in body && body.app === "peer-mail-graph";
	} catch {
		return false;
	}
}
