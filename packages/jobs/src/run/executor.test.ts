import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { reapRuns } from '../reaper.ts';
import { requestRunCancel } from './guard.ts';
import {
  deferred,
  FIXED_NOW,
  Harness,
  rateLimited,
  silentLog,
  step,
  tracked,
  transient,
  until,
} from './harness.fixture.ts';
import { RunStepRegistry } from './types.ts';

// Built at run time so that no credential-shaped literal sits in the repository (gitleaks).
const PASSWORD = ['hunter', '2secret'].join('');

// These tests wait on a real database; a loaded CI box needs more than the 5 s default.
vi.setConfig({ testTimeout: 30_000 });

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase('gm_t070a_');
}, 120_000);
afterAll(async () => {
  await t?.drop();
}, 60_000);

const harness = () => new Harness(t);

describe('[LIF-040] step framework', () => {
  it('[JOB-015] hands the job scratch directory to every Step', async () => {
    const h = harness();
    const seen: (string | undefined)[] = [];
    h.registry.register('migrate', {
      steps: () => [
        step('git.prepare', async (ctx) => {
          seen.push(ctx.scratchDir);
          return { status: 'succeeded' };
        }),
      ],
    });
    const { runId } = await h.queuedRun();
    await h.execute(runId, { scratchDir: '/scratch/run-1/abc' });
    expect(seen).toEqual(['/scratch/run-1/abc']);
    const other = await h.queuedRun();
    await h.execute(other.runId);
    expect(seen[1]).toBeUndefined();
  });

  it('[LIF-040] starts a queued Run, runs its Steps in plan order and finishes it', async () => {
    const h = harness();
    h.registry.register('migrate', {
      steps: () => [
        step('preflight', async (ctx) => {
          ctx.services.calls.push('preflight');
          return { status: 'succeeded' };
        }),
        step('git.prepare', async (ctx) => {
          ctx.services.calls.push('git.prepare');
          return undefined;
        }),
        step('verify', async (ctx) => {
          ctx.services.calls.push('verify');
          return { status: 'succeeded' };
        }),
      ],
    });
    const { world, runId } = await h.queuedRun();
    expect((await h.run(runId)).status).toBe('queued');

    const result = await h.execute(runId);

    expect(result).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect(h.services.calls).toEqual(['preflight', 'git.prepare', 'verify']);
    const run = await h.run(runId);
    expect(run.status).toBe('succeeded');
    expect(run.startedAt).not.toBeNull();
    expect(run.finishedAt).not.toBeNull();
    expect(run.leaseOwner).toBeNull();
    expect(await h.stepStatuses(runId)).toEqual({
      preflight: 'succeeded',
      'git.prepare': 'succeeded',
      verify: 'succeeded',
    });
    const steps = await h.steps(runId);
    expect(steps.map((s) => s.order)).toEqual([0, 1, 2]);
    expect(steps.every((s) => s.attempts === 1 && s.startedAt && s.finishedAt)).toBe(true);
    // [LIF-002] the Migration took run_finished(migrate, succeeded).
    expect((await h.migration(world.migrationId)).status).toBe('migrated');
  });

  it('[LIF-040] fails a Run whose kind has no registered Steps, without running anything', async () => {
    const h = harness();
    const { world, runId } = await h.queuedRun('migrate');
    const result = await h.execute(runId, {}, { registry: new RunStepRegistry() });
    expect(result).toEqual({ outcome: 'finished', status: 'failed' });
    const run = await h.run(runId);
    expect(run.error).toMatchObject({ code: 'run.kind_unsupported' });
    expect((await h.migration(world.migrationId)).status).toBe('failed');
  });

  it('[LIF-040] refuses a second planner for one kind and a duplicate Step in a plan', async () => {
    const h = harness();
    h.registry.register('migrate', { steps: () => [step('a'), step('a')] });
    expect(() => h.registry.register('migrate', { steps: () => [] })).toThrow(/already/);
    const { runId } = await h.queuedRun();
    await expect(h.execute(runId)).rejects.toThrow(/plans a twice/);
    // The executor crashed: the lease stays until it expires, so the reaper counts the resumption.
    expect((await h.run(runId)).leaseOwner).not.toBeNull();
  });

  it('[LIF-040] logs to the Run log and publishes run.updated and run.log events in the transactions', async () => {
    const h = harness();
    const events: string[] = [];
    const listener = await t.db.pool.connect();
    await listener.query('LISTEN gm_events');
    listener.on('notification', (n) => events.push(JSON.parse(n.payload ?? '{}').type));
    try {
      h.registry.register('migrate', {
        steps: () => [
          step('preflight', async (ctx) => {
            await ctx.runLog('info', 'checking quota', { remaining: 5 });
            return { status: 'succeeded' };
          }),
        ],
      });
      const { runId } = await h.queuedRun();
      await h.execute(runId);
      await until(() => events.includes('run.log'), 'the run.log event');
      expect(events).toContain('run.updated');
      expect(events).toContain('migration.updated');
      const logs = await h.db.runLog.findMany({ where: { runId } });
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        level: 'info',
        message: 'checking quota',
        data: { remaining: 5 },
      });
      expect(logs[0]?.stepId).not.toBeNull();
    } finally {
      listener.release();
    }
  });

  it('[LIF-040] records a skipped Step and its reason', async () => {
    const h = harness();
    h.registry.register('migrate', {
      steps: () => [
        step('target.lift-protection', async () => ({ status: 'skipped', reason: 'no rules' })),
      ],
    });
    const { runId } = await h.queuedRun();
    expect((await h.execute(runId)).outcome).toBe('finished');
    expect(await h.stepStatuses(runId)).toEqual({ 'target.lift-protection': 'skipped' });
    const logs = await h.db.runLog.findMany({ where: { runId } });
    expect(logs.map((l) => l.message)).toEqual(['target.lift-protection skipped: no rules']);
  });

  it('[LIF-040] does not echo credentials from an error into the stored Step error', async () => {
    const h = harness();
    h.registry.register('migrate', {
      steps: () => [
        step(
          'git.prepare',
          async () => {
            throw new Error(`fatal: unable to access https://user:${PASSWORD}@host.test/x.git/`);
          },
          { severity: 'fatal' },
        ),
      ],
    });
    const { runId } = await h.queuedRun();
    await h.execute(runId);
    const [row] = await h.steps(runId);
    expect(JSON.stringify(row?.error)).not.toContain(PASSWORD);
  });
});

describe('[LIF-042] failure semantics', () => {
  const plan = (
    h: Harness,
    failing: { key: string; severity: 'fatal' | 'independent' | 'advisory' },
  ) =>
    h.registry.register('migrate', {
      steps: () =>
        ['preflight', 'git.push-refs', 'facet.webhooks.apply', 'verify'].map((key) =>
          step(
            key,
            async (ctx) => {
              ctx.services.calls.push(key);
              if (key === failing.key) throw new Error(`${key} broke`);
              return { status: 'succeeded' };
            },
            { severity: key === failing.key ? failing.severity : 'independent' },
          ),
        ),
    });

  it('[LIF-042] a fatal Step failure fails the Run, skips the later Steps and fails the Migration', async () => {
    const h = harness();
    plan(h, { key: 'git.push-refs', severity: 'fatal' });
    const { world, runId } = await h.queuedRun();
    expect(await h.execute(runId)).toEqual({ outcome: 'finished', status: 'failed' });
    expect(h.services.calls).toEqual(['preflight', 'git.push-refs']);
    expect(await h.stepStatuses(runId)).toEqual({
      preflight: 'succeeded',
      'git.push-refs': 'failed',
      'facet.webhooks.apply': 'skipped',
      verify: 'skipped',
    });
    expect((await h.run(runId)).error).toMatchObject({
      code: 'run.step_failed',
      step: 'git.push-refs',
    });
    expect((await h.migration(world.migrationId)).status).toBe('failed');
  });

  it('[LIF-042] an independent Step failure is recorded, the rest still run, and the Run ends partial', async () => {
    const h = harness();
    plan(h, { key: 'facet.webhooks.apply', severity: 'independent' });
    const { world, runId } = await h.queuedRun();
    expect(await h.execute(runId)).toEqual({ outcome: 'finished', status: 'partial' });
    expect(h.services.calls).toEqual([
      'preflight',
      'git.push-refs',
      'facet.webhooks.apply',
      'verify',
    ]);
    expect((await h.stepStatuses(runId))['facet.webhooks.apply']).toBe('failed');
    expect((await h.migration(world.migrationId)).status).toBe('partial');
  });

  it('[LIF-042] a failing verify Step never fails the Run', async () => {
    const h = harness();
    plan(h, { key: 'verify', severity: 'advisory' });
    const { world, runId } = await h.queuedRun();
    expect(await h.execute(runId)).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect((await h.stepStatuses(runId)).verify).toBe('failed');
    expect((await h.migration(world.migrationId)).status).toBe('migrated');
  });

  it('[LIF-042] retries a transient error with full-jitter exponential backoff, then succeeds', async () => {
    const h = harness();
    let tries = 0;
    h.registry.register('migrate', {
      steps: () => [
        step('git.push-refs', async () => {
          tries += 1;
          if (tries < 3) throw transient();
          return { status: 'succeeded' };
        }),
      ],
    });
    const { runId } = await h.queuedRun();
    expect(await h.execute(runId)).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect(tries).toBe(3);
    // random() is 0.5: retry 1 waits in [0, 1000), retry 2 in [0, 2000).
    expect(h.sleeps).toEqual([500, 1000]);
    const [row] = await h.steps(runId);
    expect(row).toMatchObject({ attempts: 3, status: 'succeeded', error: null });
  });

  it('[LIF-042] stops retrying after the attempt bound and fails the Step with the stored error', async () => {
    const h = harness();
    let tries = 0;
    h.registry.register('migrate', {
      steps: () => [
        step(
          'git.push-refs',
          async () => {
            tries += 1;
            throw transient('gateway timeout');
          },
          { severity: 'fatal', maxAttempts: 3 },
        ),
      ],
    });
    const { runId } = await h.queuedRun();
    expect(await h.execute(runId)).toEqual({ outcome: 'finished', status: 'failed' });
    expect(tries).toBe(3);
    const [row] = await h.steps(runId);
    expect(row).toMatchObject({ status: 'failed', attempts: 3 });
    expect(row?.error).toMatchObject({ code: 'transient', retryable: true, provider: 'type-a' });
  });

  it('[LIF-042] does not retry an error the provider calls permanent', async () => {
    const h = harness();
    let tries = 0;
    h.registry.register('migrate', {
      steps: () => [
        step('facet.access-control.apply', async () => {
          tries += 1;
          const { AdapterError } = await import('@git-migrator/adapter-sdk');
          throw new AdapterError({ code: 'forbidden', provider: 'type-a', message: 'no' });
        }),
      ],
    });
    const { runId } = await h.queuedRun();
    await h.execute(runId);
    expect(tries).toBe(1);
    expect(h.sleeps).toEqual([]);
  });

  it('[LIF-042] a rate-limited Step pauses the Run: the job is released and re-enqueued after the quota delay', async () => {
    const h = harness();
    let first = true;
    h.registry.register('migrate', {
      steps: () => [
        step('preflight', async (ctx) => {
          ctx.services.calls.push('preflight');
          return { status: 'succeeded' };
        }),
        step('git.push-refs', async (ctx) => {
          ctx.services.calls.push(`push#${ctx.step.delays}`);
          if (first) {
            first = false;
            throw rateLimited(new Date(FIXED_NOW.getTime() + 90_000));
          }
          return { status: 'succeeded' };
        }),
      ],
    });
    const { world, runId } = await h.queuedRun();

    const paused = await h.execute(runId);

    expect(paused).toMatchObject({ outcome: 'delayed', delayMs: 90_000 });
    expect(h.enqueuer.calls).toHaveLength(1);
    expect(h.enqueuer.calls[0]).toMatchObject({ runId, delayMs: 90_000 });
    expect(h.enqueuer.calls[0]?.dedupeId).toMatch(`run-${runId}:handoff-`);
    const mid = await h.run(runId);
    expect(mid.status).toBe('running');
    expect(mid.leaseOwner).toContain('handoff-pending');
    expect(mid.reaperResumes).toBe(0);
    expect(await h.stepStatuses(runId)).toEqual({
      preflight: 'succeeded',
      'git.push-refs': 'pending',
    });
    expect((await h.steps(runId))[1]?.delays).toBe(1);
    expect((await h.migration(world.migrationId)).status).toBe('running');

    // The delayed job arrives: the Run resumes at the first Step that did not succeed.
    const resumed = await h.execute(runId);
    expect(resumed).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect(h.services.calls).toEqual(['preflight', 'push#0', 'push#1']);
    expect((await h.run(runId)).reaperResumes).toBe(0); // a delay is not a reaper resumption
  });

  it('[LIF-042] a Step can ask for a delay itself and sees how often it was delayed', async () => {
    const h = harness();
    h.registry.register('migrate', {
      steps: () => [
        step('git.prepare', async (ctx) =>
          ctx.step.delays < 2
            ? { status: 'delay', delayMs: 600_000, reason: 'scratch space' }
            : { status: 'succeeded' },
        ),
      ],
    });
    const { runId } = await h.queuedRun();
    expect(await h.execute(runId)).toMatchObject({ outcome: 'delayed', delayMs: 600_000 });
    expect(await h.execute(runId)).toMatchObject({ outcome: 'delayed' });
    expect(await h.execute(runId)).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect((await h.steps(runId))[0]?.delays).toBe(2);
  });

  it('[LIF-042] skips a stored unfinished Step the plan no longer contains, and runs the rest', async () => {
    const h = harness();
    h.registry.register('migrate', { steps: () => [tracked('a'), tracked('b')] });
    const { runId } = await h.queuedRun();
    await h.t.db.pool.query(
      "UPDATE app.run SET status = 'running', started_at = now(), lease_owner = NULL WHERE id = $1",
      [runId],
    );
    await h.db.runStep.create({ data: { runId, stepKey: 'old.step', order: 0 } });
    expect(await h.execute(runId)).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect(await h.stepStatuses(runId)).toEqual({
      'old.step': 'skipped',
      a: 'succeeded',
      b: 'succeeded',
    });
    expect((await h.steps(runId))[0]?.error).toEqual({ code: 'run.plan_changed' });
  });
});

describe('[LIF-046] resume, hand-off and the lease fence', () => {
  it('[LIF-046] resumes after a worker death at the first Step that did not succeed, and fences the dead worker', async () => {
    const h = harness();
    const hang = deferred();
    const entered = deferred();
    let died = true;
    h.registry.register('migrate', {
      steps: () => [
        step('preflight', async (ctx) => {
          ctx.services.calls.push('preflight');
          return { status: 'succeeded' };
        }),
        step('git.push-refs', async (ctx) => {
          ctx.services.calls.push('push');
          if (died) {
            died = false;
            entered.resolve();
            await hang.promise; // worker A is frozen here
          }
          return { status: 'succeeded' };
        }),
        step('overlays.apply', async (ctx) => {
          ctx.services.calls.push('overlays');
          return { status: 'succeeded' };
        }),
      ],
    });
    const { world, runId } = await h.queuedRun();
    const workerA = h.execute(runId, { jobId: 'a' });
    await entered.promise;

    // Its lease runs out; the reaper resumes the Run and a second job claims it.
    await h.expireLease(runId);
    const reaped = await reapRuns({ pool: t.db.pool, runs: h.enqueuer.runs, log: silentLog });
    expect(reaped.resumed).toEqual([runId]);
    const workerB = await h.execute(runId, { jobId: 'b' }, { workerId: 'worker-b' });
    expect(workerB).toEqual({ outcome: 'finished', status: 'succeeded' });
    // The finished Step is not run again; the interrupted one is.
    expect(h.services.calls).toEqual(['preflight', 'push', 'push', 'overlays']);
    expect((await h.run(runId)).reaperResumes).toBe(1);

    // Worker A wakes up: every write is fenced, so it changes nothing.
    const before = await h.steps(runId);
    hang.resolve();
    expect(await workerA).toEqual({ outcome: 'lost' });
    expect(await h.steps(runId)).toEqual(before);
    expect((await h.run(runId)).status).toBe('succeeded');
    expect((await h.migration(world.migrationId)).status).toBe('migrated');
  });

  it('[LIF-046] two workers racing for one queued Run: exactly one runs it', async () => {
    const h = harness();
    h.registry.register('migrate', {
      steps: () => [
        step('preflight', async (ctx) => {
          ctx.services.calls.push('preflight');
          await new Promise((r) => setTimeout(r, 30));
          return { status: 'succeeded' };
        }),
        step('git.prepare', async (ctx) => {
          ctx.services.calls.push('prepare');
          return { status: 'succeeded' };
        }),
      ],
    });
    const { runId } = await h.queuedRun();
    const results = await Promise.all([
      h.execute(runId, { jobId: '1' }, { workerId: 'w1' }),
      h.execute(runId, { jobId: '2' }, { workerId: 'w2' }),
      h.execute(runId, { jobId: '3' }, { workerId: 'w1' }),
    ]);
    expect(results.filter((r) => r.outcome === 'finished')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'not_claimed')).toHaveLength(2);
    expect(h.services.calls).toEqual(['preflight', 'prepare']);
    expect((await h.steps(runId)).map((s) => s.attempts)).toEqual([1, 1]);
  });

  it('[LIF-046] a job that finds a finished Run does nothing (idempotent re-delivery)', async () => {
    const h = harness();
    h.registry.register('migrate', {
      steps: () => [tracked('preflight', 'preflight')],
    });
    const { runId } = await h.queuedRun();
    await h.execute(runId);
    const before = await h.steps(runId);
    expect(await h.execute(runId)).toEqual({ outcome: 'not_claimed' });
    expect(h.services.calls).toEqual(['preflight']);
    expect(await h.steps(runId)).toEqual(before);
  });

  it('[LIF-046] re-running a Run whose Step rows already succeeded skips them (resume after a crash between Steps)', async () => {
    const h = harness();
    h.registry.register('migrate', {
      steps: () => [tracked('preflight', 'preflight'), tracked('git.prepare', 'prepare')],
    });
    const { runId } = await h.queuedRun();
    // A worker died after step 0: the Run is running, step 0 succeeded, the lease marker is the reaper's.
    await h.t.db.pool.query(
      "UPDATE app.run SET status = 'running', started_at = now(), lease_owner = 'reaper:resume-pending:x' WHERE id = $1",
      [runId],
    );
    await h.db.runStep.create({
      data: { runId, stepKey: 'preflight', order: 0, status: 'succeeded', attempts: 1 },
    });
    await h.db.runStep.create({ data: { runId, stepKey: 'git.prepare', order: 1 } });
    expect(await h.execute(runId)).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect(h.services.calls).toEqual(['prepare']);
    expect((await h.run(runId)).reaperResumes).toBe(1);
  });

  it('[LIF-046] on SIGTERM finishes the current Step, hands the Run off without counting a resumption, and a resume completes it', async () => {
    const h = harness();
    const shutdown = new AbortController();
    h.registry.register('migrate', {
      steps: () => [
        step('preflight', async (ctx) => {
          ctx.services.calls.push('preflight');
          shutdown.abort(); // SIGTERM arrives during the Step: the Step is not interrupted
          await new Promise((r) => setTimeout(r, 20));
          expect(ctx.signal.aborted).toBe(false);
          return { status: 'succeeded' };
        }),
        tracked('git.prepare', 'prepare'),
      ],
    });
    const { runId } = await h.queuedRun();
    expect(await h.execute(runId, { shutdown: shutdown.signal })).toEqual({
      outcome: 'handed_off',
    });
    expect(h.services.calls).toEqual(['preflight']);
    expect(h.enqueuer.calls).toHaveLength(1);
    expect(h.enqueuer.calls[0]?.delayMs).toBeUndefined();
    expect(await h.stepStatuses(runId)).toEqual({
      preflight: 'succeeded',
      'git.prepare': 'pending',
    });

    expect(await h.execute(runId)).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect(h.services.calls).toEqual(['preflight', 'prepare']);
    expect((await h.run(runId)).reaperResumes).toBe(0);
  });

  it('[LIF-046] a crash of the executor itself leaves the lease to expire, so the reaper counts it', async () => {
    const h = harness();
    h.registry.register('migrate', {
      steps: () => {
        throw new Error('planner bug');
      },
    });
    const { runId } = await h.queuedRun();
    await expect(h.execute(runId)).rejects.toThrow('planner bug');
    const run = await h.run(runId);
    expect(run.status).toBe('running');
    expect(run.leaseOwner).not.toBeNull();
    await h.expireLease(runId);
    const reaped = await reapRuns({ pool: t.db.pool, runs: h.enqueuer.runs, log: silentLog });
    expect(reaped.resumed).toEqual([runId]);
    expect((await h.run(runId)).reaperResumes).toBe(0); // counted once the resumed job claims it
  });
});

describe('[LIF-040] cooperative cancel', () => {
  it('[LIF-040] aborts a long Step through its signal and ends the Run cancelled; the Migration returns to its saved status when nothing was written', async () => {
    const h = harness();
    const started = deferred();
    h.registry.register('migrate', {
      steps: () => [
        tracked('preflight', 'preflight'),
        step('git.push-refs', async (ctx) => {
          ctx.services.calls.push('push');
          started.resolve();
          await new Promise<void>((resolve) =>
            ctx.signal.addEventListener('abort', () => resolve(), { once: true }),
          );
          ctx.checkpoint();
          return { status: 'succeeded' };
        }),
        tracked('overlays.apply', 'overlays'),
      ],
    });
    const { world, runId } = await h.queuedRun();
    const running = h.execute(runId);
    await started.promise;

    expect(await requestRunCancel(h.db, runId)).toBe('requested');

    expect(await running).toEqual({ outcome: 'finished', status: 'cancelled' });
    expect(h.services.calls).toEqual(['preflight', 'push']);
    expect(await h.stepStatuses(runId)).toEqual({
      preflight: 'succeeded',
      'git.push-refs': 'failed',
      'overlays.apply': 'skipped',
    });
    expect((await h.steps(runId))[1]?.error).toMatchObject({ code: 'run.cancelled' });
    const run = await h.run(runId);
    expect(run.status).toBe('cancelled');
    expect(run.cancelRequestedAt).not.toBeNull();
    // [LIF-002] no Mutation was recorded: back to the status before the Run.
    expect((await h.migration(world.migrationId)).status).toBe('analyzed');
  });

  it('[LIF-040] a cancelled Run that recorded a Mutation leaves the Migration partial (LIF-002)', async () => {
    const h = harness();
    const started = deferred();
    h.registry.register('migrate', {
      steps: () => [
        step('target.ensure-repository', async (ctx) => {
          await ctx.ledger.record({ side: 'target', origin: 'framework' }, [
            {
              facetKey: null,
              action: 'create',
              resourceRef: { type: 'repo', id: 'r1' },
              paths: ['/repository'],
              before: null,
              after: { id: 'r1' },
            },
          ]);
          started.resolve();
          await new Promise<void>((resolve) =>
            ctx.signal.addEventListener('abort', () => resolve(), { once: true }),
          );
          ctx.checkpoint();
          return undefined;
        }),
      ],
    });
    const { world, runId } = await h.queuedRun();
    const running = h.execute(runId);
    await started.promise;
    await requestRunCancel(h.db, runId);
    expect(await running).toEqual({ outcome: 'finished', status: 'cancelled' });
    expect((await h.run(runId)).hasMutations).toBe(true);
    expect((await h.migration(world.migrationId)).status).toBe('partial');
  });

  it('[LIF-040] checks for a cancel between Steps, even when a Step ignores its signal', async () => {
    const h = harness();
    h.registry.register('migrate', {
      steps: () => [
        step('preflight', async (ctx) => {
          ctx.services.calls.push('preflight');
          // Cancel is requested while the Step runs; this Step does not look at the signal.
          await requestRunCancel(h.db, ctx.run.id);
          return { status: 'succeeded' };
        }),
        tracked('git.prepare', 'prepare'),
      ],
    });
    const { runId } = await h.queuedRun();
    expect(await h.execute(runId)).toEqual({ outcome: 'finished', status: 'cancelled' });
    expect(h.services.calls).toEqual(['preflight']);
    expect(await h.stepStatuses(runId)).toEqual({
      preflight: 'succeeded',
      'git.prepare': 'skipped',
    });
  });

  it('[LIF-040] cancelling a queued Run finishes it at once and a later job does nothing', async () => {
    const h = harness();
    h.registry.register('migrate', { steps: () => [step('preflight')] });
    const { world, runId } = await h.queuedRun();
    expect(await requestRunCancel(h.db, runId)).toBe('cancelled');
    expect((await h.run(runId)).status).toBe('cancelled');
    expect((await h.migration(world.migrationId)).status).toBe('analyzed');
    expect(await h.execute(runId)).toEqual({ outcome: 'not_claimed' });
    expect(await h.steps(runId)).toEqual([]);
    expect(await requestRunCancel(h.db, runId)).toBe('finished');
    expect(await requestRunCancel(h.db, '00000000-0000-0000-0000-000000000000')).toBe('missing');
  });

  it('[LIF-040] a cancel that arrives while a retryable Step waits to retry stops the retry', async () => {
    const h = harness();
    let tries = 0;
    h.registry.register('migrate', {
      steps: () => [
        step('git.push-refs', async (ctx) => {
          tries += 1;
          await requestRunCancel(h.db, ctx.run.id);
          throw transient();
        }),
      ],
    });
    const { runId } = await h.queuedRun();
    expect(await h.execute(runId)).toEqual({ outcome: 'finished', status: 'cancelled' });
    expect(tries).toBe(1);
  });
});

describe('[LIF-022] the inline Analysis before a Run', () => {
  const planOne = (h: Harness) =>
    h.registry.register('migrate', {
      steps: () => [tracked('preflight', 'preflight')],
    });

  it('[LIF-022] aborts with readiness_changed when re-analysis made the readiness worse, before any Step', async () => {
    const h = harness();
    planOne(h);
    h.analysis = {
      run: async () => ({ reanalyzed: true, before: 'ready', after: 'blocked', worsened: true }),
      recordFailure: async () => undefined,
    };
    const { world, runId } = await h.queuedRun();
    expect(await h.execute(runId)).toEqual({ outcome: 'finished', status: 'cancelled' });
    expect(h.services.calls).toEqual([]);
    expect(await h.steps(runId)).toEqual([]);
    const run = await h.run(runId);
    expect(run.error).toEqual({ code: 'readiness_changed', before: 'ready', after: 'blocked' });
    expect((await h.migration(world.migrationId)).status).toBe('analyzed');
  });

  it('[LIF-021] proceeds and records the Analysis the Run used when the readiness did not get worse', async () => {
    const h = harness();
    planOne(h);
    h.analysis = {
      run: async () => ({ reanalyzed: true, before: 'ready', after: 'ready', worsened: false }),
      recordFailure: async () => undefined,
    };
    const { world, runId } = await h.queuedRun();
    const analysis = await h.db.analysis.create({
      data: {
        migrationId: world.migrationId,
        readiness: 'ready',
        sourceSnapshotIds: [],
        targetSnapshotIds: [],
        translation: {},
      },
    });
    await h.db.migration.update({
      where: { id: world.migrationId },
      data: { latestAnalysisId: analysis.id },
    });
    expect(await h.execute(runId)).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect((await h.run(runId)).analysisId).toBe(analysis.id);
  });

  it('[LIF-022] fails the Run, and writes the failure marker, when the inline Analysis throws', async () => {
    const h = harness();
    planOne(h);
    const marked: string[] = [];
    h.analysis = {
      run: async () => {
        throw new Error('route has a retired endpoint');
      },
      recordFailure: async (id) => {
        marked.push(id);
      },
    };
    const { world, runId } = await h.queuedRun();
    expect(await h.execute(runId)).toEqual({ outcome: 'finished', status: 'failed' });
    expect(marked).toEqual([world.migrationId]);
    expect((await h.run(runId)).error).toMatchObject({ code: 'run.analysis_failed' });
    expect(h.services.calls).toEqual([]);
  });

  it('[LIF-022] a rate-limited inline Analysis delays the Run instead of failing it', async () => {
    const h = harness();
    planOne(h);
    h.analysis = {
      run: async () => {
        throw rateLimited();
      },
      recordFailure: async () => undefined,
    };
    const { runId } = await h.queuedRun();
    expect(await h.execute(runId)).toMatchObject({ outcome: 'delayed', delayMs: 30_000 });
    expect((await h.run(runId)).status).toBe('running');
  });

  it('[LIF-022] does not analyze for kinds the gate does not cover', async () => {
    const h = harness();
    h.registry.register('verify', {
      steps: () => [tracked('verify', 'verify')],
    });
    h.analysis = {
      run: async () => {
        throw new Error('must not be called');
      },
      recordFailure: async () => undefined,
    };
    const { runId } = await h.queuedRun('verify');
    expect(await h.execute(runId)).toEqual({ outcome: 'finished', status: 'succeeded' });
  });
});
