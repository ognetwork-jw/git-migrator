import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { reapRuns } from '../reaper.ts';
import { createRun, requestRunCancel } from './guard.ts';
import {
  deferred,
  Harness,
  rateLimited,
  silentLog,
  step,
  transient,
  until,
} from './harness.fixture.ts';
import { confirmLedger, writeLedger } from './ledger.ts';
import { ledgerTransaction } from './store.ts';
import type { MutationLike } from './types.ts';

// These tests wait on a real database; a loaded CI box needs more than the 5 s default.
vi.setConfig({ testTimeout: 30_000 });

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase('gm_t070g_');
}, 120_000);
afterAll(async () => {
  await t?.drop();
}, 60_000);

const record = (id: string, over: Partial<MutationLike> = {}): MutationLike => ({
  facetKey: 'branch-rules',
  action: 'create',
  resourceRef: { type: 'rule', id },
  paths: [`/rules[id=${id}]`],
  before: null,
  after: { id },
  ...over,
});

/** What a straggler worker does: writes a record to a Run through the ledger's own transaction. */
async function lateWrite(h: Harness, runId: string, migrationId: string, routeId: string) {
  await ledgerTransaction(
    h.db,
    runId,
    (tx) =>
      writeLedger(
        tx,
        { runId, migrationId, routeId },
        { side: 'target', origin: 'desired' },
        [record('late')],
        new Date(),
      ),
    { log: silentLog },
  );
}

/** A cancelled Run with no Mutation, as a cancel of a delayed (hand-off) Run leaves it. */
async function cancelledWithoutMutation(h: Harness) {
  h.registry.register('migrate', {
    steps: () => [
      step('git.push-refs', async () => {
        throw rateLimited();
      }),
    ],
  });
  const made = await h.queuedRun();
  expect((await h.execute(made.runId)).outcome).toBe('delayed');
  expect(await requestRunCancel(h.db, made.runId)).toBe('cancelled');
  expect((await h.migration(made.world.migrationId)).status).toBe('analyzed');
  return made;
}

describe('[LIF-002] a write that lands after the Run finished', () => {
  it('[LIF-002] N1: a cancel of a run the reaper resumed only requests the cancel; the late record then makes the cancelled Run partial', async () => {
    const h = new Harness(t);
    const entered = deferred();
    const gate = deferred();
    h.registry.register('migrate', {
      steps: () => [
        step('target.ensure-repository', async (ctx) => {
          entered.resolve();
          await gate.promise;
          await ctx.ledger.record({ side: 'target', origin: 'framework' }, [record('repo')]);
          return undefined;
        }),
      ],
    });
    const { world, runId } = await h.queuedRun();
    const workerA = h.execute(runId, { jobId: 'a' });
    await entered.promise;
    // The reaper replaces the lease with a resume marker while worker A is still alive.
    await h.expireLease(runId);
    expect(
      (await reapRuns({ pool: t.db.pool, runs: h.enqueuer.runs, log: silentLog })).resumed,
    ).toEqual([runId]);

    // The cancel must not finish the Run behind worker A's back.
    expect(await requestRunCancel(h.db, runId)).toBe('requested');
    expect((await h.run(runId)).status).toBe('running');

    gate.resolve();
    expect(await workerA).toEqual({ outcome: 'lost' });
    expect((await h.run(runId)).hasMutations).toBe(true); // the record landed

    // The resumed job sees the cancel request and ends the Run with the Mutation counted.
    expect(await h.execute(runId, { jobId: 'b' }, { workerId: 'worker-b' })).toEqual({
      outcome: 'finished',
      status: 'cancelled',
    });
    expect((await h.migration(world.migrationId)).status).toBe('partial');
  });

  it('[LIF-002] a late first record of a cancelled Run makes the Migration partial', async () => {
    const h = new Harness(t);
    const { world, runId } = await cancelledWithoutMutation(h);
    await lateWrite(h, runId, world.migrationId, world.routeId);
    expect((await h.run(runId)).hasMutations).toBe(true);
    expect((await h.migration(world.migrationId)).status).toBe('partial');
  });

  it('[LIF-049] a late record when a later Run exists adds the run.late-mutation blocker and marks the Analysis stale', async () => {
    const h = new Harness(t);
    const { world, runId } = await cancelledWithoutMutation(h);
    const later = await createRun(h.db, {
      migrationId: world.migrationId,
      kind: 'verify',
      triggeredById: world.actorId,
    });
    const before = (await h.migration(world.migrationId)).staleGeneration;

    await lateWrite(h, runId, world.migrationId, world.routeId);

    const migration = await h.migration(world.migrationId);
    expect(migration.status).toBe('running'); // the later Run's status is not rewritten
    expect(migration.runBlockers).toEqual([
      {
        code: 'run.late-mutation',
        params: { runId, mutationId: expect.any(String) },
        at: expect.any(String),
      },
    ]);
    expect(migration.blockerCodes).toEqual(['run.late-mutation']);
    expect(migration.staleGeneration).toBeGreaterThan(before);
    expect((await h.run(later.runId)).status).toBe('queued');
  });

  it('[LIF-002] a second late record to the partial Migration adds the blocker: only the first Mutation of a cancelled Run is folded into the status', async () => {
    const h = new Harness(t);
    const { world, runId } = await cancelledWithoutMutation(h);
    await lateWrite(h, runId, world.migrationId, world.routeId);
    expect((await h.migration(world.migrationId)).runBlockers).toEqual([]);
    await lateWrite(h, runId, world.migrationId, world.routeId);
    const migration = await h.migration(world.migrationId);
    expect(migration.status).toBe('partial');
    expect(migration.blockerCodes).toEqual(['run.late-mutation']);
  });

  it('[LIF-049] Q3: a late record to a succeeded Run with no later Run adds the blocker and marks the Analysis stale', async () => {
    const h = new Harness(t);
    h.registry.register('migrate', { steps: () => [step('preflight')] });
    const { world, runId } = await h.queuedRun();
    await h.execute(runId);
    const before = (await h.migration(world.migrationId)).staleGeneration;
    await lateWrite(h, runId, world.migrationId, world.routeId);
    const migration = await h.migration(world.migrationId);
    expect(migration.status).toBe('migrated');
    expect(migration.runBlockers).toEqual([
      {
        code: 'run.late-mutation',
        params: { runId, mutationId: expect.any(String) },
        at: expect.any(String),
      },
    ]);
    expect(migration.readiness).toBe('blocked');
    expect(migration.staleGeneration).toBeGreaterThan(before);
  });

  it('[LIF-049] Q1: a late record from a failed Run after a successful rollback is flagged; the status stays rolled_back', async () => {
    const h = new Harness(t);
    h.registry.register('migrate', {
      steps: () => [
        step(
          'git.push-refs',
          async () => {
            throw new Error('push failed');
          },
          { severity: 'fatal' },
        ),
      ],
    });
    h.registry.register('rollback', { steps: () => [step('rollback')] });
    const { world, runId } = await h.queuedRun();
    await h.execute(runId);
    expect((await h.migration(world.migrationId)).status).toBe('failed');
    const rollback = await createRun(h.db, {
      migrationId: world.migrationId,
      kind: 'rollback',
      triggeredById: world.actorId,
    });
    await h.execute(rollback.runId);
    expect((await h.migration(world.migrationId)).status).toBe('rolled_back');
    const before = (await h.migration(world.migrationId)).staleGeneration;

    await lateWrite(h, runId, world.migrationId, world.routeId); // a straggler of the failed Run

    const migration = await h.migration(world.migrationId);
    expect(migration.status).toBe('rolled_back');
    expect(migration.blockerCodes).toEqual(['run.late-mutation']);
    expect(migration.runBlockers).toMatchObject([{ code: 'run.late-mutation', params: { runId } }]);
    expect(migration.staleGeneration).toBeGreaterThan(before);
  });
});

describe('[LIF-045] ledger conflicts that outlast the retries', () => {
  it('[LIF-045] N2: five conflicts fail the attempt with a retryable error, and the Step retries and records the change', async () => {
    const h = new Harness(t);
    h.registry.register('migrate', {
      steps: () => [
        step('facet.branch-rules.apply', async (ctx) => {
          await ctx.ledger.record({ side: 'target', origin: 'desired' }, [record('r1')]);
          return undefined;
        }),
      ],
    });
    const { runId } = await h.queuedRun();
    await t.db.pool.query('CREATE SEQUENCE app.t070g_attempts');
    await t.db.pool.query(`
      CREATE FUNCTION app.t070g_conflict() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF nextval('app.t070g_attempts') <= 5 THEN
          RAISE EXCEPTION 'deadlock detected' USING ERRCODE = '40P01';
        END IF;
        RETURN NEW;
      END $$`);
    await t.db.pool.query(
      'CREATE TRIGGER t070g BEFORE INSERT ON app.mutation FOR EACH ROW EXECUTE FUNCTION app.t070g_conflict()',
    );
    try {
      expect(await h.execute(runId)).toEqual({ outcome: 'finished', status: 'succeeded' });
    } finally {
      await t.db.pool.query('DROP TRIGGER t070g ON app.mutation');
    }
    const [row] = await h.steps(runId);
    expect(row).toMatchObject({ status: 'succeeded', failures: 1, attempts: 2 });
    const rows = await t.db.pool.query('SELECT 1 FROM app.mutation WHERE run_id = $1', [runId]);
    expect(rows.rowCount).toBe(1);
  }, 30_000);
});

describe('[LIF-042] a fatal Step keeps its severity when it leaves the plan', () => {
  it('[LIF-042] N3: a stored failed fatal Step fails the Run even if the new plan no longer contains it', async () => {
    const h = new Harness(t);
    h.registry.register('migrate', { steps: () => [step('after', async () => undefined)] });
    const { runId } = await h.queuedRun();
    await h.t.db.pool.query(
      "UPDATE app.run SET status = 'running', started_at = now(), lease_owner = NULL WHERE id = $1",
      [runId],
    );
    await h.db.runStep.create({
      data: { runId, stepKey: 'git.push-refs', order: 0, status: 'failed', severity: 'fatal' },
    });
    expect(await h.execute(runId)).toEqual({ outcome: 'finished', status: 'failed' });
    expect(await h.stepStatuses(runId)).toEqual({ 'git.push-refs': 'failed', after: 'skipped' });
  });

  it('[LIF-042] a fatal Step that was started and then left the plan fails the Run; one never attempted, or an independent one, is skipped', async () => {
    const h = new Harness(t);
    h.registry.register('migrate', { steps: () => [step('after', async () => undefined)] });
    const { runId } = await h.queuedRun();
    await h.t.db.pool.query(
      "UPDATE app.run SET status = 'running', started_at = now(), lease_owner = NULL WHERE id = $1",
      [runId],
    );
    await h.db.runStep.create({
      data: { runId, stepKey: 'old.running', order: 0, status: 'running', severity: 'fatal' },
    });
    await h.db.runStep.create({
      data: { runId, stepKey: 'old.retried', order: 1, severity: 'fatal', failures: 1 },
    });
    await h.db.runStep.create({
      data: { runId, stepKey: 'old.never', order: 2, severity: 'fatal' },
    });
    await h.db.runStep.create({
      data: { runId, stepKey: 'old.independent', order: 3, severity: 'independent' },
    });
    expect(await h.execute(runId)).toEqual({ outcome: 'finished', status: 'failed' });
    const statuses = await h.stepStatuses(runId);
    expect(statuses['old.running']).toBe('failed');
    expect(statuses['old.retried']).toBe('failed');
    expect(statuses['old.never']).toBe('skipped');
    expect(statuses['old.independent']).toBe('skipped');
  });

  it('[LIF-042] a fatal Step that ran, recorded a Mutation and was delayed by a rate limit fails the Run when it leaves the plan', async () => {
    const h = new Harness(t);
    h.registry.register('migrate', {
      steps: () => [
        step(
          'target.ensure-repository',
          async (ctx) => {
            await ctx.ledger.record({ side: 'target', origin: 'desired' }, [record('repo')]);
            throw rateLimited();
          },
          { severity: 'fatal' },
        ),
      ],
    });
    const { runId } = await h.queuedRun();
    expect((await h.execute(runId)).outcome).toBe('delayed');
    const [delayed] = await h.steps(runId);
    // A rate limit is not a failure: the Step is pending again, but it did run and write.
    expect(delayed).toMatchObject({ status: 'pending', attempts: 1, failures: 0 });
    // The resumed plan no longer contains it (the registry is replaced by a different plan).
    const resumed = new Harness(t);
    resumed.registry.register('migrate', { steps: () => [step('after', async () => undefined)] });
    await resumed.t.db.pool.query(
      "UPDATE app.run SET status = 'running', lease_owner = NULL WHERE id = $1",
      [runId],
    );
    expect(await resumed.execute(runId)).toEqual({ outcome: 'finished', status: 'failed' });
    expect((await resumed.stepStatuses(runId))['target.ensure-repository']).toBe('failed');
  });

  it('[LIF-042] a fatal Step that never ran and left the plan does not fail the Run', async () => {
    const h = new Harness(t);
    h.registry.register('migrate', { steps: () => [step('after')] });
    const { runId } = await h.queuedRun();
    await h.t.db.pool.query(
      "UPDATE app.run SET status = 'running', started_at = now(), lease_owner = NULL WHERE id = $1",
      [runId],
    );
    await h.db.runStep.create({
      data: { runId, stepKey: 'old.never', order: 0, severity: 'fatal' },
    });
    expect(await h.execute(runId)).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect((await h.steps(runId))[0]?.error).toEqual({ code: 'run.plan_changed' });
  });
});

describe('[LIF-045] confirming an intent', () => {
  const branch = (id: string) =>
    record(id, {
      facetKey: 'git-refs',
      resourceRef: { type: 'ref', id },
      paths: [`/refs[name=refs/heads/git-migrator/${id}]`],
    });

  it('[LIF-045] N4: only an open intent of the same Run can be confirmed, and only once', async () => {
    const h = new Harness(t);
    h.registry.register('migrate', { steps: () => [step('preflight')] });
    const { world, runId } = await h.queuedRun();
    const other = await h.queuedRun();
    const target = { migrationId: world.migrationId, routeId: world.routeId, runId };
    const write = { side: 'target', origin: 'desired' } as const;
    const ids = await h.db.$transaction((tx) =>
      writeLedger(tx, target, write, [record('a'), record('b')], new Date(), 'intended'),
    );
    const confirm = (id: string, run = target) =>
      h.db.$transaction((tx) => confirmLedger(tx, run, id, 'applied', undefined, new Date()));

    await confirm(ids[0] as string);
    await expect(confirm(ids[0] as string)).rejects.toThrow(/not an open intent/);
    await expect(
      confirm(ids[1] as string, {
        migrationId: other.world.migrationId,
        routeId: other.world.routeId,
        runId: other.runId,
      }),
    ).rejects.toThrow(/not an open intent/);
    await confirm(ids[1] as string);
  });

  it('[LIF-045] N4: not_applied revokes the Expected Differences only that intent caused', async () => {
    const h = new Harness(t);
    h.registry.register('migrate', { steps: () => [step('preflight')] });
    const { world, runId } = await h.queuedRun();
    const target = { migrationId: world.migrationId, routeId: world.routeId, runId };
    const write = { side: 'target', origin: 'framework' } as const;
    const same = branch('shared');
    const [lone, first, second] = await h.db.$transaction(async (tx) => [
      ...(await writeLedger(tx, target, write, [branch('lone')], new Date(), 'intended')),
      ...(await writeLedger(tx, target, write, [same], new Date(), 'intended')),
      ...(await writeLedger(tx, target, write, [same], new Date(), 'intended')),
    ]);
    const active = () =>
      h.db.expectedDifference.findMany({
        where: { migrationId: world.migrationId, revokedAt: null },
        orderBy: { path: 'asc' },
      });
    expect((await active()).map((d) => d.path)).toEqual([
      '/refs[name=refs/heads/git-migrator/lone]',
      '/refs[name=refs/heads/git-migrator/shared]',
    ]);
    const settle = (id: string | undefined) =>
      h.db.$transaction((tx) =>
        confirmLedger(tx, target, id as string, 'not_applied', undefined, new Date()),
      );
    await settle(lone);
    expect((await active()).map((d) => d.path)).toEqual([
      '/refs[name=refs/heads/git-migrator/shared]',
    ]);
    await settle(first); // the second intent still needs the difference
    expect(await active()).toHaveLength(1);
    await settle(second);
    expect(await active()).toHaveLength(0);
  });

  it('[LIF-045] N4: confirming with the record of what really happened derives its Expected Differences', async () => {
    const h = new Harness(t);
    h.registry.register('migrate', { steps: () => [step('preflight')] });
    const { world, runId } = await h.queuedRun();
    const target = { migrationId: world.migrationId, routeId: world.routeId, runId };
    const [id] = await h.db.$transaction((tx) =>
      writeLedger(
        tx,
        target,
        { side: 'target', origin: 'framework' },
        [branch('guess')],
        new Date(),
        'intended',
      ),
    );
    await h.db.$transaction((tx) =>
      confirmLedger(tx, target, id as string, 'applied', branch('actual'), new Date()),
    );
    const paths = (
      await h.db.expectedDifference.findMany({ where: { migrationId: world.migrationId } })
    ).map((d) => d.path);
    expect(paths).toContain('/refs[name=refs/heads/git-migrator/actual]');
  });

  it('[LIF-045] a resumed Step finds the intents it left open, through openIntents', async () => {
    const h = new Harness(t);
    const seen: string[][] = [];
    let attempt = 0;
    h.registry.register('migrate', {
      steps: () => [
        step('target.ensure-repository', async (ctx) => {
          attempt += 1;
          const open = await ctx.ledger.openIntents();
          seen.push(open.map((o) => o.id));
          if (attempt === 1) {
            await ctx.ledger.intend({ side: 'target', origin: 'framework' }, record('repo'));
            throw transient();
          }
          for (const intent of open) await ctx.ledger.confirm(intent.id, 'applied');
          return undefined;
        }),
      ],
    });
    const { runId } = await h.queuedRun();
    expect(await h.execute(runId)).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect(seen[0]).toEqual([]);
    expect(seen[1]).toHaveLength(1);
    const rows = await t.db.pool.query(
      'SELECT state, written_by_step FROM app.mutation WHERE run_id = $1',
      [runId],
    );
    expect(rows.rows).toEqual([
      { state: 'recorded', written_by_step: (await h.steps(runId))[0]?.id },
    ]);
  });
});

describe('[LIF-042] the retry wait', () => {
  it('[LIF-042] N5: a Step waiting to retry is pending with its failure counted, so a crash in the wait does not count it twice', async () => {
    const h = new Harness(t);
    const waiting = deferred();
    const forever = new Promise<void>(() => undefined);
    let calls = 0;
    h.registry.register('migrate', {
      steps: () => [
        step('git.push-refs', async () => {
          calls += 1;
          if (calls === 1) throw transient();
          return { status: 'succeeded' };
        }),
      ],
    });
    const { runId } = await h.queuedRun();
    const worker = h.execute(
      runId,
      {},
      {
        sleep: async () => {
          waiting.resolve();
          await forever; // the worker dies here
        },
      },
    );
    await waiting.promise;
    const [row] = await h.steps(runId);
    expect(row).toMatchObject({ status: 'pending', failures: 1 });

    // The reaper resumes the Run; the new worker must not count a crash for this row.
    await h.expireLease(runId);
    await reapRuns({ pool: t.db.pool, runs: h.enqueuer.runs, log: silentLog });
    expect(await h.execute(runId, { jobId: 'b' }, { workerId: 'worker-b' })).toEqual({
      outcome: 'finished',
      status: 'succeeded',
    });
    expect((await h.steps(runId))[0]).toMatchObject({ status: 'succeeded', failures: 1 });
    void worker; // the dead worker never returns
  });
});

describe('[LIF-002] a Run whose only records were not applied', () => {
  it('[LIF-002] Q2: intend, cancel, confirm not_applied: the Run recorded no Mutation, so the Migration returns to its saved status', async () => {
    const h = new Harness(t);
    const intended = deferred();
    const proceed = deferred();
    h.registry.register('migrate', {
      steps: () => [
        step('target.ensure-repository', async (ctx) => {
          const id = await ctx.ledger.intend(
            { side: 'target', origin: 'framework' },
            record('repo'),
          );
          intended.resolve();
          await proceed.promise;
          await ctx.ledger.confirm(id, 'not_applied'); // the provider call never happened
          await until(() => ctx.signal.aborted, 'the cancel to reach the Step');
          ctx.checkpoint();
          return undefined;
        }),
      ],
    });
    const { world, runId } = await h.queuedRun();
    const running = h.execute(runId);
    await intended.promise;
    expect((await h.run(runId)).hasMutations).toBe(true); // an intent counts until it is settled
    await requestRunCancel(h.db, runId);
    proceed.resolve();
    expect(await running).toEqual({ outcome: 'finished', status: 'cancelled' });
    expect((await h.run(runId)).hasMutations).toBe(false);
    expect((await h.migration(world.migrationId)).status).toBe('analyzed');
  });
});
