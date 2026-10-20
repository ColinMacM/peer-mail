/**
 * The sandbox a spawned agent's commands run in, so it can't set up its own way of talking to
 * other agents. Inside it nothing can listen on a socket (TCP, UDP or unix), read or write the
 * peer-mail directory (so neither the mailbox files nor the peer-mail CLI work), drive kitty over
 * its remote-control socket, or change the sandbox itself. Outbound network, the repo and
 * everything else work as usual.
 *
 * macOS uses sandbox-exec, which also blocks outbound connections to the graph view's port.
 * Linux uses landlock (mailbox unreadable and unwritable, sandbox directory read-only) and a
 * seccomp filter that rejects bind and listen. When unprivileged user namespaces are allowed,
 * the same paths are also covered with a private mount namespace (tmpfs over the mailbox,
 * read-only bind of the sandbox directory, /dev/null over kitty's socket). Linux cannot deny a
 * single outbound TCP port without also denying other outbound connects, so the graph port stays
 * reachable there.
 *
 * A command runs as `/tmp/peer-mail-<uid>/sandbox-<hash> '<command>'`: a small script holding the
 * profile, so a sandboxed call reads as the command itself instead of the whole profile inline.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
/** Whether this machine can run the sandbox (macOS or Linux). */
export const SANDBOXED = process.platform === "darwin" || process.platform === "linux";
/** Variables that point at the swarm or at kitty; a sandboxed command doesn't get them. */
const SWARM_ENV = ["KITTY_LISTEN_ON", "KITTY_WINDOW_ID", "KITTY_PID", "PEER_MAIL_DIR", "PEER_MAIL_SPAWN", "PEER_MAIL_NAME"];
/** Where the sandbox scripts and profiles live: this user's, and read-only from inside the sandbox. */
export const SANDBOX_DIR = `/tmp/peer-mail-${process.getuid?.() ?? "user"}`;

/** seccomp(2) and bind/listen numbers the Linux helper installs. Same on every kernel of that arch. */
const LINUX_SYSCALLS: Record<string, { seccomp: number; bind: number; listen: number }> = {
	x64: { seccomp: 317, bind: 49, listen: 50 },
	arm64: { seccomp: 277, bind: 200, listen: 201 },
};

export interface LinuxPolicy {
	deny: string[];
	readonly: string[];
	sockets: string[];
	graphPort: number;
	seccomp: number;
	bind: number;
	listen: number;
}

/** `python3` on PATH, used to apply landlock and seccomp before exec. */
function pythonBin(): string | undefined {
	return Bun.which("python3") ?? undefined;
}

/** Why commands can't run on this machine, or undefined when they can. */
export function sandboxUnavailable(): string | undefined {
	if (process.platform === "darwin") {
		if (!fs.existsSync(SANDBOX_EXEC)) return `Sandboxed runs need ${SANDBOX_EXEC}, which isn't on this machine.`;
		return undefined;
	}
	if (process.platform === "linux") {
		const syscalls = LINUX_SYSCALLS[process.arch];
		if (!syscalls) return `Sandboxed runs on Linux need x64 or arm64 (this machine is ${process.arch}).`;
		if (!pythonBin()) return "Sandboxed runs on Linux need python3 on PATH to apply landlock and seccomp.";
		return undefined;
	}
	return "Sandboxed runs need macOS or Linux.";
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

function kittySocket(): string | undefined {
	const kitty = /^unix:(\/.+)$/.exec(process.env.KITTY_LISTEN_ON ?? "")?.[1];
	return kitty ? realPath(kitty) : undefined;
}

/** Paths and syscall numbers the Linux helper enforces. `graphPort` is recorded for the macOS profile's counterpart; Linux does not filter it. */
export function linuxPolicy(mailRoot: string, graphPort: number): LinuxPolicy {
	const syscalls = LINUX_SYSCALLS[process.arch] ?? LINUX_SYSCALLS.x64;
	const sockets = ["/tmp", "/private/tmp"]
		.map(dir => path.join(realPath(dir), "kitty"))
		.concat(kittySocket() ? [kittySocket()!] : []);
	return {
		deny: [realPath(mailRoot)],
		readonly: [realPath(SANDBOX_DIR)],
		sockets: [...new Set(sockets)],
		graphPort,
		...syscalls,
	};
}

/** The sandbox-exec profile: everything allowed except the ways listed in the module comment. */
function darwinProfile(mailRoot: string, graphPort: number): string {
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
	const kitty = kittySocket();
	if (kitty) rules.push(`(deny network-outbound (remote unix-socket (path-literal ${JSON.stringify(kitty)})))`);
	return rules.join("\n");
}

/** Profile text stored next to the wrapper: a sandbox-exec profile on macOS, JSON policy on Linux. */
export function sandboxProfile(mailRoot: string, graphPort: number): string {
	return process.platform === "linux" ? JSON.stringify(linuxPolicy(mailRoot, graphPort)) : darwinProfile(mailRoot, graphPort);
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

/** Applies the JSON policy, then replaces itself with `bash -c <command>`. Fail closed. */
const LINUX_HELPER = String.raw`#!/usr/bin/env python3
"""peer-mail Linux sandbox (src/sandbox.ts). Landlock + seccomp, then exec bash."""
import ctypes
import json
import os
import sys

# Landlock file rights, oldest ABI first. A rule has to grant something, so a directory we
# want unreadable gets only MAKE_BLOCK (it cannot read, write, list or remove).
FS_EXECUTE = 1 << 0
FS_WRITE_FILE = 1 << 1
FS_READ_FILE = 1 << 2
FS_READ_DIR = 1 << 3
FS_REMOVE_DIR = 1 << 4
FS_REMOVE_FILE = 1 << 5
FS_MAKE_CHAR = 1 << 6
FS_MAKE_DIR = 1 << 7
FS_MAKE_REG = 1 << 8
FS_MAKE_SOCK = 1 << 9
FS_MAKE_FIFO = 1 << 10
FS_MAKE_BLOCK = 1 << 11
FS_MAKE_SYM = 1 << 12
FS_REFER = 1 << 13
FS_TRUNCATE = 1 << 14
FS_IOCTL_DEV = 1 << 15
FS_BY_ABI = {
    1: (1 << 13) - 1,
    2: (1 << 14) - 1,
    3: (1 << 15) - 1,
}
FS_READ = FS_EXECUTE | FS_READ_FILE | FS_READ_DIR
LANDLOCK_CREATE_RULESET_VERSION = 1
LANDLOCK_RULE_PATH_BENEATH = 1
NR_CREATE, NR_ADD, NR_RESTRICT = 444, 445, 446
SECCOMP_SET_MODE_FILTER = 1
SECCOMP_FILTER_FLAG_TSYNC = 1
SECCOMP_RET_ALLOW = 0x7FFF0000
SECCOMP_RET_ERRNO = 0x00050000
PR_SET_NO_NEW_PRIVS = 38
CLONE_NEWUSER = 0x10000000
CLONE_NEWNS = 0x00020000
MS_REC = 1 << 14
MS_PRIVATE = 1 << 18
MS_BIND = 4096
MS_RDONLY = 1
MS_REMOUNT = 32
EPERM = 1

libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long


def fail(message: str) -> None:
    sys.stderr.write(message + "\n")
    sys.exit(1)


def syscall(number: int, *args: object) -> int:
    value = libc.syscall(number, *args)
    if value < 0:
        err = ctypes.get_errno()
        raise OSError(err, os.strerror(err))
    return int(value)


class RulesetAttr(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64)]


class PathBeneath(ctypes.Structure):
    _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]


class SockFilter(ctypes.Structure):
    _fields_ = [
        ("code", ctypes.c_uint16),
        ("jt", ctypes.c_uint8),
        ("jf", ctypes.c_uint8),
        ("k", ctypes.c_uint32),
    ]


class SockFprog(ctypes.Structure):
    _fields_ = [("len", ctypes.c_ushort), ("filter", ctypes.POINTER(SockFilter))]


def mount(source: bytes | None, target: str, fstype: bytes | None, flags: int, data: bytes | None = None) -> None:
    src = source if source is not None else None
    kind = fstype if fstype is not None else None
    if libc.mount(src, target.encode(), kind, flags, data) != 0:
        err = ctypes.get_errno()
        raise OSError(err, os.strerror(err), target)


def try_hide(policy: dict) -> None:
    """Mount namespace over the mailbox, sandbox dir and kitty sockets. Skip when user namespaces are off."""
    if libc.unshare(CLONE_NEWUSER) != 0:
        return
    try:
        with open("/proc/self/setgroups", "w") as handle:
            handle.write("deny")
        uid, gid = os.getuid(), os.getgid()
        with open("/proc/self/uid_map", "w") as handle:
            handle.write(f"0 {uid} 1\n")
        with open("/proc/self/gid_map", "w") as handle:
            handle.write(f"0 {gid} 1\n")
        if libc.unshare(CLONE_NEWNS) != 0:
            fail("peer-mail sandbox: could not create a mount namespace after entering a user namespace.")
        mount(None, "/", None, MS_REC | MS_PRIVATE)
        for directory in policy["deny"]:
            if os.path.isdir(directory):
                mount(b"tmpfs", directory, b"tmpfs", 0, b"mode=000")
        for directory in policy["readonly"]:
            if os.path.isdir(directory):
                mount(directory.encode(), directory, None, MS_BIND)
                mount(None, directory, None, MS_BIND | MS_REMOUNT | MS_RDONLY)
        for socket in policy["sockets"]:
            if os.path.exists(socket):
                mount(b"/dev/null", socket, None, MS_BIND)
    except OSError as error:
        fail(f"peer-mail sandbox: mount isolation failed ({error}).")


def landlock(policy: dict) -> None:
    try:
        abi = syscall(NR_CREATE, None, 0, LANDLOCK_CREATE_RULESET_VERSION)
    except OSError as error:
        fail(f"peer-mail sandbox: landlock is not available ({error}).")
    handled = FS_BY_ABI.get(min(abi, 3), FS_BY_ABI[3])
    if abi >= 5:
        handled |= FS_IOCTL_DEV
    attr = RulesetAttr(handled)
    try:
        ruleset = syscall(NR_CREATE, ctypes.byref(attr), ctypes.sizeof(attr), 0)
    except OSError as error:
        fail(f"peer-mail sandbox: landlock_create_ruleset failed ({error}).")

    def allow(path: str, access: int) -> None:
        if not os.path.exists(path):
            return
        flags = os.O_PATH | getattr(os, "O_CLOEXEC", 0)
        try:
            fd = os.open(path, flags)
        except OSError:
            return
        rule = PathBeneath(access & handled, fd)
        try:
            syscall(NR_ADD, ruleset, LANDLOCK_RULE_PATH_BENEATH, ctypes.byref(rule), 0)
        except OSError as error:
            fail(f"peer-mail sandbox: landlock rule for {path} failed ({error}).")
        finally:
            os.close(fd)

    allow("/", handled)
    # MAKE_BLOCK is a non-empty grant that still denies read, write and listing.
    for directory in policy["deny"] + policy["sockets"]:
        allow(directory, FS_MAKE_BLOCK if handled & FS_MAKE_BLOCK else FS_MAKE_CHAR)
    for directory in policy["readonly"]:
        allow(directory, FS_READ)
    try:
        syscall(NR_RESTRICT, ruleset, 0)
    except OSError as error:
        fail(f"peer-mail sandbox: landlock_restrict_self failed ({error}).")
    os.close(ruleset)


def seccomp(policy: dict) -> None:
    def stmt(code: int, k: int) -> SockFilter:
        return SockFilter(code, 0, 0, k)

    def jump(k: int, jt: int, jf: int) -> SockFilter:
        return SockFilter(0x15, jt, jf, k)  # BPF_JMP|BPF_JEQ|BPF_K

    filters = (SockFilter * 6)(
        stmt(0x20, 0),  # load syscall number
        jump(int(policy["bind"]), 0, 1),
        stmt(0x06, SECCOMP_RET_ERRNO | EPERM),
        jump(int(policy["listen"]), 0, 1),
        stmt(0x06, SECCOMP_RET_ERRNO | EPERM),
        stmt(0x06, SECCOMP_RET_ALLOW),
    )
    prog = SockFprog(len(filters), ctypes.cast(filters, ctypes.POINTER(SockFilter)))
    if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
        fail("peer-mail sandbox: PR_SET_NO_NEW_PRIVS failed.")
    try:
        syscall(int(policy["seccomp"]), SECCOMP_SET_MODE_FILTER, SECCOMP_FILTER_FLAG_TSYNC, ctypes.byref(prog))
    except OSError as error:
        fail(f"peer-mail sandbox: seccomp failed ({error}).")


def main() -> None:
    if len(sys.argv) != 3:
        fail("peer-mail sandbox: expected a policy file and a command.")
    with open(sys.argv[1], encoding="utf-8") as handle:
        policy = json.load(handle)
    command = sys.argv[2]
    try_hide(policy)
    landlock(policy)
    seccomp(policy)
    os.execv("/bin/bash", ["bash", "-c", command])


if __name__ == "__main__":
    main()
`;

/** The script that runs its one argument with bash inside `profile`, without the swarm's environment. */
export function sandboxScript(profile: string): string {
	const dir = sandboxDir();
	const name = `sandbox-${createHash("sha256").update(profile).digest("hex").slice(0, 8)}`;
	const script = path.join(dir, name);
	const profileFile = `${script}.sb`;
	const python = pythonBin();
	const linux = process.platform === "linux";
	if (linux && !python) throw new Error("Sandboxed runs on Linux need python3 on PATH to apply landlock and seccomp.");
	const helper = path.join(dir, "linux-helper.py");
	if (linux && (!fs.existsSync(helper) || fs.readFileSync(helper, "utf8") !== LINUX_HELPER)) {
		fs.writeFileSync(helper, LINUX_HELPER, { mode: 0o700 });
	}
	const invoke = linux
		? `${quote(python!)} ${quote(helper)} ${quote(profileFile)} "$1"`
		: `${SANDBOX_EXEC} -f ${quote(profileFile)} /bin/bash -c "$1"`;
	const body = [
		"#!/bin/bash",
		"# peer-mail: runs its argument with bash in the spawned agents' sandbox (src/sandbox.ts).",
		`exec /usr/bin/env ${SWARM_ENV.map(variable => `-u ${variable}`).join(" ")} ${invoke}`,
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
 * (subagents share this module), and nesting sandboxes may be refused inside a sandbox.
 */
export function sandboxedCommand(command: string, profile: string): string {
	const script = sandboxScript(profile);
	if (command.startsWith(`${script} `)) return command;
	return `${script} ${quote(command)}`;
}
