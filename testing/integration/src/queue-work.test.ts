import type { JobRuntime, QueueName } from '@git-migrator/jobs';
import { describe, expect, it } from 'vitest';
import {
  type DelayedJobView,
  isPendingDelayed,
  PENDING_WINDOW_MS,
  queuesBusy,
} from './queue-work.ts';

const NOW = 1_000_000;
const job = (over: Partial<DelayedJobView>): DelayedJobView => ({
  attemptsMade: 0,
  timestamp: NOW,
  delay: 0,
  ...over,
});

describe('scenario idle detection (TST-020)', () => {
  it('[TST-020] a delayed job that never failed and is due within the wait window is pending work', () => {
    // A rate-limit or scratch-space re-enqueue, or a delayed enqueue (JOB-044).
    expect(isPendingDelayed(job({ delay: 5_000 }), NOW)).toBe(true);
    expect(isPendingDelayed(job({ delay: PENDING_WINDOW_MS }), NOW)).toBe(true);
    expect(isPendingDelayed(job({ timestamp: NOW - 60_000, delay: 120_000 }), NOW)).toBe(true);
  });

  it('[TST-020] a failed attempt waiting out its backoff is pending work, however far ahead', () => {
    expect(isPendingDelayed(job({ attemptsMade: 1, delay: 10 * PENDING_WINDOW_MS }), NOW)).toBe(
      true,
    );
  });

  it("[TST-020] a scheduler's next occurrence and a job due after the wait window are not", () => {
    expect(isPendingDelayed(job({ repeatJobKey: 'inventory:bb-src', delay: 1_000 }), NOW)).toBe(
      false,
    );
    expect(isPendingDelayed(job({ delay: PENDING_WINDOW_MS + 1 }), NOW)).toBe(false);
  });

  it('[TST-020] the queues are busy while any holds a waiting, running or pending delayed job', async () => {
    const queues: Record<string, { counts: Record<string, number>; delayed: DelayedJobView[] }> = {
      a: { counts: { waiting: 0, active: 0, prioritized: 0 }, delayed: [] },
      b: { counts: { waiting: 0, active: 0, prioritized: 0 }, delayed: [] },
    };
    const runtime = {
      queue: (name: string) => ({
        getJobCounts: async () => queues[name]?.counts ?? {},
        getJobs: async () => queues[name]?.delayed ?? [],
      }),
    } as unknown as Pick<JobRuntime, 'queue'>;
    const names = ['a', 'b'] as unknown as QueueName[];
    const now = () => NOW;

    expect(await queuesBusy(runtime, names, now)).toBe(false);
    (queues.b as { delayed: DelayedJobView[] }).delayed = [
      job({ repeatJobKey: 'scheduler', delay: 1 }),
      job({ delay: 10 * PENDING_WINDOW_MS }),
    ];
    expect(await queuesBusy(runtime, names, now)).toBe(false);
    (queues.b as { delayed: DelayedJobView[] }).delayed.push(job({ delay: 30_000 }));
    expect(await queuesBusy(runtime, names, now)).toBe(true);
    (queues.b as { delayed: DelayedJobView[] }).delayed = [];
    (queues.a as { counts: Record<string, number> }).counts.active = 1;
    expect(await queuesBusy(runtime, names, now)).toBe(true);
  });
});
