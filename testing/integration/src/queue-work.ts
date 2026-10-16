/**
 * When the scenarios may consider the worker idle. A job is work a scenario waits for while it is
 * waiting, running, or delayed and due soon. Delayed jobs come in four kinds:
 *
 * - a failed attempt waiting out its backoff (JOB-013): work, because an `analyze` request for the
 *   same Migration is deduplicated into it;
 * - a rate-limit, scratch-space or quota delay, or a delayed enqueue (JOB-044): work, as long as it
 *   is due within the wait window, so `idle` no longer ends before that work has run;
 * - a scheduler's next occurrence (it carries a `repeatJobKey`): not work, it never ends;
 * - a delayed job due after the wait window (a drift check spread over the schedule interval): not
 *   work this scenario can wait for. A scenario that needs its effect triggers it explicitly.
 */
import type { JobRuntime, QueueName } from '@git-migrator/jobs';

/** How far ahead a delayed job still counts as pending work: the default `until` wait. */
export const PENDING_WINDOW_MS = 90_000;

/** The fields of a BullMQ job this decision reads. */
export interface DelayedJobView {
  readonly attemptsMade: number;
  readonly timestamp: number;
  readonly delay: number;
  readonly repeatJobKey?: string | undefined;
}

/** True when a delayed job is work a scenario should wait for (see the file comment). */
export function isPendingDelayed(
  job: DelayedJobView,
  now: number,
  windowMs = PENDING_WINDOW_MS,
): boolean {
  if (job.repeatJobKey) return false;
  if (job.attemptsMade > 0) return true;
  return job.timestamp + job.delay - now <= windowMs;
}

/** True while any of the queues holds a job that is waiting, running or pending (see above). */
export async function queuesBusy(
  runtime: Pick<JobRuntime, 'queue'>,
  queues: readonly QueueName[],
  now: () => number = Date.now,
): Promise<boolean> {
  for (const name of queues) {
    const queue = runtime.queue(name);
    const counts = await queue.getJobCounts('waiting', 'active', 'prioritized');
    if (Object.values(counts).some((n) => n > 0)) return true;
    const delayed = await queue.getJobs(['delayed']);
    if (delayed.some((job) => isPendingDelayed(job, now()))) return true;
  }
  return false;
}
