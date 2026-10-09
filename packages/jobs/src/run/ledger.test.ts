import { mutationsToUndo } from '@git-migrator/core';
import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { addRunTask } from './findings.ts';
import { Harness, step, transient } from './harness.fixture.ts';
import type { MutationLike } from './types.ts';

// These tests wait on a real database; a loaded CI box needs more than the 5 s default.
vi.setConfig({ testTimeout: 30_000 });

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase('gm_t070c_');
}, 120_000);
afterAll(async () => {
  await t?.drop();
}, 60_000);

const record = (over: Partial<MutationLike> = {}): MutationLike => ({
  facetKey: 'branch-rules',
  action: 'create',
  resourceRef: { type: 'rule', id: '1' },
  paths: ['/rules[id=1]'],
  before: null,
  after: { id: '1' },
  ...over,
});

const ledgerRows = (h: Harness, runId: string) =>
  h.t.db.pool
    .query('SELECT * FROM app.mutation WHERE run_id = $1 ORDER BY seq', [runId])
    .then((r) => r.rows);

describe('[LIF-045] Mutation ledger', () => {
  it('[LIF-045] persists every record of apply with its side, facet, resource, paths and images, in recording order', async () => {
    const h = new Harness(t);
    h.registry.register('migrate', {
      steps: () => [
        step('facet.branch-rules.apply', async (ctx) => {
          await ctx.ledger.record({ side: 'target', origin: 'desired' }, [
            record(),
            record({
              action: 'update',
              resourceRef: { type: 'rule', id: '2' },
              paths: ['/rules[id=2]'],
              before: { v: 1 },
              after: { v: 2 },
            }),
          ]);
          await ctx.ledger.record({ side: 'source', origin: 'framework' }, [
            record({ facetKey: null, resourceRef: { type: 'restriction' }, paths: [] }),
          ]);
          return undefined;
        }),
      ],
    });
    const { runId } = await h.queuedRun();
    await h.execute(runId);

    const rows = await ledgerRows(h, runId);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => [r.side, r.facet_key, r.action])).toEqual([
      ['target', 'branch-rules', 'create'],
      ['target', 'branch-rules', 'update'],
      ['source', 'framework', 'create'],
    ]);
    expect(rows[1]).toMatchObject({
      resource_ref: { type: 'rule', id: '2' },
      paths: ['/rules[id=2]'],
      before: { v: 1 },
      after: { v: 2 },
      undone_at: null,
    });
    expect(rows[0]?.before).toBeNull();
    expect((await h.run(runId)).hasMutations).toBe(true);
  });

  it('[LIF-045] stores adopted and no-op records with before equal to after, so undo never reverts them', async () => {
    const h = new Harness(t);
    h.registry.register('migrate', {
      steps: () => [
        step('target.ensure-repository', async (ctx) => {
          await ctx.ledger.record({ side: 'target', origin: 'framework' }, [
            record({
              facetKey: null,
              resourceRef: { type: 'repo', adopted: true },
              before: { empty: true },
              after: { empty: false },
            }),
            record({
              resourceRef: { type: 'rule', id: '9', noop: true },
              before: { v: 1 },
              after: { v: 1 },
            }),
            record({ resourceRef: { type: 'rule', id: '10' } }),
          ]);
          return undefined;
        }),
      ],
    });
    const { world, runId } = await h.queuedRun();
    await h.execute(runId);
    const rows = await ledgerRows(h, runId);
    expect(rows[0]?.after).toEqual(rows[0]?.before);
    expect(rows[1]?.after).toEqual(rows[1]?.before);
    const stored = await h.db.mutation.findMany({
      where: { migrationId: world.migrationId },
      orderBy: { seq: 'asc' },
    });
    const undo = mutationsToUndo(
      stored.map((m) => ({ ...m, resourceRef: m.resourceRef as Record<string, unknown> })),
    );
    expect(undo.map((m) => (m.resourceRef as { id?: string }).id)).toEqual(['10']);
  });

  it('[LIF-045] derives framework_mutation Expected Differences for target writes outside the desired document, once', async () => {
    const h = new Harness(t);
    const branch = record({
      facetKey: 'git-refs',
      resourceRef: { type: 'ref', name: 'refs/heads/git-migrator/pipelines' },
      paths: ['/refs[name=refs/heads/git-migrator/pipelines]'],
    });
    h.registry.register('migrate', {
      steps: () => [
        step('change-requests.open', async (ctx) => {
          await ctx.ledger.record({ side: 'target', origin: 'framework' }, [branch]);
          await ctx.ledger.record({ side: 'target', origin: 'framework' }, [branch]); // a resumed Step
          await ctx.ledger.record({ side: 'target', origin: 'desired' }, [record()]); // not extra
          await ctx.ledger.record({ side: 'source', origin: 'framework' }, [
            record({ facetKey: 'access-control', paths: ['/grants[principal=*]'] }),
          ]);
          return undefined;
        }),
      ],
    });
    const { world, runId } = await h.queuedRun();
    await h.execute(runId);
    const diffs = await h.db.expectedDifference.findMany({
      where: { migrationId: world.migrationId },
    });
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({
      reason: 'framework_mutation',
      facetKey: 'git-refs',
      path: '/refs[name=refs/heads/git-migrator/pipelines]',
      routeId: world.routeId,
      revokedAt: null,
    });
  });

  it('[LIF-045] a repository-level record takes its Expected Difference paths from the caller', async () => {
    const h = new Harness(t);
    h.registry.register('migrate', {
      steps: () => [
        step('change-requests.open', async (ctx) => {
          await ctx.ledger.record(
            {
              side: 'target',
              origin: 'framework',
              differences: [
                { facetKey: 'git-refs', path: '/refs[name=refs/heads/git-migrator/*]' },
              ],
            },
            [record({ facetKey: null, paths: [] })],
          );
          return undefined;
        }),
      ],
    });
    const { world, runId } = await h.queuedRun();
    await h.execute(runId);
    const diffs = await h.db.expectedDifference.findMany({
      where: { migrationId: world.migrationId },
    });
    expect(diffs.map((d) => d.path)).toEqual(['/refs[name=refs/heads/git-migrator/*]']);
  });

  it('[ADP-012] keeps the records of the changes made before an apply failed, and a retry adds only what is new', async () => {
    const h = new Harness(t);
    let attempt = 0;
    async function* apply(): AsyncGenerator<MutationLike> {
      attempt += 1;
      yield record({ resourceRef: { type: 'rule', id: `a${attempt}` } });
      yield record({ resourceRef: { type: 'rule', id: `b${attempt}` } });
      if (attempt === 1) throw transient('lost connection after two changes');
    }
    h.registry.register('migrate', {
      steps: () => [
        step('facet.branch-rules.apply', async (ctx) => {
          await ctx.ledger.recordAll({ side: 'target', origin: 'desired' }, apply());
          return undefined;
        }),
      ],
    });
    const { runId } = await h.queuedRun();
    await h.execute(runId);
    const rows = await ledgerRows(h, runId);
    expect(rows.map((r) => r.resource_ref.id)).toEqual(['a1', 'b1', 'a2', 'b2']);
    expect((await h.stepStatuses(runId))['facet.branch-rules.apply']).toBe('succeeded');
  });

  it('[ADP-012] writes nothing for an empty batch and does not mark the Run', async () => {
    const h = new Harness(t);
    h.registry.register('migrate', {
      steps: () => [
        step('facet.merge-settings.apply', async (ctx) => {
          await ctx.ledger.record({ side: 'target', origin: 'desired' }, []);
          return undefined;
        }),
      ],
    });
    const { runId } = await h.queuedRun();
    await h.execute(runId);
    expect(await ledgerRows(h, runId)).toEqual([]);
    expect((await h.run(runId)).hasMutations).toBe(false);
  });

  it('[LIF-045] a worker that lost the lease still records the change it already made on the provider', async () => {
    const h = new Harness(t);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const entered = new Promise<void>((resolve) => {
      h.registry.register('migrate', {
        steps: () => [
          step('facet.branch-rules.apply', async (ctx) => {
            resolve();
            await gate;
            await ctx.ledger.record({ side: 'target', origin: 'desired' }, [record()]);
            return undefined;
          }),
        ],
      });
    });
    const { runId } = await h.queuedRun();
    const running = h.execute(runId);
    await entered;
    await t.db.pool.query("UPDATE app.run SET lease_owner = 'another-worker' WHERE id = $1", [
      runId,
    ]);
    release();
    // The worker stops (its Step state writes are fenced), but the ledger kept the record.
    expect(await running).toEqual({ outcome: 'lost' });
    expect(await ledgerRows(h, runId)).toHaveLength(1);
    expect((await h.run(runId)).hasMutations).toBe(true);
  });
});

describe('[LIF-049] run-origin findings', () => {
  it('[LIF-049] stores a run-origin blocker in Migration.runBlockers, which blocks readiness, and clears it again', async () => {
    const h = new Harness(t);
    h.registry.register('migrate', {
      steps: () => [
        step(
          'git.prepare',
          async (ctx) => {
            await ctx.findings.addBlocker({
              code: 'git-refs.blob-too-large',
              params: { oid: 'abc', bytes: 2_097_152 },
            });
            await ctx.findings.addBlocker({
              code: 'git-refs.blob-too-large',
              params: { oid: 'abc', bytes: 2_097_152 },
            });
            return undefined;
          },
          { severity: 'fatal' },
        ),
      ],
    });
    const { world, runId } = await h.queuedRun();
    await h.execute(runId);
    const blocked = await h.migration(world.migrationId);
    expect(blocked.runBlockers).toEqual([
      {
        code: 'git-refs.blob-too-large',
        params: { oid: 'abc', bytes: 2_097_152 },
        at: expect.any(String),
      },
    ]);
    expect(blocked.readiness).toBe('blocked');
    expect(blocked.blockerCodes).toEqual(['git-refs.blob-too-large']);
    expect(blocked.readinessCounts).toMatchObject({ blockers: 1 });

    // A later Run's step passes: the blocker is cleared and readiness recomputed (LIF-049).
    const h2 = new Harness(t);
    await t.db.privileged.migration.update({
      where: { id: world.migrationId },
      data: { status: 'analyzed' },
    });
    h2.registry.register('resync', {
      steps: () => [
        step('git.prepare', async (ctx) => {
          await ctx.findings.clearBlockers(['git-refs.blob-too-large']);
          return undefined;
        }),
      ],
    });
    await t.db.privileged.migration.update({
      where: { id: world.migrationId },
      data: { readiness: 'needs_attention' },
    });
    const { createRun } = await import('./guard.ts');
    const second = await createRun(t.db.privileged, {
      migrationId: world.migrationId,
      kind: 'resync',
      triggeredById: world.actorId,
    });
    await h2.execute(second.runId);
    const cleared = await h2.migration(world.migrationId);
    expect(cleared.runBlockers).toEqual([]);
    expect(cleared.blockerCodes).toEqual([]);
    expect(cleared.readiness).not.toBe('blocked');
  });

  it('[LIF-049] stores a run-origin ManualTask once, makes a pre task NeedsAttention, and never reopens a completed one', async () => {
    const h = new Harness(t);
    h.registry.register('migrate', {
      steps: () => [
        step('facet.deploy-keys.apply', async (ctx) => {
          const finding = {
            code: 'deploy-keys.key-in-use',
            facetKey: 'deploy-keys',
            phase: 'pre' as const,
            params: { title: 'ci' },
          };
          await ctx.findings.addTask(finding);
          await ctx.findings.addTask(finding);
          return undefined;
        }),
      ],
    });
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
    await h.execute(runId);
    const tasks = await h.db.manualTask.findMany({ where: { migrationId: world.migrationId } });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      origin: 'run',
      phase: 'pre',
      status: 'open',
      code: 'deploy-keys.key-in-use',
    });
    expect((await h.migration(world.migrationId)).readiness).toBe('needs_attention');

    // An operator completed it: a later Run that finds the same thing does not reopen it.
    await h.db.manualTask.update({ where: { id: tasks[0]?.id ?? '' }, data: { status: 'done' } });
    const created = await h.db.$transaction((tx) =>
      addRunTask(tx, world.migrationId, {
        code: 'deploy-keys.key-in-use',
        facetKey: 'deploy-keys',
        phase: 'pre',
        params: { title: 'ci' },
      }),
    );
    expect(created).toBe(false);
    expect(
      (await h.db.manualTask.findUniqueOrThrow({ where: { id: tasks[0]?.id ?? '' } })).status,
    ).toBe('done');
  });
});
