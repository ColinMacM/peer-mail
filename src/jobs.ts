/**
 * Cancelling a session's background jobs (`async` bash, background subagents) when mail
 * interrupts it. omp gives extensions only a snapshot of these jobs, but the process-wide job
 * manager an extension imports is the host's own, the same one `/jobs kill` uses.
 */
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";

export interface CancelledJobs {
	/** Labels of the jobs that were cancelled. */
	cancelled: string[];
	/** Labels of running jobs that could not be cancelled. */
	failed: string[];
}

/** Cancel every background job this session has running. */
export function cancelBackgroundJobs(ctx: ExtensionContext): CancelledJobs {
	const running = ctx.getAsyncJobSnapshot()?.running ?? [];
	const manager = AsyncJobManager.instance();
	const result: CancelledJobs = { cancelled: [], failed: [] };
	for (const job of running) {
		const label = `${job.id} (${job.label})`;
		if (manager?.cancel(job.id)) result.cancelled.push(label);
		else result.failed.push(label);
	}
	return result;
}
