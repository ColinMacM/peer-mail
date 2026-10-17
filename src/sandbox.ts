/**
 * The sandbox a spawned agent's commands run in (macOS sandbox-exec), so it can't set up its own
 * way of talking to other agents. Inside it nothing can listen on a socket (TCP, UDP or unix),
 * read or write the peer-mail directory (so neither the mailbox files nor the peer-mail CLI work),
 * drive kitty over its remote-control socket, reach the graph view's server, or change the
 * sandbox itself. Outbound network, the repo and everything else work as usual.
 *
 * A command runs as `/tmp/peer-mail-<uid>/sandbox-<hash> '<command>'`: a small script holding the
 * profile, so a sandboxed call reads as the command itself instead of the whole profile inline.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
/** Variables that point at the swarm or at kitty; a sandboxed command doesn't get them. */
const SWARM_ENV = ["KITTY_LISTEN_ON", "KITTY_WINDOW_ID", "KITTY_PID", "PEER_MAIL_DIR", "PEER_MAIL_SPAWN", "PEER_MAIL_NAME"];
/** Where the sandbox scripts and profiles live: this user's, and read-only from inside the sandbox. */
export const SANDBOX_DIR = `/tmp/peer-mail-${process.getuid?.() ?? "user"}`;

/** Why commands can't be sandboxed on this machine, or undefined when they can. */
export function sandboxUnavailable(): string | undefined {
	if (process.platform !== "darwin") return "Sandboxed runs need macOS (sandbox-exec); this machine can't run them.";
	if (!fs.existsSync(SANDBOX_EXEC)) return `Sandboxed runs need ${SANDBOX_EXEC}, which isn't on this machine.`;
	return undefined;
}

/** `file` with symlinks resolved as far as it exists (sandbox rules see real paths: /tmp is /private/tmp). */
export function realPath(file: string): string {
	const absolute = path.resolve(file);
	try {
		return fs.realpathSync(absolute);
	} catch {
		const parent = path.dirname(absolute);
		return parent === absolute ? absolute : path.join(realPath(parent), path.basename(absolute));
	}
}

function quote(text: string): string {
	return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** The sandbox-exec profile: everything allowed except the ways listed in the module comment. */
export function sandboxProfile(mailRoot: string, graphPort: number): string {
	const rules = [
		"(version 1)",
		"(allow default)",
		"(deny network-bind)",
		"(deny network-inbound)",
		`(deny file-read* file-write* (subpath ${JSON.stringify(realPath(mailRoot))}))`,
		`(deny file-write* (subpath ${JSON.stringify(realPath(SANDBOX_DIR))}))`,
		`(deny network-outbound (remote tcp "localhost:${graphPort}"))`,
		// kitty's own socket, and any other kitty instance's default one.
		'(deny network-outbound (remote unix-socket (path-regex #"^/private/tmp/kitty")))',
	];
	const kitty = /^unix:(\/.+)$/.exec(process.env.KITTY_LISTEN_ON ?? "")?.[1];
	if (kitty) rules.push(`(deny network-outbound (remote unix-socket (path-literal ${JSON.stringify(realPath(kitty))})))`);
	return rules.join("\n");
}

/** SANDBOX_DIR, created private to this user; refuses a directory someone else could have planted. */
function sandboxDir(): string {
	fs.mkdirSync(SANDBOX_DIR, { recursive: true, mode: 0o700 });
	const stat = fs.lstatSync(SANDBOX_DIR);
	if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) {
		throw new Error(`${SANDBOX_DIR} isn't a private directory of this user; remove it and retry.`);
	}
	return SANDBOX_DIR;
}

/** The script that runs its one argument with bash inside `profile`, without the swarm's environment. */
export function sandboxScript(profile: string): string {
	const dir = sandboxDir();
	const name = `sandbox-${createHash("sha256").update(profile).digest("hex").slice(0, 8)}`;
	const script = path.join(dir, name);
	const profileFile = `${script}.sb`;
	const body = [
		"#!/bin/bash",
		"# peer-mail: runs its argument with bash in the spawned agents' sandbox (src/sandbox.ts).",
		`exec /usr/bin/env ${SWARM_ENV.map(name => `-u ${name}`).join(" ")} ${SANDBOX_EXEC} -f ${quote(profileFile)} /bin/bash -c "$1"`,
		"",
	].join("\n");
	// Rewritten when missing or changed (anything unsandboxed could edit it; the sandbox can't).
	if (!fs.existsSync(profileFile) || fs.readFileSync(profileFile, "utf8") !== profile) fs.writeFileSync(profileFile, profile, { mode: 0o600 });
	if (!fs.existsSync(script) || fs.readFileSync(script, "utf8") !== body) fs.writeFileSync(script, body, { mode: 0o700 });
	return script;
}

/**
 * `command` as a shell command line that runs it inside the sandbox. A command already wrapped with
 * the same profile is returned unchanged: the `tool_call` hook can see a bash call more than once
 * (subagents share this module), and nesting `sandbox-exec` may be refused inside a sandbox.
 */
export function sandboxedCommand(command: string, profile: string): string {
	const script = sandboxScript(profile);
	if (command.startsWith(`${script} `)) return command;
	return `${script} ${quote(command)}`;
}
