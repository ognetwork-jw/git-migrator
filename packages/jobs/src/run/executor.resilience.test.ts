import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { defaultSleep } from './executor.ts';
import { requestRunCancel } from './guard.ts';
import {
  deferred,
  Harness,
  rateLimited,
  step,
  tracked,
  transient,
  until,
} from './harness.fixture.ts';
import type { StepDefinition } from './types.ts';

// These tests wait on a real database; a loaded CI box needs more than the 5 s default.
vi.setConfig({ testTimeout: 30_000 });

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase('gm_t070d_');
}, 120_000);
afterAll(async () => {
  await t?.drop();
}, 60_000);

const harness = () => new Harness(t);

/** Runs every delayed or handed-off job until the Run finishes. */
async function drain(h: Harness, runId: string, limit = 12) {
  for (let i = 0; i < limit; i++) {
    const result = await h.execute(runId);
    if (result.outcome === 'finished') return result;
  }
  throw new Error('the Run did not finish');
}

describe('[LIF-042] the retry budget counts failures, not delays', () => {
  it('[LIF-042] four rate limits followed by one transient error do not exhaust a budget of four', async () => {
    const h = harness();
    let calls = 0;
    h.registry.register('migrate', {
      steps: () => [
        step('git.push-refs', async () => {
          calls += 1;
          if (calls <= 4) throw rateLimited();
          if (calls === 5) throw transient();
          return { status: 'succeeded' };
        }),
      ],
    });
    const { runId } = await h.queuedRun();
    expect(await drain(h, runId)).toEqual({ outcome: 'finished', status: 'succeeded' });
    const [row] = await h.steps(runId);
    expect(row).toMatchObject({ status: 'succeeded', delays: 4, failures: 1, attempts: 6 });
  });

  it('[LIF-042] a Step delayed by itself keeps its full budget', async () => {
    const h = harness();
    h.registry.register('migrate', {
      steps: () => [
        step('git.prepare', async (ctx) =>
          ctx.step.delays < 6
            ? { status: 'delay', delayMs: 1_000, reason: 'scratch space' }
            : { status: 'succeeded' },
        ),
      ],
    });
    const { runId } = await h.queuedRun();
    await drain(h, runId, 10);
    const [row] = await h.steps(runId);
    expect(row).toMatchObject({ delays: 6, failures: 0, status: 'succeeded' });
  });

  it('[LIF-042] crashes of earlier workers count: a Step found running at its last attempt fails instead of running again', async () => {
    const h = harness();
    let runs = 0;
    h.registry.register('migrate', {
      steps: () => [
        step(
          'git.push-refs',
          async () => {
            runs += 1;
            return { status: 'succeeded' };
          },
          { severity: 'fatal', maxAttempts: 3 },
        ),
      ],
    });
    const { runId } = await h.queuedRun();
    await h.t.db.pool.query(
      "UPDATE app.run SET status = 'running', started_at = now(), lease_owner = NULL WHERE id = $1",
      [runId],
    );
    // Two workers already died in this Step; the next crash is the third failure.
    await h.db.runStep.create({
      data: {
        runId,
        stepKey: 'git.push-refs',
        order: 0,
        status: 'running',
        attempts: 3,
        failures: 2,
      },
    });
    expect(await h.execute(runId)).toEqual({ outcome: 'finished', status: 'failed' });
    expect(runs).toBe(0);
    const [row] = await h.steps(runId);
    expect(row).toMatchObject({ status: 'failed', failures: 3 });
    expect(row?.error).toMatchObject({ code: 'step.attempts_exhausted' });
  });

  it('[LIF-042] a Step found running below the bound runs again and counts the crash', async () => {
    const h = harness();
    h.registry.register('migrate', { steps: () => [tracked('git.push-refs')] });
    const { runId } = await h.queuedRun();
    await h.t.db.pool.query(
      "UPDATE app.run SET status = 'running', started_at = now(), lease_owner = NULL WHERE id = $1",
      [runId],
    );
    await h.db.runStep.create({
      data: {
        runId,
        stepKey: 'git.push-refs',
        order: 0,
        status: 'running',
        attempts: 1,
        failures: 0,
      },
    });
    expect(await h.execute(runId)).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect((await h.steps(runId))[0]).toMatchObject({ failures: 1, attempts: 2 });
  });
});

describe('[LIF-040] a plan that changes between a start and a resume', () => {
  it('[LIF-040] runs a Step that was added once, and a later Step once, in the new plan order', async () => {
    const h = harness();
    let plan: StepDefinition<typeof h.services>[] = [];
    let pause = true;
    const a = tracked('a');
    const b = step('b', async (ctx) => {
      ctx.services.calls.push('b');
      if (pause) {
        pause = false;
        return { status: 'delay', delayMs: 1_000, reason: 'test' };
      }
      return { status: 'succeeded' };
    });
    const c = tracked('c');
    const x = tracked('x');
    plan = [a, b, c];
    h.registry.register('migrate', { steps: () => plan });
    const { runId } = await h.queuedRun();
    expect((await h.execute(runId)).outcome).toBe('delayed');

    plan = [a, x, b, c]; // a deploy added x between a and b while the Run waited
    expect(await h.execute(runId)).toEqual({ outcome: 'finished', status: 'succeeded' });

    expect(h.services.calls).toEqual(['a', 'b', 'x', 'b', 'c']);
    expect(await h.stepStatuses(runId)).toEqual({
      a: 'succeeded',
      b: 'succeeded',
      c: 'succeeded',
      x: 'succeeded',
    });
    // Existing rows keep their place; the new Step is appended.
    expect((await h.steps(runId)).map((s) => s.stepKey)).toEqual(['a', 'b', 'c', 'x']);
  });

  it('[LIF-040] identifies a Step by key and Facet', async () => {
    const h = harness();
    h.registry.register('migrate', {
      steps: () => [
        step('facet.x.apply', async (ctx) => (ctx.services.calls.push('one'), undefined), {
          facetKey: 'one',
        }),
        step('facet.x.apply', async (ctx) => (ctx.services.calls.push('two'), undefined), {
          facetKey: 'two',
        }),
      ],
    });
    const { runId } = await h.queuedRun();
    await h.execute(runId);
    expect(h.services.calls).toEqual(['one', 'two']);
    expect(await h.steps(runId)).toHaveLength(2);
  });
});

describe('[LIF-005] readiness when the Run starts', () => {
  it('[LIF-005] ends the Run cancelled with readiness_changed when the Migration became blocked while it was queued', async () => {
    const h = harness();
    h.registry.register('migrate', { steps: () => [tracked('preflight')] });
    const { world, runId } = await h.queuedRun();
    await h.db.migration.update({
      where: { id: world.migrationId },
      data: { readiness: 'blocked' },
    });
    expect(await h.execute(runId)).toEqual({ outcome: 'finished', status: 'cancelled' });
    expect(h.services.calls).toEqual([]);
    expect((await h.run(runId)).error).toMatchObject({
      code: 'readiness_changed',
      after: 'blocked',
    });
    expect((await h.migration(world.migrationId)).status).toBe('analyzed');
  });

  it('[LIF-043] a force-adopt Run starts on a Migration blocked only by target.exists-nonempty, and no other blocker', async () => {
    const h = harness();
    h.registry.register('migrate', { steps: () => [tracked('preflight')] });
    const adopt = async (codes: string[]) => {
      const { world, runId } = await h.queuedRun();
      await h.db.run.update({ where: { id: runId }, data: { options: { adoptNonEmpty: true } } });
      await h.db.migration.update({
        where: { id: world.migrationId },
        data: {
          readiness: 'blocked',
          blockerCodes: codes,
          readinessCounts: { blockers: codes.length, preTasks: 0, postTasks: 0, warnings: 0 },
        },
      });
      return runId;
    };
    expect(await h.execute(await adopt(['target.exists-nonempty']))).toEqual({
      outcome: 'finished',
      status: 'succeeded',
    });
    const refused = await adopt(['target.exists-nonempty', 'change-requests.open']);
    expect(await h.execute(refused)).toEqual({ outcome: 'finished', status: 'cancelled' });
    expect((await h.run(refused)).error).toMatchObject({ code: 'readiness_changed' });
  });

  it('[LIF-005] lets a run_anyway Run start on needs_attention', async () => {
    const h = harness();
    h.registry.register('run_anyway', { steps: () => [tracked('preflight')] });
    const { runId } = await h.queuedRun('run_anyway', { readiness: 'needs_attention' });
    expect(await h.execute(runId)).toEqual({ outcome: 'finished', status: 'succeeded' });
  });
});

describe('[LIF-040] cancel and SIGTERM reach a Step that waits to retry', () => {
  // The sleep is a minute long: the test only ends in time if the signal wakes it.
  const longSleep = (_ms: number, signal: AbortSignal) => defaultSleep(60_000, signal);

  it('[LIF-040] a cancel wakes the retry wait', async () => {
    const h = harness();
    const failed = deferred();
    h.registry.register('migrate', {
      steps: () => [
        step('git.push-refs', async () => {
          failed.resolve();
          throw transient();
        }),
      ],
    });
    const { runId } = await h.queuedRun();
    const running = h.execute(runId, {}, { sleep: longSleep });
    await failed.promise;
    await requestRunCancel(h.db, runId);
    expect(await running).toEqual({ outcome: 'finished', status: 'cancelled' });
    expect(await h.stepStatuses(runId)).toEqual({ 'git.push-refs': 'failed' });
  }, 20_000);

  it('[LIF-046] SIGTERM wakes the retry wait; the Run is handed off and the retry is not counted twice', async () => {
    const h = harness();
    const failed = deferred();
    const shutdown = new AbortController();
    let calls = 0;
    h.registry.register('migrate', {
      steps: () => [
        step('git.push-refs', async () => {
          calls += 1;
          if (calls === 1) {
            failed.resolve();
            throw transient();
          }
          return { status: 'succeeded' };
        }),
      ],
    });
    const { runId } = await h.queuedRun();
    const running = h.execute(runId, { shutdown: shutdown.signal }, { sleep: longSleep });
    await failed.promise;
    await until(async () => (await h.steps(runId))[0]?.failures === 1, 'the failure to be counted');
    shutdown.abort();
    expect(await running).toEqual({ outcome: 'handed_off' });
    const [row] = await h.steps(runId);
    expect(row).toMatchObject({ status: 'pending', failures: 1 });
    expect(h.enqueuer.calls).toHaveLength(1);

    expect(await h.execute(runId)).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect((await h.steps(runId))[0]?.failures).toBe(1); // the hand-off was not a crash
  }, 20_000);
});

describe('[LIF-040] cancel while the Run waits for a delayed job', () => {
  it('[LIF-040] finishes the Run at once instead of leaving it to the delayed job', async () => {
    const h = harness();
    h.registry.register('migrate', {
      steps: () => [
        tracked('preflight'),
        step('git.push-refs', async () => {
          throw rateLimited();
        }),
      ],
    });
    const { world, runId } = await h.queuedRun();
    expect((await h.execute(runId)).outcome).toBe('delayed');
    expect((await h.run(runId)).leaseOwner).toContain('handoff-pending');

    expect(await requestRunCancel(h.db, runId)).toBe('cancelled');

    const run = await h.run(runId);
    expect(run).toMatchObject({ status: 'cancelled', leaseOwner: null });
    expect(await h.stepStatuses(runId)).toEqual({
      preflight: 'succeeded',
      'git.push-refs': 'skipped',
    });
    expect((await h.migration(world.migrationId)).status).toBe('analyzed');
    // The delayed job arrives later and finds a finished Run.
    expect(await h.execute(runId)).toEqual({ outcome: 'not_claimed' });
  });
});

describe('[LIF-049] findings cleared by a Step, and their events', () => {
  const blocker = { code: 'git-refs.blob-too-large', params: {}, at: '2026-10-09T00:00:00.000Z' };

  it('[LIF-049] clears the blockers a Step guards when it succeeds, and only then', async () => {
    const h = harness();
    let fail = true;
    h.registry.register('migrate', {
      steps: () => [
        step(
          'git.prepare',
          async () => {
            if (fail) throw new Error('clone failed');
            return { status: 'succeeded' };
          },
          { clearsBlockers: ['git-refs.blob-too-large'], severity: 'independent' },
        ),
      ],
    });
    const first = await h.queuedRun();
    await h.db.migration.update({
      where: { id: first.world.migrationId },
      data: { runBlockers: [blocker] },
    });
    await h.execute(first.runId);
    expect((await h.migration(first.world.migrationId)).runBlockers).toHaveLength(1);

    fail = false;
    const second = await h.queuedRun();
    await h.db.migration.update({
      where: { id: second.world.migrationId },
      data: { runBlockers: [blocker] },
    });
    await h.execute(second.runId);
    const cleared = await h.migration(second.world.migrationId);
    expect(cleared.runBlockers).toEqual([]);
    expect(cleared.blockerCodes).toEqual([]);
  });

  it('[LIF-049] publishes migration.updated when a Step adds a finding', async () => {
    const h = harness();
    const events: string[] = [];
    const proceed = deferred();
    h.registry.register('migrate', {
      steps: () => [
        step('facet.deploy-keys.apply', async (ctx) => {
          await ctx.findings.addTask({
            code: 'deploy-keys.key-in-use',
            facetKey: 'deploy-keys',
            phase: 'post',
          });
          await proceed.promise; // hold the Run so only the finding can have published
          return undefined;
        }),
      ],
    });
    const { runId } = await h.queuedRun();
    const listener = await t.db.pool.connect();
    await listener.query('LISTEN gm_events');
    listener.on('notification', (n) => events.push(JSON.parse(n.payload ?? '{}').type));
    try {
      const running = h.execute(runId);
      await until(() => events.includes('migration.updated'), 'migration.updated');
      proceed.resolve();
      await running;
    } finally {
      listener.release();
    }
  });
});

describe('[JOB-060] the Run log never fails a Step', () => {
  it('[JOB-060] truncates over-large structured data and scrubs secrets in smaller data', async () => {
    const h = harness();
    h.registry.register('migrate', {
      steps: () => [
        step('preflight', async (ctx) => {
          await ctx.runLog('info', 'huge', { blob: 'x'.repeat(2 * 1024 * 1024) });
          await ctx.runLog('info', 'headers', {
            authorization: ['Bearer ', 'abc', 'def', '1234567890'].join(''),
            ok: 1,
          });
          await ctx.runLog(
            'info',
            'cyclic',
            (() => {
              const o: Record<string, unknown> = {};
              o.self = o;
              return o;
            })(),
          );
          return undefined;
        }),
      ],
    });
    const { runId } = await h.queuedRun();
    expect(await h.execute(runId)).toEqual({ outcome: 'finished', status: 'succeeded' });
    const logs = await h.db.runLog.findMany({ where: { runId }, orderBy: { ts: 'asc' } });
    const huge = logs.find((l) => l.message === 'huge');
    expect(huge?.data).toMatchObject({ truncated: true });
    const headers = logs.find((l) => l.message === 'headers');
    expect(JSON.stringify(headers?.data)).not.toContain('1234567890');
    expect(headers?.data).toMatchObject({ ok: 1 });
    expect(logs.find((l) => l.message === 'cyclic')).toBeUndefined(); // dropped, not thrown
  });
});

describe('[LIF-049] a Step that fails for good can name what the failure leaves behind', () => {
  const failing = (seen: string[], body: StepDefinition<never>['run']) =>
    step(
      'git.push-refs',
      body as never,
      {
        severity: 'fatal',
        maxAttempts: 2,
        onFailed: async (_ctx: unknown, error: Readonly<Record<string, unknown>>) => {
          seen.push(String(error.code));
        },
      } as never,
    );

  it('[LIF-049] runs on a non-retryable failure', async () => {
    const h = harness();
    const seen: string[] = [];
    h.registry.register('migrate', {
      steps: () => [
        failing(seen, async () => {
          throw new Error('rejected');
        }),
      ],
    });
    const { runId } = await h.queuedRun();
    expect(await h.execute(runId)).toEqual({ outcome: 'finished', status: 'failed' });
    expect(seen).toEqual(['step.error']);
  });

  it('[LIF-049] runs when the retry budget is spent, and when earlier crashes spent it', async () => {
    const h = harness();
    const seen: string[] = [];
    h.registry.register('migrate', {
      steps: () => [
        failing(seen, async () => {
          throw transient();
        }),
      ],
    });
    const { runId } = await h.queuedRun();
    expect(await h.execute(runId)).toEqual({ outcome: 'finished', status: 'failed' });
    expect(seen).toEqual(['transient']);

    const crashed = harness();
    const seenCrash: string[] = [];
    crashed.registry.register('migrate', {
      steps: () => [failing(seenCrash, async () => undefined)],
    });
    const second = await crashed.queuedRun();
    await crashed.t.db.pool.query(
      "UPDATE app.run SET status = 'running', started_at = now(), lease_owner = NULL WHERE id = $1",
      [second.runId],
    );
    await crashed.db.runStep.create({
      data: {
        runId: second.runId,
        stepKey: 'git.push-refs',
        order: 0,
        status: 'running',
        attempts: 2,
        failures: 1,
      },
    });
    expect(await crashed.execute(second.runId)).toEqual({ outcome: 'finished', status: 'failed' });
    expect(seenCrash).toEqual(['step.attempts_exhausted']);
  });

  it('[LIF-049] does not run on success or on a retry that succeeds', async () => {
    const h = harness();
    const seen: string[] = [];
    let tries = 0;
    h.registry.register('migrate', {
      steps: () => [
        failing(seen, async () => {
          tries += 1;
          if (tries === 1) throw transient();
          return { status: 'succeeded' };
        }),
      ],
    });
    const { runId } = await h.queuedRun();
    expect(await h.execute(runId)).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect(seen).toEqual([]);
  });

  it('[LIF-049] a fault in the hook never changes how the Run ends', async () => {
    const h = harness();
    h.registry.register('migrate', {
      steps: () => [
        step(
          'git.push-refs',
          async () => {
            throw new Error('rejected');
          },
          {
            severity: 'fatal',
            onFailed: async () => {
              throw new Error('a broken hook');
            },
          } as never,
        ),
      ],
    });
    const { runId } = await h.queuedRun();
    expect(await h.execute(runId)).toEqual({ outcome: 'finished', status: 'failed' });
  });
});
