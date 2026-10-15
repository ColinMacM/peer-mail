/**
 * kitty through its remote control socket: opening a split next to this session's window, and
 * focusing a member's window from the graph view.
 *
 * Needs kitty.conf to have `allow_remote_control yes` and `listen_on unix:/tmp/kitty` (kitty
 * appends its pid), and kitty restarted once after adding them: kitty then gives every window
 * KITTY_LISTEN_ON. Without the socket, `kitty @` would have to talk over the terminal, which the
 * running omp UI owns.
 */
import type { KittyWindow } from "./transport";

export type SplitDirection = "auto" | "vertical" | "horizontal";

const LOCATION: Record<SplitDirection, string> = { auto: "split", vertical: "vsplit", horizontal: "hsplit" };

/** This session's kitty window, when it runs in a kitty that has a remote-control socket. */
export function currentKittyWindow(): KittyWindow | undefined {
	const window = Number(process.env.KITTY_WINDOW_ID);
	const socket = process.env.KITTY_LISTEN_ON;
	return window && socket ? { window, socket } : undefined;
}

async function kittyRemote(socket: string, args: string[]): Promise<string> {
	const child = Bun.spawn(["kitty", "@", "--to", socket, ...args], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(`kitty @ ${args[0]} failed: ${stderr.trim() || stdout.trim() || `exit ${code}`}`);
	return stdout;
}

/** Bring a member's kitty window to the front: its tab, its OS window, and kitty itself. */
export async function focusWindow(target: KittyWindow): Promise<void> {
	await kittyRemote(target.socket, ["focus-window", "--match", `id:${target.window}`]);
	if (process.platform === "darwin") await Bun.spawn(["osascript", "-e", 'tell application "kitty" to activate']).exited;
}

export interface SplitOptions {
	command: string[];
	cwd: string;
	title: string;
	env: Record<string, string>;
	direction: SplitDirection;
}

/** Why a split can't be opened from this session, or undefined when it can. */
export function splitUnavailable(): string | undefined {
	if (!process.env.KITTY_WINDOW_ID) return "This session isn't running inside kitty.";
	if (!process.env.KITTY_LISTEN_ON) {
		return (
			"kitty remote control has no socket. Add `allow_remote_control yes` and `listen_on unix:/tmp/kitty` " +
			"to ~/.config/kitty/kitty.conf, quit kitty completely and start it again."
		);
	}
	return undefined;
}

/** Open `command` in a new split beside this session's window, keeping focus here. Returns the new window's id. */
export async function openSplit(options: SplitOptions): Promise<number> {
	const unavailable = splitUnavailable();
	if (unavailable) throw new Error(unavailable);
	const windowId = process.env.KITTY_WINDOW_ID as string;
	const stdout = await kittyRemote(process.env.KITTY_LISTEN_ON as string, [
		"launch",
		"--type=window",
		// --match picks the tab (the one holding this window); --next-to the window to split.
		"--match",
		`window_id:${windowId}`,
		"--next-to",
		`id:${windowId}`,
		`--location=${LOCATION[options.direction]}`,
		"--keep-focus",
		"--cwd",
		options.cwd,
		"--title",
		options.title,
		...Object.entries(options.env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
		...options.command,
	]);
	return Number(stdout.trim());
}
