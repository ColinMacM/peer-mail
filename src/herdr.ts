/**
 * herdr through its CLI: opening a pane for a new agent in the hub's swarm workspace, and focusing
 * a member's agent from the graph view.
 *
 * A hub running inside herdr (HERDR_ENV=1) keeps its own tab as it is: its agents go to a
 * workspace of their own, created on the first spawn and labelled after the swarm and the hub.
 * Later spawns split the largest pane there, along its longer side; when no pane is big enough to
 * halve, the agent gets a new tab in that workspace. Spawns are placed one at a time, so a hub that
 * spawns several agents at once fills one workspace. `herdr agent start` launches omp in the pane
 * and names it, so the name follows the agent if the user moves its pane.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import type { SplitDirection } from "./kitty";
import type { HerdrPane } from "./transport";

const BIN = process.env.HERDR_BIN_PATH || "herdr";
/** Below this a split would leave a pane too small to work in. */
const MIN_COLUMNS = 60;
const MIN_ROWS = 12;
/** A terminal cell is about twice as tall as it is wide: a pane this many columns per row or more looks wide. */
const WIDE_RATIO = 2;
/** herdr agent names: a lowercase letter, then lowercase letters, digits, '_' or '-', at most 32. */
const AGENT_NAME_MAX = 32;
/**
 * How long `agent start` waits for omp to be ready. A spawned agent starts on its task at once, so
 * herdr rarely sees it idle; past this omp is named once herdr has found it in the pane.
 */
const START_TIMEOUT_MS = 10_000;
/** How long omp may take to show up in its pane after `agent start` gave up waiting. */
const DETECT_TIMEOUT_MS = 30_000;
/** The variable that tells a spawned session its herdr agent name, for its peer entry. */
export const HERDR_AGENT_ENV = "PEER_MAIL_HERDR_AGENT";

export class HerdrError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

/** Run a herdr API command against `socket` (default: this session's server) and return its `result`. */
async function herdr(args: string[], socket?: string): Promise<Record<string, any>> {
	const env = socket ? { ...process.env, HERDR_SOCKET_PATH: socket } : process.env;
	const child = Bun.spawn([BIN, ...args], { stdout: "pipe", stderr: "pipe", env });
	const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	if (code !== 0) {
		let error: { code?: string; message?: string } | undefined;
		try {
			error = JSON.parse(stderr).error;
		} catch {
			// Not JSON: a CLI syntax error or a crash; the raw text says what happened.
		}
		throw new HerdrError(error?.code ?? "failed", `herdr ${args.slice(0, 2).join(" ")} failed: ${error?.message ?? (stderr.trim() || `exit ${code}`)}`);
	}
	return JSON.parse(stdout).result;
}

/** Whether this session runs in a herdr pane whose server it can reach. */
export function inHerdr(): boolean {
	return process.env.HERDR_ENV === "1" && !!process.env.HERDR_SOCKET_PATH && !!process.env.HERDR_PANE_ID;
}

/** This session's herdr pane, when it runs in one. */
export function currentHerdrPane(): HerdrPane | undefined {
	if (!inHerdr()) return undefined;
	const agent = process.env[HERDR_AGENT_ENV];
	return { socket: process.env.HERDR_SOCKET_PATH as string, pane: process.env.HERDR_PANE_ID as string, ...(agent ? { agent } : {}) };
}

/** A pane's size in cells. */
export interface PaneSize {
	pane: string;
	width: number;
	height: number;
}

/**
 * The pane to split for a new agent and the direction: the largest pane (ties to the first),
 * along its longer side unless `direction` says otherwise. Undefined when the split would leave a
 * half below MIN_COLUMNS × MIN_ROWS, so the agent should get a tab of its own instead.
 */
export function choosePane(panes: PaneSize[], direction: SplitDirection): { pane: string; direction: "right" | "down" } | undefined {
	let best: PaneSize | undefined;
	for (const pane of panes) if (!best || pane.width * pane.height > best.width * best.height) best = pane;
	if (!best) return undefined;
	const right = Math.floor(best.width / 2) >= MIN_COLUMNS;
	const down = Math.floor(best.height / 2) >= MIN_ROWS;
	const wide = best.width >= WIDE_RATIO * best.height;
	const wanted = direction === "vertical" ? "right" : direction === "horizontal" ? "down" : wide ? "right" : "down";
	if (wanted === "right" ? right : down) return { pane: best.pane, direction: wanted };
	// Auto falls back to the other side; an axis the hub asked for is kept, in a new tab.
	if (direction === "auto" && (wanted === "right" ? down : right)) return { pane: best.pane, direction: wanted === "right" ? "down" : "right" };
	return undefined;
}

/** A swarm member's name as a herdr agent name, `-2`, `-3`… added when `attempt` > 1. */
export function herdrAgentName(name: string, attempt = 1): string {
	let base = name.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
	if (!/^[a-z]/.test(base)) base = `a-${base}`;
	const suffix = attempt > 1 ? `-${attempt}` : "";
	return `${base.slice(0, AGENT_NAME_MAX - suffix.length)}${suffix}`;
}

export interface AgentPaneOptions {
	/** The member's name in the swarm; its herdr agent name is derived from it. */
	name: string;
	/** omp's arguments. */
	args: string[];
	cwd: string;
	env: Record<string, string>;
	/** The swarm workspace's label, used when it has to be created. */
	label: string;
	direction: SplitDirection;
	/** herdr agent names of the hub's running agents on this server: where its workspace is after a restart. */
	agents: string[];
}

export interface AgentPane {
	workspace: string;
	pane: string;
	agent: string;
	/** Set when omp started but herdr saw it waiting for input (a dialog) rather than ready. */
	notReady?: boolean;
}

/** The swarm workspace each label's agents went to in this process, so spawns find it before their agents have joined. */
const workspaces = new Map<string, string>();
/** The placement under way; the next one waits for it. */
let placing: Promise<unknown> = Promise.resolve();

/** The hub's swarm workspace if it still exists: the one this process last used, else where its agents are. */
async function swarmWorkspace(options: AgentPaneOptions): Promise<string | undefined> {
	const known = workspaces.get(options.label);
	if (known) {
		try {
			await herdr(["workspace", "get", known]);
			return known;
		} catch (error) {
			if (!(error instanceof HerdrError)) throw error; // the user closed it
			workspaces.delete(options.label);
		}
	}
	for (const name of options.agents) {
		try {
			const { agent } = await herdr(["agent", "get", name]);
			if (agent.workspace_id !== process.env.HERDR_WORKSPACE_ID) return agent.workspace_id;
		} catch (error) {
			if (!(error instanceof HerdrError)) throw error; // gone or renamed: no clue where the workspace is
		}
	}
	return undefined;
}

/** Open a pane in the hub's swarm workspace and start omp in it as a named herdr agent. */
export function openAgentPane(options: AgentPaneOptions): Promise<AgentPane> {
	const placed = placing.then(() => placeAgent(options));
	placing = placed.catch(() => undefined);
	return placed;
}

async function placeAgent(options: AgentPaneOptions): Promise<AgentPane> {
	const workspace = await swarmWorkspace(options);
	let target: { pane: string; direction: "right" | "down" } | undefined;
	if (workspace) {
		const sizes: PaneSize[] = [];
		const { panes } = await herdr(["pane", "list", "--workspace", workspace]);
		for (const tab of new Set<string>(panes.map((pane: { tab_id: string }) => pane.tab_id))) {
			const first = panes.find((pane: { tab_id: string }) => pane.tab_id === tab);
			const { layout } = await herdr(["pane", "layout", "--pane", first.pane_id]);
			for (const item of layout.panes) sizes.push({ pane: item.pane_id, width: item.rect.width, height: item.rect.height });
		}
		target = choosePane(sizes, options.direction);
	}
	const agent = await freeAgentName(options.name);
	const common = ["--cwd", options.cwd, ...Object.entries({ ...options.env, [HERDR_AGENT_ENV]: agent }).flatMap(([key, value]) => ["--env", `${key}=${value}`]), "--no-focus"];
	const opened = target
		? (await herdr(["pane", "split", target.pane, "--direction", target.direction, ...common])).pane
		: workspace
			? (await herdr(["tab", "create", "--workspace", workspace, "--label", options.name, ...common])).root_pane
			: (await herdr(["workspace", "create", "--label", options.label, ...common])).root_pane;
	const placement = { workspace: opened.workspace_id as string, pane: opened.pane_id as string, agent };
	workspaces.set(options.label, placement.workspace);
	try {
		await herdr(["agent", "start", agent, "--kind", "omp", "--pane", placement.pane, "--timeout", String(START_TIMEOUT_MS), "--", ...options.args]);
		return placement;
	} catch (error) {
		if (!(error instanceof HerdrError)) throw error;
		if (error.code === "agent_not_ready") return { ...placement, notReady: true };
		if (error.code === "timeout" && (await ompArrived(placement.pane))) {
			await herdr(["agent", "rename", placement.pane, agent]);
			return placement;
		}
		await herdr(["pane", "close", placement.pane]);
		throw error;
	}
}

/** The first of `name`, `name-2`, … that no live herdr agent holds. */
async function freeAgentName(name: string): Promise<string> {
	for (let attempt = 1; ; attempt++) {
		const candidate = herdrAgentName(name, attempt);
		try {
			await herdr(["agent", "get", candidate]);
		} catch (error) {
			if (error instanceof HerdrError && error.code === "agent_not_found") return candidate;
			throw error;
		}
	}
}

/** Whether herdr finds omp running in `pane` within DETECT_TIMEOUT_MS. */
async function ompArrived(pane: string): Promise<boolean> {
	const deadline = Date.now() + DETECT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if ((await herdr(["pane", "get", pane])).pane.agent === "omp") return true;
		await Bun.sleep(500);
	}
	return false;
}

/** Bring a member's herdr pane to the front: its workspace, its tab and the pane. */
export async function focusPane(target: HerdrPane): Promise<void> {
	await herdr(["agent", "focus", target.agent ?? target.pane], target.socket);
}

/** The herdr plugin this directory is (herdr-plugin.toml), and its view pane: Blueprint, in view/. */
const VIEW_PLUGIN = "peer-mail.view";

/** Which pane shows a herdr workspace's swarm view, and the hub it follows (by pid, so renames don't lose it). */
export interface ViewRecord {
	pane: string;
	hubPid: number;
}

/** Where the view of a herdr workspace is recorded: beside the mailbox, outside the swarm directory /startswarm clears. */
export function viewRecordPath(root: string, socket: string, workspace: string): string {
	const server = createHash("sha256").update(socket).digest("hex").slice(0, 8);
	return path.join(root, "views", `${server}-${workspace.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
}

/**
 * Open the swarm view to the right of the hub's pane `beside`, keeping focus where it is. Returns
 * its pane id. Blueprint sends a note about a box to the pane it was opened next to: the hub.
 */
export async function openViewPane(beside: string, env: Record<string, string>): Promise<string> {
	const envArgs = Object.entries({ ...env, BLUEPRINT_SOURCE_PANE: beside }).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
	const result = await herdr([
		"plugin", "pane", "open", "--plugin", VIEW_PLUGIN, "--entrypoint", "view", "--placement", "split",
		"--direction", "right", "--target-pane", beside, ...envArgs, "--no-focus",
	]);
	return result.plugin_pane.pane.pane_id;
}

/** Bring a plugin pane (the swarm view) to the front. */
export async function focusPluginPane(pane: string): Promise<void> {
	await herdr(["plugin", "pane", "focus", pane]);
}

/** Whether `pane` still exists on this session's herdr server. */
export async function paneExists(pane: string): Promise<boolean> {
	try {
		await herdr(["pane", "get", pane]);
		return true;
	} catch (error) {
		if (error instanceof HerdrError && error.code === "pane_not_found") return false;
		throw error;
	}
}
