import type { Logger } from '@git-migrator/observability';
import { QUEUE_NAMES } from './queues.ts';
import type { JobRuntime } from './runtime.ts';

/** The job states exported as `gm_queue_jobs{queue,state}` (DEP-050). */
export const QUEUE_STATES = ['waiting', 'active', 'delayed', 'failed', 'completed'] as const;

export interface QueueGaugeSink {
  setQueueJobs(queue: string, state: string, value: number): void;
}

/** Reads the job counts of every queue into the `gm_queue_jobs` gauge. */
export async function recordQueueCounts(runtime: JobRuntime, sink: QueueGaugeSink): Promise<void> {
  for (const name of QUEUE_NAMES) {
    const counts = await runtime.queue(name).getJobCounts(...QUEUE_STATES);
    for (const state of QUEUE_STATES) sink.setQueueJobs(name, state, counts[state] ?? 0);
  }
}

/**
 * Zeroes the gauges. A pod that stops leading no longer refreshes them, and stale values would be
 * scraped next to the new leader's.
 */
export function resetQueueCounts(sink: QueueGaugeSink): void {
  for (const name of QUEUE_NAMES) {
    for (const state of QUEUE_STATES) sink.setQueueJobs(name, state, 0);
  }
}

/** Polls the queue counts on an interval until `stop()`. Failures are logged, never thrown. */
export function startQueueMetrics(options: {
  readonly runtime: JobRuntime;
  readonly sink: QueueGaugeSink;
  readonly log: Logger;
  readonly intervalMs?: number;
}): { stop(): void } {
  const tick = (): void => {
    recordQueueCounts(options.runtime, options.sink).catch((error: unknown) =>
      options.log.warn({ err: error }, 'queue metrics poll failed'),
    );
  };
  tick();
  const timer = setInterval(tick, options.intervalMs ?? 15_000);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
