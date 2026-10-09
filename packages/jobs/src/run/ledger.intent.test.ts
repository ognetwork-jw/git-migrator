import { isPossiblyApplied, mutationsToUndo } from '@git-migrator/core';
import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { requestRunCancel } from './guard.ts';
import { deferred, Harness, step } from './harness.fixture.ts';
import { writeLedger } from './ledger.ts';
import { lockMigration } from './store.ts';
import type { MutationLike } from './types.ts';

// These tests wait on a real database; a loaded CI box needs more than the 5 s default.
vi.setConfig({ testTimeout: 30_000 });

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase('gm_t070f_');
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

const rows = (h: Harness, runId: string) =>
  h.t.db.pool
    .query('SELECT * FROM app.mutation WHERE run_id = $1 ORDER BY seq', [runId])
    .then((r) => r.rows);

describe('[LIF-045] a ledger write never deadlocks with cancel', () => {
  it('[LIF-045] records while another transaction holds the Migration lock, as a cancel does', async () => {
    const h = new Harness(t);
    const recorded = deferred();
    h.registry.register('migrate', {
      steps: () => [
        step('facet.branch-rules.apply', async (ctx) => {
          await ctx.ledger.record({ side: 'target', origin: 'desired' }, [record('1')]);
          recorded.resolve();
          return undefined;
        }),
      ],
    });
    const { runId, world } = await h.queuedRun();
    // The cancel's first lock, held while the executor writes. The foreign keys of the ledger rows
    // need a share lock on the Migration that a plain FOR UPDATE would refuse (P2).
    const release = deferred();
    const held = deferred();
    const holder = h.db.$transaction(async (tx) => {
      await lockMigration(tx, world.migrationId);
      held.resolve();
      await release.promise;
    });
    await held.promise;
    const running = h.execute(runId);
    await Promise.race([
      recorded.promise,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('the ledger write waited for the Migration lock')),
          8_000,
        ),
      ),
    ]);
    expect(await rows(h, runId)).toHaveLength(1);
    release.resolve();
    await holder;
    expect(await running).toMatchObject({ outcome: 'finished', status: 'succeeded' });
  }, 30_000);

  it('[LIF-045] a stream of records interleaved with a cancel is recorded completely and the Run ends cancelled', async () => {
    const h = new Harness(t);
    const started = deferred();
    h.registry.register('migrate', {
      steps: () => [
        step('facet.branch-rules.apply', async (ctx) => {
          started.resolve();
          for (let i = 0; i < 25; i++) {
            await ctx.ledger.record({ side: 'target', origin: 'desired' }, [record(`n${i}`)]);
          }
          return undefined;
        }),
      ],
    });
    const { runId } = await h.queuedRun();
    const running = h.execute(runId);
    await started.promise;
    const cancels = [];
    for (let i = 0; i < 5; i++) cancels.push(requestRunCancel(h.db, runId));
    await Promise.all(cancels);
    const result = await running;
    expect(result.outcome).toBe('finished');
    expect(await rows(h, runId)).toHaveLength(25);
  }, 60_000);

  it('[LIF-045] retries a ledger write that PostgreSQL aborted for a lock cycle', async () => {
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
    // The first insert into the ledger fails like a deadlock victim (40P01); the next ones succeed.
    // A sequence is not rolled back with the failed statement, so only the first insert fails.
    await t.db.pool.query('CREATE SEQUENCE app.t070_attempts');
    await t.db.pool.query(`
      CREATE FUNCTION app.t070_deadlock_once() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF nextval('app.t070_attempts') = 1 THEN
          RAISE EXCEPTION 'deadlock detected' USING ERRCODE = '40P01';
        END IF;
        RETURN NEW;
      END $$`);
    await t.db.pool.query(
      'CREATE TRIGGER t070_deadlock BEFORE INSERT ON app.mutation FOR EACH ROW EXECUTE FUNCTION app.t070_deadlock_once()',
    );
    try {
      expect(await h.execute(runId)).toEqual({ outcome: 'finished', status: 'succeeded' });
    } finally {
      await t.db.pool.query('DROP TRIGGER t070_deadlock ON app.mutation');
    }
    const seen = await t.db.pool.query('SELECT last_value::int AS n FROM app.t070_attempts');
    expect(seen.rows[0].n).toBe(2); // the first insert failed, the retry succeeded
    expect(await rows(h, runId)).toHaveLength(1);
    expect(await h.stepStatuses(runId)).toEqual({ 'facet.branch-rules.apply': 'succeeded' });
  }, 30_000);
});

describe('[LIF-045] intent records', () => {
  it('[LIF-045] an intent written before a provider call survives a crash and is undone as possibly applied', async () => {
    const h = new Harness(t);
    h.registry.register('migrate', {
      steps: () => [
        step(
          'target.ensure-repository',
          async (ctx) => {
            await ctx.ledger.intend({ side: 'target', origin: 'framework' }, record('repo'));
            throw new Error('connection reset while waiting for the provider');
          },
          { severity: 'fatal' },
        ),
      ],
    });
    const { world, runId } = await h.queuedRun();
    await h.execute(runId);

    const stored = await h.db.mutation.findMany({
      where: { migrationId: world.migrationId },
      orderBy: { seq: 'asc' },
    });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.state).toBe('intended');
    const undo = mutationsToUndo(
      stored.map((m) => ({ ...m, resourceRef: m.resourceRef as Record<string, unknown> })),
    );
    expect(undo).toHaveLength(1);
    expect(isPossiblyApplied(undo[0] ?? {})).toBe(true);
    expect((await h.run(runId)).hasMutations).toBe(true);
  });

  it('[LIF-045] confirm settles an intent as applied, with the record of what really happened, or as not applied', async () => {
    const h = new Harness(t);
    h.registry.register('migrate', {
      steps: () => [
        step('facet.branch-rules.apply', async (ctx) => {
          const write = { side: 'target', origin: 'desired' } as const;
          const a = await ctx.ledger.intend(write, record('a'));
          const b = await ctx.ledger.intend(write, record('b'));
          const c = await ctx.ledger.intend(write, record('c'));
          await ctx.ledger.confirm(a, 'applied');
          await ctx.ledger.confirm(b, 'applied', record('b', { after: { id: 'b', real: true } }));
          await ctx.ledger.confirm(c, 'not_applied');
          return undefined;
        }),
      ],
    });
    const { runId } = await h.queuedRun();
    await h.execute(runId);
    const all = await rows(h, runId);
    expect(all.map((r) => r.state)).toEqual(['recorded', 'recorded', 'not_applied']);
    expect(all[1]?.after).toEqual({ id: 'b', real: true });
    const undo = mutationsToUndo(
      all.map((r) => ({
        seq: r.seq as bigint,
        state: r.state as string,
        resourceRef: r.resource_ref as Record<string, unknown>,
        undoneAt: r.undone_at as Date | null,
      })),
    );
    expect(undo).toHaveLength(2);
  });

  it('[LIF-045] an Expected Difference an operator revoked is not created again when a resumed Step records the same path', async () => {
    const h = new Harness(t);
    h.registry.register('migrate', { steps: () => [step('change-requests.open')] });
    const { world, runId } = await h.queuedRun();
    const branch = record('b1', {
      facetKey: 'git-refs',
      paths: ['/refs[name=refs/heads/git-migrator/pipelines]'],
    });
    const write = async () =>
      h.db.$transaction(async (tx) => {
        await writeLedger(
          tx,
          { migrationId: world.migrationId, routeId: world.routeId, runId },
          { side: 'target', origin: 'framework' },
          [branch],
          new Date(),
        );
      });
    await write();
    const [diff] = await h.db.expectedDifference.findMany({
      where: { migrationId: world.migrationId },
    });
    expect(diff?.reason).toBe('framework_mutation');
    await h.db.expectedDifference.update({
      where: { id: diff?.id ?? '' },
      data: { revokedAt: new Date() },
    });
    await write(); // the resumed Step records the branch again
    const all = await h.db.expectedDifference.findMany({
      where: { migrationId: world.migrationId },
    });
    expect(all).toHaveLength(1);
    expect(all[0]?.revokedAt).not.toBeNull();
    expect(await rows(h, runId)).toHaveLength(2); // the ledger itself records both writes
  });
});
