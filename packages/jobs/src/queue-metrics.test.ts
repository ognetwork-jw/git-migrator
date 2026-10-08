import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import { createLogger, createMetrics } from '@git-migrator/observability';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateBullmqSchema } from './connection.ts';
import { recordQueueCounts, startQueueMetrics } from './queue-metrics.ts';
import { QUEUE_NAMES } from './queues.ts';
import { JobRuntime } from './runtime.ts';

let t: TestDatabase;
let runtime: JobRuntime;
beforeAll(async () => {
  t = await createTestDatabase('gm_t028q_');
  await migrateBullmqSchema(t.connectionString);
  runtime = new JobRuntime({
    connectionString: t.connectionString,
    log: createLogger({ level: 'silent' }),
    workerCount: 0,
  });
  await runtime.waitUntilReady();
}, 120_000);
afterAll(async () => {
  await runtime?.close();
  await t?.drop();
}, 60_000);

describe('queue metrics', () => {
  it('[DEP-050] exports the job counts of every queue as gm_queue_jobs', async () => {
    await runtime.enqueue('maintenance', 'maintenance.prune', {});
    await runtime.enqueue('parity', 'drift.sweep', {}, { delayMs: 60_000 });
    const { registry, recorders } = createMetrics();
    await recordQueueCounts(runtime, recorders);
    const text = await registry.metrics();
    expect(text).toContain('gm_queue_jobs{queue="maintenance",state="waiting"} 1');
    expect(text).toContain('gm_queue_jobs{queue="parity",state="delayed"} 1');
    for (const queue of QUEUE_NAMES) expect(text).toContain(`queue="${queue}"`);
  }, 60_000);

  it('[DEP-050] polls on an interval, survives failures and stops', async () => {
    const calls: string[] = [];
    const sink = {
      setQueueJobs: (queue: string, state: string) => void calls.push(`${queue}:${state}`),
    };
    const poller = startQueueMetrics({
      runtime,
      sink,
      log: createLogger({ level: 'silent' }),
      intervalMs: 50,
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    poller.stop();
    expect(calls.length).toBeGreaterThan(QUEUE_NAMES.length);
    const failing = startQueueMetrics({
      runtime,
      sink: {
        setQueueJobs: () => {
          throw new Error('sink down');
        },
      },
      log: createLogger({ level: 'silent' }),
      intervalMs: 50,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    failing.stop();
  }, 60_000);
});
