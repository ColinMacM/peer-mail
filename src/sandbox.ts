/**
 * The sandbox a spawned agent's commands run in (macOS sandbox-exec), so it can't set up its own
 * way of talking to other agents. Inside it nothing can listen on a socket (TCP, UDP or unix),
 * read or write the peer-mail directory (so neither the mailbox files nor the peer-mail CLI work),
 * drive kitty over its remote-control socket, or reach the graph view's server.
 * Outbound network, the repo and everything else work as usual.
 */
import fs from "node:fs";
import path from "node:path";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
/** Variables that point at the swarm or at kitty; a sandboxed command doesn't get them. */
const SWARM_ENV = ["KITTY_LISTEN_ON", "KITTY_WINDOW_ID", "KITTY_PID", "PEER_MAIL_DIR", "PEER_MAIL_SPAWN", "PEER_MAIL_NAME"];

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
		`(deny network-outbound (remote tcp "localhost:${graphPort}"))`,
		// kitty's own socket, and any other kitty instance's default one.
		'(deny network-outbound (remote unix-socket (path-regex #"^/private/tmp/kitty")))',
	];
	const kitty = /^unix:(\/.+)$/.exec(process.env.KITTY_LISTEN_ON ?? "")?.[1];
	if (kitty) rules.push(`(deny network-outbound (remote unix-socket (path-literal ${JSON.stringify(realPath(kitty))})))`);
	return rules.join("\n");
}

/** The argv that runs `command` with bash inside the sandbox, without the swarm's environment. */
export function sandboxedArgv(command: string, profile: string): string[] {
	return ["/usr/bin/env", ...SWARM_ENV.flatMap(name => ["-u", name]), SANDBOX_EXEC, "-p", profile, "/bin/bash", "-c", command];
}

/** `command` rewritten as a shell command line that runs it inside the sandbox. */
export function sandboxedCommand(command: string, profile: string): string {
	return sandboxedArgv(command, profile).map(quote).join(" ");
}
