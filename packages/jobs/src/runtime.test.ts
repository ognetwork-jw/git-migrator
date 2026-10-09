import { resolveConfig } from '@git-migrator/config';
import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import { createLogger } from '@git-migrator/observability';
import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { type Job, WaitingError, Worker } from 'bullmq';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  bullmqPoolSize,
  createBullmqPool,
  migrateBullmqSchema,
  QUERY_CONNECTIONS,
} from './connection.ts';
import { InvalidPayloadError } from './payloads.ts';
import { QUEUE_NAMES, queuesForRole } from './queues.ts';
import { MAX_REAPER_RESUMES, RUN_ABANDONED, reapRuns } from './reaper.ts';
import { handOffRun, keepRunLease } from './run-leases.ts';
import { type JobHandlers, JobRuntime } from './runtime.ts';
import { seedBasics } from './world.fixture.ts';

// Tracing is process-global: register the provider before any BullMQ telemetry object exists.
const exporter = new InMemorySpanExporter();
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
propagation.setGlobalPropagator(new W3CTraceContextPropagator());
trace.setGlobalTracerProvider(
  new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
);

const config = resolveConfig({ text: '', env: {} });
const log = createLogger({ level: 'silent' });
let t: TestDatabase;
let runtimes: JobRuntime[] = [];

beforeAll(async () => {
  t = await createTestDatabase('gm_t028_');
  await migrateBullmqSchema(t.connectionString);
}, 120_000);

afterEach(async () => {
  await Promise.all(runtimes.map((runtime) => runtime.close()));
  runtimes = [];
});

afterAll(async () => {
  await t?.drop();
}, 60_000);

function makeRuntime(workerCount: number): JobRuntime {
  const runtime = new JobRuntime({
    connectionString: t.connectionString,
    log,
    workerCount,
    applicationName: 'gm-t028-test',
  });
  runtimes.push(runtime);
  return runtime;
}

/** Empties every queue, so jobs left by an earlier test cannot reach this test's handlers. */
async function drainAll(runtime: JobRuntime): Promise<void> {
  for (const name of QUEUE_NAMES) await runtime.queue(name).drain(true);
}

const until = async (check: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describe('job runtime on the PostgreSQL backend', () => {
  it('[JOB-010] runs jobs through BullMQ stored in the bullmq schema', async () => {
    const runtime = makeRuntime(6);
    await runtime.waitUntilReady();
    await drainAll(runtime);
    const seen: unknown[] = [];
    const handlers: JobHandlers = {
      'maintenance.prune': async (payload, context) => {
        seen.push([payload, context.queue, context.job.name]);
        return 'done';
      },
    };
    await runtime.startWorkers('standard', config, handlers);
    const job = await runtime.enqueue('maintenance', 'maintenance.prune', {});
    await until(() => seen.length === 1);
    expect(seen[0]).toEqual([{}, 'maintenance', 'maintenance.prune']);
    expect(job.opts.attempts).toBe(3);
    const tables = await t.db.pool.query(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'bullmq'",
    );
    expect(tables.rows[0].n).toBeGreaterThan(0);
    expect(runtime.workerQueues).toEqual(queuesForRole('standard'));
  }, 60_000);

  it('[JOB-011] validates payloads on enqueue and refuses a queue that does not carry the job', async () => {
    const runtime = makeRuntime(0);
    await runtime.waitUntilReady();
    await drainAll(runtime);
    await expect(
      // @ts-expect-error a stray field is a type error too
      runtime.enqueue('runs-standard', 'run.execute', { runId: 'r', token: 'x' }),
    ).rejects.toBeInstanceOf(InvalidPayloadError);
    await expect(runtime.enqueue('inventory', 'run.execute', { runId: 'r' })).rejects.toThrow(
      'does not carry',
    );
    expect(await runtime.queue('runs-standard').getJobCounts('waiting', 'delayed')).toEqual({
      waiting: 0,
      delayed: 0,
    });
  }, 60_000);

  it('[JOB-011] validates payloads again on processing and fails the job without retrying', async () => {
    const runtime = makeRuntime(6);
    await runtime.waitUntilReady();
    await drainAll(runtime);
    let called = 0;
    await runtime.startWorkers('standard', config, {
      'parity.migration': async () => {
        called += 1;
      },
    });
    // Bypass enqueue validation, as a producer with an older schema could.
    const queue = runtime.queue('parity');
    const bad = await queue.add('parity.migration', { migrationId: 'm', password: 'hunter2' });
    await until(async () => (await queue.getJobCounts('failed')).failed === 1);
    expect(called).toBe(0);
    const failed = await queue.getJob(bad.id as string);
    expect(failed?.attemptsMade).toBe(1);
    expect(failed?.failedReason).toContain('Invalid payload for parity.migration');
    expect(failed?.failedReason).not.toContain('hunter2');
  }, 60_000);

  it('[JOB-011] fails a job that has no registered processor, without retrying', async () => {
    const runtime = makeRuntime(6);
    await runtime.waitUntilReady();
    await drainAll(runtime);
    await runtime.startWorkers('standard', config, {});
    const job = await runtime.enqueueAnalysis('m-no-handler', 'interactive');
    const queue = runtime.queue('analysis-interactive');
    await until(async () => (await queue.getJobCounts('failed')).failed === 1);
    const failed = await queue.getJob(job.id as string);
    expect(failed?.failedReason).toContain('No processor registered for analysis.migration');
    expect(failed?.attemptsMade).toBe(1);
  }, 60_000);

  it('[JOB-011] deduplicates with deduplication.id, and accepts the job again after completion', async () => {
    const runtime = makeRuntime(6);
    await runtime.waitUntilReady();
    await drainAll(runtime);
    const first = await runtime.enqueueAnalysis('m-dedupe', 'background');
    const second = await runtime.enqueueAnalysis('m-dedupe', 'background');
    expect(second.id).toBe(first.id);
    expect(await runtime.queue('analysis-background').getJobCounts('waiting')).toEqual({
      waiting: 1,
    });
    const other = await runtime.enqueueAnalysis('m-other', 'background');
    expect(other.id).not.toBe(first.id);

    let processed = 0;
    await runtime.startWorkers('standard', config, {
      'analysis.migration': async () => {
        processed += 1;
      },
    });
    await until(() => processed === 2);
    await until(
      async () =>
        (await runtime.queue('analysis-background').getJobCounts('completed')).completed === 2,
    );
    const again = await runtime.enqueueAnalysis('m-dedupe', 'background');
    expect(again.id).not.toBe(first.id);
    await until(() => processed === 3);
  }, 60_000);

  it('[LIF-062] enqueueParity puts parity.migration on the parity queue, one waiting job per Migration', async () => {
    const runtime = makeRuntime(0);
    await runtime.waitUntilReady();
    await drainAll(runtime);
    const first = await runtime.enqueueParity('m-parity');
    const second = await runtime.enqueueParity('m-parity');
    expect(first.queueName).toBe('parity');
    expect(first.name).toBe('parity.migration');
    expect(first.data).toEqual({ migrationId: 'm-parity' });
    expect(second.id).toBe(first.id);
    const other = await runtime.enqueueParity('m-parity-2');
    expect(other.id).not.toBe(first.id);
  }, 60_000);

  it('[LIF-062] a parity trigger that arrives while a check is active runs after it, never in parallel', async () => {
    const runtime = makeRuntime(6);
    await runtime.waitUntilReady();
    await drainAll(runtime);
    let active = 0;
    let maxActive = 0;
    let runs = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await runtime.startWorkers('standard', config, {
      'parity.migration': async () => {
        runs += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (runs === 1) await gate;
        active -= 1;
      },
    });
    await runtime.enqueueParity('m-active');
    await until(() => runs === 1);
    await runtime.enqueueParity('m-active');
    await runtime.enqueueParity('m-active');
    release();
    await until(() => runs === 2);
    await new Promise((r) => setTimeout(r, 300));
    expect(runs).toBe(2); // the two triggers collapsed into one
    expect(maxActive).toBe(1);
  }, 60_000);

  it('[JOB-013] gives run.execute one attempt and every other job three, with exponential backoff', async () => {
    const runtime = makeRuntime(0);
    await runtime.waitUntilReady();
    await drainAll(runtime);
    const run = await runtime.enqueueRun('run-attempts', {
      kind: 'migrate',
      scope: 'repository',
      sizeClass: 'large',
    });
    expect(run.queueName).toBe('runs-large');
    expect(run.opts.attempts).toBe(1);
    const parity = await runtime.enqueue('parity', 'drift.sweep', {});
    expect(parity.opts.attempts).toBe(3);
    expect(parity.opts.backoff).toEqual({ type: 'exponential', delay: 5000 });
    expect(parity.opts.removeOnComplete).toEqual({ age: 86_400 });
    expect(parity.opts.removeOnFail).toEqual({ age: 604_800 });
  }, 60_000);

  it('[JOB-012] never runs more jobs at once than the configured concurrency', async () => {
    const runtime = makeRuntime(7);
    await runtime.waitUntilReady();
    await drainAll(runtime);
    const tuned = resolveConfig({
      text: 'worker: { standard: { concurrency: { runs: 2 } } }',
      env: {},
    });
    let active = 0;
    let peak = 0;
    let done = 0;
    await runtime.startWorkers('all', tuned, {
      'run.execute': async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 150));
        active -= 1;
        done += 1;
      },
    });
    const routing = { kind: 'verify', scope: 'repository', sizeClass: 'standard' } as const;
    for (let i = 0; i < 6; i += 1) await runtime.enqueueRun(`run-conc-${i}`, routing);
    await until(() => done === 6);
    expect(peak).toBe(2);
  }, 60_000);

  it('[JOB-014] shares one pool, so connections stay within the documented formula', async () => {
    const runtime = makeRuntime(queuesForRole('all').length);
    await runtime.waitUntilReady();
    await drainAll(runtime);
    await runtime.startWorkers('all', config, { 'maintenance.prune': async () => 'ok' });
    for (let i = 0; i < 20; i += 1) await runtime.enqueue('maintenance', 'maintenance.prune', {});
    await until(
      async () =>
        ((await runtime.queue('maintenance').getJobCounts('completed')).completed ?? 0) >= 20,
    );
    const observer = new pg.Client({ connectionString: t.connectionString });
    await observer.connect();
    try {
      const rows = await observer.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND application_name LIKE 'gm-t028-test%'`,
      );
      const workers = queuesForRole('all').length;
      expect(workers).toBe(7);
      // Every Worker holds one LISTEN client; the rest is the query headroom.
      expect(rows.rows[0]?.n).toBeLessThanOrEqual(bullmqPoolSize(workers));
      expect(runtime.pool.totalCount).toBeLessThanOrEqual(workers + QUERY_CONNECTIONS);
      expect(bullmqPoolSize(workers)).toBe(11);
    } finally {
      await observer.end();
    }
  }, 60_000);

  it('[DEP-050] traces BullMQ jobs: the enqueue and the processing share one trace', async () => {
    exporter.reset();
    const runtime = makeRuntime(6);
    await runtime.waitUntilReady();
    await drainAll(runtime);
    let handled = false;
    await runtime.startWorkers('standard', config, {
      'maintenance.prune': async () => {
        handled = true;
      },
    });
    const tracer = trace.getTracer('test');
    await tracer.startActiveSpan('enqueue-caller', async (span) => {
      await runtime.enqueue('maintenance', 'maintenance.prune', {});
      span.end();
    });
    await until(() => handled);
    await until(() => exporter.getFinishedSpans().some((s) => /process/.test(s.name)));
    const spans = exporter.getFinishedSpans();
    const names = spans.map((s) => s.name);
    expect(names.some((n) => /add/.test(n))).toBe(true);
    const caller = spans.find((s) => s.name === 'enqueue-caller');
    const processing = spans.find((s) => s.name === 'process maintenance');
    expect(processing?.spanContext().traceId).toBe(caller?.spanContext().traceId);
    expect(processing?.attributes['bullmq.job.name']).toBe('maintenance.prune');
  }, 60_000);

  it('[DEP-030] stops taking jobs on shutdown, finishes the job in flight and aborts the signal', async () => {
    const runtime = makeRuntime(6);
    await runtime.waitUntilReady();
    await drainAll(runtime);
    let started = false;
    let finished = false;
    let abortedSeen = false;
    let handled = 0;
    await runtime.startWorkers('standard', config, {
      'maintenance.prune': async (_payload, context) => {
        handled += 1;
        started = true;
        await new Promise<void>((resolve) => {
          const done = (): void => {
            abortedSeen = true;
            setTimeout(resolve, 100);
          };
          // Check `.aborted` too: the abort may have fired before this listener existed.
          if (context.shutdown.aborted) done();
          else context.shutdown.addEventListener('abort', done);
        });
        finished = true;
      },
    });
    await runtime.enqueue('maintenance', 'maintenance.prune', {});
    await until(() => started);
    const producer = makeRuntime(0);
    await producer.waitUntilReady();
    const closing = runtime.close();
    // A job added while the worker drains must wait for the next process (SIGTERM, DEP-030).
    await producer.enqueue('maintenance', 'maintenance.prune', {});
    await closing;
    expect(abortedSeen).toBe(true);
    expect(finished).toBe(true);
    expect(started).toBe(true);
    expect(runtime.shutdownSignal.aborted).toBe(true);
    await runtime.close(); // idempotent
    expect(handled).toBe(1);
    const next = makeRuntime(0);
    await next.waitUntilReady();
    const counts = await next.queue('maintenance').getJobCounts('waiting', 'failed', 'active');
    // The second job was given back untouched: waiting, not failed, not active.
    expect(counts).toEqual({ waiting: 1, failed: 0, active: 0 });
  }, 60_000);

  it('[DEP-030] gives back every job a draining Worker activates, running none and failing none', async () => {
    const runtime = makeRuntime(6);
    await runtime.waitUntilReady();
    await drainAll(runtime);
    let ran = 0;
    await runtime.startWorkers('standard', config, {
      'maintenance.prune': async () => {
        ran += 1;
      },
    });
    // A separate producer, so closing the consumer cannot close the queue the jobs go through.
    const producer = makeRuntime(0);
    await producer.waitUntilReady();
    const closing = runtime.close();
    // Workers are closing with free slots; jobs added now are activated by them at most once.
    for (let i = 0; i < 4; i += 1) await producer.enqueue('maintenance', 'maintenance.prune', {});
    await closing;
    const next = makeRuntime(0);
    await next.waitUntilReady();
    const counts = await next.queue('maintenance').getJobCounts('waiting', 'failed', 'active');
    expect(counts.failed).toBe(0);
    expect(counts.active).toBe(0);
    expect((counts.waiting ?? 0) + ran).toBe(4);
    expect(ran).toBe(0);
  }, 60_000);

  it('[DEP-030] gives back a job a draining Worker activated: waiting again, attempts unchanged, never run', async () => {
    const producer = makeRuntime(0);
    await producer.waitUntilReady();
    await drainAll(producer);
    // A manual Worker stands in for the race: it activates the job under a lock token, exactly as
    // a Worker woken by close() does, and the runtime's processor then receives it.
    const pool = createBullmqPool({ connectionString: t.connectionString, max: 3 });
    const worker = new Worker('maintenance', null, { connection: pool, autorun: false });
    try {
      await worker.waitUntilReady();
      await producer.enqueue('maintenance', 'maintenance.prune', {});
      const token = 'give-back-token';
      const job = (await worker.getNextJob(token)) as Job;
      expect(job).toBeDefined();
      expect(await job.getState()).toBe('active');
      const attemptsBefore = job.attemptsMade;
      const draining = makeRuntime(0);
      await draining.close(); // shutdown has begun
      let ran = 0;
      const handlers: JobHandlers = {
        'maintenance.prune': async () => {
          ran += 1;
        },
      };
      await expect(draining.processJob('maintenance', job, handlers, token)).rejects.toBeInstanceOf(
        WaitingError,
      );
      expect(ran).toBe(0);
      const after = await producer.queue('maintenance').getJob(job.id as string);
      expect(await after?.getState()).toBe('waiting');
      expect(after?.attemptsMade).toBe(attemptsBefore);
      expect(after?.failedReason).toBeFalsy();
    } finally {
      await worker.close();
      await pool.end();
    }
  }, 60_000);

  it('[JOB-014] refuses to start more Workers than the pool was sized for', async () => {
    const runtime = makeRuntime(2);
    await runtime.waitUntilReady();
    await expect(runtime.startWorkers('standard', config, {})).rejects.toThrow(
      'sized for 2 Workers, but 6 are starting',
    );
    expect(runtime.workerQueues).toEqual([]);
  }, 60_000);

  it('[LIF-046] never re-queues a stalled Run job: the reaper is the only resume path', async () => {
    const runtime = makeRuntime(7);
    await runtime.waitUntilReady();
    await runtime.startWorkers('all', config, {});
    expect(runtime.worker('runs-standard')?.opts.maxStalledCount).toBe(0);
    expect(runtime.worker('runs-large')?.opts.maxStalledCount).toBe(0);
    expect(runtime.worker('parity')?.opts.maxStalledCount).not.toBe(0);
  }, 60_000);

  it('[LIF-046] hands a Run off through the runtime under a distinct id, despite the live job', async () => {
    const runtime = makeRuntime(7);
    await runtime.waitUntilReady();
    await drainAll(runtime);
    const world = await seedBasics(t.db.privileged);
    const run = await t.db.privileged.run.create({
      data: {
        migrationId: world.migrationId,
        kind: 'verify',
        triggeredById: world.actorId,
        options: {},
        status: 'running',
        startedAt: new Date(),
      },
    });
    const routing = { kind: 'verify', scope: 'repository', sizeClass: 'standard' } as const;
    const executions: string[] = [];
    let firstHandoff: Promise<boolean> | undefined;
    await runtime.startWorkers('all', config, {
      'run.execute': async ({ runId }, ctx) => {
        const lease = await keepRunLease({
          pool: t.db.pool,
          runId,
          workerId: 'w',
          jobId: ctx.job.id,
        });
        if (!lease) return;
        executions.push(lease.token);
        if (executions.length === 1) {
          // SIGTERM: hand the Run off while this very job is still active.
          firstHandoff = handOffRun({
            pool: t.db.pool,
            runs: runtime,
            runId,
            token: lease.token,
            routing,
          });
          await firstHandoff;
          lease.stop();
        } else {
          await lease.release();
        }
      },
    });
    await runtime.enqueueRun(run.id, routing);
    await until(() => executions.length === 2);
    expect(await firstHandoff).toBe(true);
    const row = (await t.db.pool.query('SELECT * FROM app.run WHERE id = $1', [run.id])).rows[0];
    expect(row.reaper_resumes).toBe(0);
  }, 60_000);

  it('[LIF-046] keeps one resume job while the queue is backlogged, however often the reaper runs', async () => {
    const runtime = makeRuntime(0);
    await runtime.waitUntilReady();
    await drainAll(runtime);
    const world = await seedBasics(t.db.privileged);
    const run = await t.db.privileged.run.create({
      data: {
        migrationId: world.migrationId,
        kind: 'verify',
        triggeredById: world.actorId,
        options: {},
        status: 'running',
        startedAt: new Date(),
        leaseOwner: 'dead',
      },
    });
    await t.db.pool.query(
      "UPDATE app.run SET lease_expires_at = clock_timestamp() - interval '1 minute' WHERE id = $1",
      [run.id],
    );
    for (let pass = 0; pass < 4; pass += 1) {
      await reapRuns({ pool: t.db.pool, runs: runtime, log });
      await t.db.pool.query(
        "UPDATE app.run SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
        [run.id],
      );
    }
    expect((await runtime.queue('runs-standard').getJobCounts('waiting')).waiting).toBe(1);
    const row = (await t.db.pool.query('SELECT * FROM app.run WHERE id = $1', [run.id])).rows[0];
    expect(row.status).toBe('running');
    expect(row.reaper_resumes).toBe(0);
  }, 60_000);

  it('[LIF-046] tells a waiting Run job from a failed or missing one', async () => {
    const runtime = makeRuntime(7);
    await runtime.waitUntilReady();
    await drainAll(runtime);
    const routing = { kind: 'migrate', scope: 'repository', sizeClass: 'large' } as const;
    await runtime.enqueueRun('run-live', routing, { dedupeId: 'run-live:resume-1' });
    expect(await runtime.isRunJobPending('run-live:resume-1')).toBe(true);
    expect(await runtime.isRunJobPending('run-never:resume-1')).toBe(false);
    // No handler for run.execute: the job fails without retry (attempts 1).
    await runtime.startWorkers('all', config, {});
    await until(async () => !(await runtime.isRunJobPending('run-live:resume-1')));
    expect((await runtime.queue('runs-large').getJobCounts('failed')).failed).toBeGreaterThan(0);
  }, 60_000);

  it('[LIF-046] a Run whose resume jobs keep dying reaches the bound and is abandoned', async () => {
    const runtime = makeRuntime(7);
    await runtime.waitUntilReady();
    await drainAll(runtime);
    // Until the Run executor exists (T-070), every run.execute job fails: the bound must still hold.
    await runtime.startWorkers('all', config, {});
    const world = await seedBasics(t.db.privileged);
    const run = await t.db.privileged.run.create({
      data: {
        migrationId: world.migrationId,
        kind: 'verify',
        triggeredById: world.actorId,
        options: {},
        status: 'running',
        startedAt: new Date(),
        leaseOwner: 'dead',
      },
    });
    const expire = () =>
      t.db.pool.query(
        "UPDATE app.run SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
        [run.id],
      );
    await expire();
    let abandoned = false;
    for (let pass = 0; pass <= MAX_REAPER_RESUMES + 1 && !abandoned; pass += 1) {
      const result = await reapRuns({ pool: t.db.pool, runs: runtime, log });
      abandoned = result.abandoned.includes(run.id);
      if (abandoned) break;
      const dedupeId = `run-${run.id}:resume-${pass + 1}`;
      await until(async () => !(await runtime.isRunJobPending(dedupeId)));
      await expire();
    }
    const row = (await t.db.pool.query('SELECT * FROM app.run WHERE id = $1', [run.id])).rows[0];
    expect(abandoned).toBe(true);
    expect(row.status).toBe('failed');
    expect(row.error).toMatchObject({ code: RUN_ABANDONED });
    expect(row.reaper_resumes).toBe(MAX_REAPER_RESUMES);
  }, 60_000);
});
