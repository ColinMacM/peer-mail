/**
 * The run queue: spawned agents' heavy runs (tests, builds, anything on shared hardware) go
 * through it one at a time, machine-wide, in the order they were queued. It lives beside the
 * swarm, so restarting the swarm doesn't drop runs already waiting:
 *
 *   <root>/runs/<id>.json   a queued or running run; the first live one in id order is running
 *   <root>/runs/<id>.mark   held open by the run's processes, to find them when it ends
 *
 * A run whose command executes on another host over ssh (`runsElsewhere`) doesn't use this
 * machine's CPU or devices, so it takes no place in line: it gets a ticket that isn't queued.
 *
 * A ticket whose session has died is dropped by whoever reads the queue next.
 * Each run executes in the sandbox (see sandbox.ts) in its own process group. When its command
 * exits, times out or is aborted, everything it started is killed: the process group, and any
 * process that left the group but still holds the run's mark file.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { sandboxScript } from "./sandbox";
import { listDir, pidAlive, readJson, writeJson } from "./transport";

export interface RunTicket {
	id: string;
	/** The member that queued it. */
	member: string;
	/** The session that queued it; the ticket is dropped once it's gone. */
	pid: number;
	command: string;
	cwd: string;
	queuedAt: number;
}

export interface RunResult {
	/** Exit code, or null when the command was killed. */
	exitCode: number | null;
	timedOut: boolean;
	aborted: boolean;
	durationMs: number;
	/** The end of its combined stdout and stderr. */
	output: string;
	/** Processes that left its process group and were still running after it, which were killed. */
	leftovers: number;
}

/** How much of a run's output is kept (its end). */
const OUTPUT_LIMIT = 64 * 1024;
const POLL_MS = 500;
// Orders tickets one process queues within the same millisecond.
let ticketCounter = 0;

/**
 * Whether `command` runs on another computer: an ssh (or mosh) invocation, possibly behind
 * variable assignments or `env`, `timeout`, `nice`, `command` or `exec`, so this machine only waits on it.
 */
export function runsElsewhere(command: string): boolean {
	return /^\s*(?:(?:\w+=\S*|env|command|exec|nice(?:\s+-n\s*-?\d+)?|timeout(?:\s+-\S+)*\s+\S+)\s+)*(?:ssh|mosh)\s/.test(command);
}

export class RunQueue {
	readonly dir: string;

	constructor(root: string) {
		this.dir = path.join(root, "runs");
	}

	/** A ticket for a run that takes no place in line: `run` accepts it, `line` never lists it. */
	ticket(member: string, command: string, cwd: string): RunTicket {
		const now = Date.now();
		const id = `${String(now).padStart(15, "0")}-${String(++ticketCounter).padStart(9, "0")}-${process.pid}`;
		return { id, member, pid: process.pid, command, cwd, queuedAt: now };
	}

	enqueue(member: string, command: string, cwd: string): RunTicket {
		const ticket = this.ticket(member, command, cwd);
		writeJson(path.join(this.dir, `${ticket.id}.json`), ticket);
		return ticket;
	}

	/** Live tickets in run order; the first is running (or about to). Dead sessions' tickets are removed. */
	line(): RunTicket[] {
		const tickets: RunTicket[] = [];
		for (const file of listDir(this.dir)) {
			if (!file.endsWith(".json")) continue;
			const ticket = readJson<RunTicket>(path.join(this.dir, file));
			if (!ticket) continue;
			if (pidAlive(ticket.pid)) tickets.push(ticket);
			else this.remove(ticket.id);
		}
		return tickets;
	}

	remove(id: string): void {
		fs.rmSync(path.join(this.dir, `${id}.json`), { force: true });
		fs.rmSync(path.join(this.dir, `${id}.mark`), { force: true });
	}

	/**
	 * Wait for `ticket` to reach the front of the line. `onWait` hears the line whenever it changes.
	 * Throws when aborted or when the ticket has been removed from the queue.
	 */
	async waitTurn(ticket: RunTicket, signal: AbortSignal | undefined, onWait: (ahead: RunTicket[]) => void): Promise<void> {
		let last = "";
		for (;;) {
			if (signal?.aborted) throw new Error("Aborted while waiting in the run queue.");
			const line = this.line();
			const index = line.findIndex(item => item.id === ticket.id);
			if (index === -1) throw new Error("This run was removed from the run queue.");
			if (index === 0) return;
			const ahead = line.slice(0, index);
			const key = ahead.map(item => item.id).join();
			if (key !== last) onWait(ahead);
			last = key;
			await Bun.sleep(POLL_MS);
		}
	}

	/** Run `ticket`'s command in the sandbox, then kill everything it left running. */
	async run(ticket: RunTicket, profile: string, timeoutMs: number, signal: AbortSignal | undefined): Promise<RunResult> {
		const started = Date.now();
		const markFile = path.join(this.dir, `${ticket.id}.mark`);
		const mark = fs.openSync(markFile, "w");
		const child = spawn(sandboxScript(profile), [ticket.command], { cwd: ticket.cwd, detached: true, stdio: ["ignore", "pipe", "pipe", mark] });
		fs.closeSync(mark);
		let output = "";
		const collect = (chunk: Buffer) => {
			output = (output + chunk.toString("utf8")).slice(-OUTPUT_LIMIT);
		};
		// Both are pipes; node types any stdio list with an fd in it as possibly null.
		child.stdout?.on("data", collect);
		child.stderr?.on("data", collect);
		let timedOut = false;
		const killGroup = () => {
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
			} catch {
				// The group is already gone.
			}
		};
		const timer = setTimeout(() => {
			timedOut = true;
			killGroup();
		}, timeoutMs);
		signal?.addEventListener("abort", killGroup, { once: true });
		const exitCode = await new Promise<number | null>(resolve => {
			child.once("error", error => {
				output += `\n${error.message}`;
				resolve(null);
			});
			child.once("exit", code => resolve(code));
		});
		clearTimeout(timer);
		signal?.removeEventListener("abort", killGroup);
		killGroup();
		const leftovers = killMarkHolders(markFile);
		child.stdout?.destroy();
		child.stderr?.destroy();
		return { exitCode, timedOut, aborted: signal?.aborted ?? false, durationMs: Date.now() - started, output, leftovers };
	}
}

/** Kill every process that still holds `markFile` open (ones that left the run's process group). */
function killMarkHolders(markFile: string): number {
	const lsof = Bun.spawnSync(["/usr/sbin/lsof", "-t", markFile], { stdout: "pipe", stderr: "ignore" });
	const pids = lsof.stdout
		.toString()
		.split("\n")
		.map(Number)
		.filter(pid => pid > 0 && pid !== process.pid);
	for (const pid of pids) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already exited.
		}
	}
	return pids.length;
}
