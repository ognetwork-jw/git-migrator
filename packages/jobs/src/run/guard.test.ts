import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LOCK_INTENT_KIND } from '../analysis/framework-resources.ts';
import { reapRuns } from '../reaper.ts';
import { loadWorld as loadRollbackWorld } from '../rollback/steps.ts';
import { seedBasics } from '../world.fixture.ts';
import { finishRun, settleOrphanedMigrations } from './finish.ts';
import {
  allowedReadiness,
  createRun,
  effectiveReadiness,
  legacyConfirmationName,
  RunGuardError,
  requestRunCancel,
  teamsInUse,
} from './guard.ts';
import { FIXED_NOW, Harness, silentLog, step } from './harness.fixture.ts';
import { checkRunOptions } from './options.ts';
import { requeueOrphanedQueuedRuns } from './orphans.ts';
import {
  checkPlacement,
  loadPlacement,
  placementOutside,
  TARGET_PLACEMENT_UNKNOWN,
  targetOutsideRoute,
} from './placement.ts';

// These tests wait on a real database; a loaded CI box needs more than the 5 s default.
vi.setConfig({ testTimeout: 30_000 });

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase('gm_t070b_');
}, 120_000);
afterAll(async () => {
  await t?.drop();
}, 60_000);

const db = () => t.db.privileged;

async function readyMigration(
  readiness: 'ready' | 'needs_attention' | 'blocked' | null = 'ready',
  status: 'analyzed' | 'discovered' | 'source_missing' | 'verified' = 'analyzed',
) {
  const world = await seedBasics(db());
  await db().migration.update({ where: { id: world.migrationId }, data: { status, readiness } });
  return world;
}

/** A ledger record of an earlier Run of the Migration. */
async function mutation(
  world: { migrationId: string; actorId: string },
  resourceRef: Record<string, unknown>,
  fields: { side?: string; state?: string } = {},
) {
  const run = await db().run.create({
    data: {
      migrationId: world.migrationId,
      kind: 'migrate',
      triggeredById: world.actorId,
      options: {},
      status: 'failed',
    },
  });
  return db().mutation.create({
    data: {
      migrationId: world.migrationId,
      runId: run.id,
      side: fields.side ?? 'target',
      facetKey: 'framework',
      resourceRef: resourceRef as never,
      paths: [],
      action: 'create',
      state: fields.state ?? 'recorded',
    },
  });
}

describe('[DOM-010] one active Run per Migration', () => {
  it('[DOM-010] admits a Run, moves the Migration to running and remembers the status before', async () => {
    const world = await readyMigration();
    const created = await createRun(db(), {
      migrationId: world.migrationId,
      kind: 'migrate',
      triggeredById: world.actorId,
      options: { adoptNonEmpty: false },
      now: () => FIXED_NOW,
    });
    expect(created.routing).toEqual({
      kind: 'migrate',
      scope: 'repository',
      sizeClass: 'standard',
    });
    const run = await db().run.findUniqueOrThrow({ where: { id: created.runId } });
    expect(run).toMatchObject({ status: 'queued', options: { adoptNonEmpty: false } });
    const migration = await db().migration.findUniqueOrThrow({ where: { id: world.migrationId } });
    expect(migration).toMatchObject({ status: 'running', statusBeforeRun: 'analyzed' });
  });

  it('[DOM-010] refuses a second Run while one is queued or running', async () => {
    const world = await readyMigration();
    const input = {
      migrationId: world.migrationId,
      kind: 'resync' as const,
      triggeredById: world.actorId,
    };
    await createRun(db(), input);
    await expect(createRun(db(), input)).rejects.toMatchObject({
      name: 'RunGuardError',
      code: 'run.active',
      httpStatus: 409,
    });
  });

  it('[DOM-010] lets exactly one of many concurrent requests through', async () => {
    const world = await readyMigration();
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        createRun(db(), {
          migrationId: world.migrationId,
          kind: 'migrate',
          triggeredById: world.actorId,
        }),
      ),
    );
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    for (const a of attempts) {
      if (a.status === 'rejected') expect(a.reason).toBeInstanceOf(RunGuardError);
    }
    expect(await db().run.count({ where: { migrationId: world.migrationId } })).toBe(1);
  });

  it('[DOM-010] the partial unique index refuses a writer that bypasses the guard', async () => {
    const world = await readyMigration();
    await createRun(db(), {
      migrationId: world.migrationId,
      kind: 'migrate',
      triggeredById: world.actorId,
    });
    await expect(
      db().run.create({
        data: {
          migrationId: world.migrationId,
          kind: 'verify',
          triggeredById: world.actorId,
          options: {},
          status: 'queued',
        },
      }),
    ).rejects.toThrow();
  });

  it('[DOM-010] admits a new Run once the previous one finished, from the status the first left', async () => {
    const world = await readyMigration();
    const h = new Harness(t);
    h.registry.register('migrate', { steps: () => [step('preflight')] });
    const first = await createRun(db(), {
      migrationId: world.migrationId,
      kind: 'migrate',
      triggeredById: world.actorId,
    });
    await h.execute(first.runId);
    expect(
      (await db().migration.findUniqueOrThrow({ where: { id: world.migrationId } })).status,
    ).toBe('migrated');
    const second = await createRun(db(), {
      migrationId: world.migrationId,
      kind: 'resync',
      triggeredById: world.actorId,
    });
    expect(second.runId).not.toBe(first.runId);
    expect(
      (await db().migration.findUniqueOrThrow({ where: { id: world.migrationId } }))
        .statusBeforeRun,
    ).toBe('migrated');
  });

  it('[DOM-010] concurrent create, finish and cancel on one Migration never deadlock (lock order Migration, then Run)', async () => {
    const h = new Harness(t);
    h.registry.register('migrate', { steps: () => [step('preflight')] });
    for (let round = 0; round < 6; round++) {
      const world = await readyMigration();
      const first = await createRun(db(), {
        migrationId: world.migrationId,
        kind: 'migrate',
        triggeredById: world.actorId,
      });
      const outcomes = await Promise.allSettled([
        h.execute(first.runId),
        requestRunCancel(db(), first.runId),
        createRun(db(), {
          migrationId: world.migrationId,
          kind: 'migrate',
          triggeredById: world.actorId,
        }),
        createRun(db(), {
          migrationId: world.migrationId,
          kind: 'verify',
          triggeredById: world.actorId,
        }),
      ]);
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') {
          expect(outcome.reason).toBeInstanceOf(RunGuardError);
        }
      }
      expect(
        await db().run.count({
          where: { migrationId: world.migrationId, status: { in: ['queued', 'running'] } },
        }),
      ).toBeLessThanOrEqual(1);
      // The Migration is `running` exactly while one of its Runs is active.
      const active = await db().run.count({
        where: { migrationId: world.migrationId, status: { in: ['queued', 'running'] } },
      });
      const current = await db().migration.findUniqueOrThrow({ where: { id: world.migrationId } });
      expect(current.status === 'running').toBe(active === 1);
    }
  }, 60_000);

  it('[DOM-010] states the active-Run rule for endpoint Migrations the same way: one per Migration, one Migration per Route', async () => {
    const world = await seedBasics(db());
    const endpointMigration = await db().migration.create({
      data: { scope: 'endpoint', routeId: world.routeId, status: 'analyzed', readiness: 'ready' },
    });
    const input = {
      migrationId: endpointMigration.id,
      kind: 'migrate' as const,
      triggeredById: world.actorId,
    };
    const first = await createRun(db(), input);
    expect(first.routing.scope).toBe('endpoint');
    await expect(createRun(db(), input)).rejects.toMatchObject({ code: 'run.active' });
    // A repository Migration of the same Route is independent (LIF-080).
    await db().migration.update({
      where: { id: world.migrationId },
      data: { status: 'analyzed', readiness: 'ready' },
    });
    await expect(
      createRun(db(), {
        migrationId: world.migrationId,
        kind: 'migrate',
        triggeredById: world.actorId,
      }),
    ).resolves.toBeDefined();
    await expect(
      db().migration.create({ data: { scope: 'endpoint', routeId: world.routeId } }),
    ).rejects.toThrow();
  });
});

describe('[LIF-005] readiness required per Run kind', () => {
  const table: [
    string,
    'ready' | 'needs_attention' | 'blocked' | null,
    'migrate' | 'run_anyway' | 'resync' | 'verify' | 'rollback',
    boolean,
  ][] = [
    ['ready migrates', 'ready', 'migrate', true],
    ['needs_attention does not migrate', 'needs_attention', 'migrate', false],
    ['blocked does not migrate', 'blocked', 'migrate', false],
    ['an unset readiness does not migrate', null, 'migrate', false],
    ['needs_attention runs anyway', 'needs_attention', 'run_anyway', true],
    ['blocked does not run anyway', 'blocked', 'run_anyway', false],
    ['blocked does not resync', 'blocked', 'resync', false],
    ['an unset readiness resyncs', null, 'resync', true],
    ['blocked still verifies', 'blocked', 'verify', true],
    ['blocked still rolls back', 'blocked', 'rollback', true],
  ];
  it.each(table)('[LIF-005] %s', async (_name, readiness, kind, allowed) => {
    const world = await readyMigration(readiness);
    // A rollback needs something to undo (LIF-077): an unconfirmed create may have made the target.
    if (kind === 'rollback')
      await mutation(world, { kind: 'repository', name: 'x' }, { state: 'intended' });
    const attempt = createRun(db(), {
      migrationId: world.migrationId,
      kind,
      triggeredById: world.actorId,
    });
    if (allowed) await expect(attempt).resolves.toBeDefined();
    else
      await expect(attempt).rejects.toMatchObject({
        code: 'run.readiness_required',
        httpStatus: 422,
      });
  });

  it('[LIF-005] leaves the Migration untouched when the gate refuses', async () => {
    const world = await readyMigration('blocked');
    await expect(
      createRun(db(), {
        migrationId: world.migrationId,
        kind: 'migrate',
        triggeredById: world.actorId,
      }),
    ).rejects.toBeInstanceOf(RunGuardError);
    expect(
      (await db().migration.findUniqueOrThrow({ where: { id: world.migrationId } })).status,
    ).toBe('analyzed');
    expect(await db().run.count({ where: { migrationId: world.migrationId } })).toBe(0);
    expect(allowedReadiness('verify')).toBeUndefined();
  });

  it('[LIF-002] refuses a Run the lifecycle table does not allow, such as on a missing source', async () => {
    const world = await readyMigration('ready', 'source_missing');
    await expect(
      createRun(db(), {
        migrationId: world.migrationId,
        kind: 'verify',
        triggeredById: world.actorId,
      }),
    ).rejects.toMatchObject({ code: 'run.not_permitted' });
  });

  it('[DOM-010] answers 404 for an unknown Migration and 409 for a retired Route', async () => {
    const world = await readyMigration();
    await expect(
      createRun(db(), {
        migrationId: '00000000-0000-0000-0000-000000000000',
        kind: 'verify',
        triggeredById: world.actorId,
      }),
    ).rejects.toMatchObject({ code: 'run.migration_missing', httpStatus: 404 });
    await db().route.update({ where: { id: world.routeId }, data: { retiredAt: new Date() } });
    await expect(
      createRun(db(), {
        migrationId: world.migrationId,
        kind: 'verify',
        triggeredById: world.actorId,
      }),
    ).rejects.toMatchObject({ code: 'run.route_retired' });
  });
});

describe('[LIF-077] when a rollback is available', () => {
  /** A Migration with a target repository row, as a migrated one has. */
  async function withTarget(status: 'migrated' | 'verified' | 'analyzed' = 'migrated') {
    const world = await readyMigration();
    const target = await db().repository.create({
      data: {
        endpointId: world.targetEndpointId,
        namespaceId: (
          await db().namespace.create({
            data: {
              endpointId: world.targetEndpointId,
              providerId: 'org',
              kind: 'organization',
              slug: 'acme',
              name: 'acme',
            },
          })
        ).id,
        providerId: 'target-1',
        slug: 'r',
        name: 'r',
        fullPath: 'acme/r',
        isPrivate: true,
        lastInventoriedAt: new Date(),
      },
    });
    await db().migration.update({
      where: { id: world.migrationId },
      data: { targetRepositoryId: target.id, status },
    });
    return world;
  }

  const rollback = (migrationId: string, actorId: string, confirm = 'acme/r') =>
    createRun(db(), { migrationId, kind: 'rollback', triggeredById: actorId, confirm });

  it('[LIF-077] admits a rollback of a migrated, verified or partial Migration that has a target', async () => {
    for (const status of ['migrated', 'verified'] as const) {
      const world = await withTarget(status);
      const created = await rollback(world.migrationId, world.actorId);
      expect(created.routing.kind).toBe('rollback');
      expect(
        (await db().migration.findUniqueOrThrow({ where: { id: world.migrationId } })).status,
      ).toBe('running');
    }
  });

  it('[LIF-077] refuses a Migration that is discovered or already rolled back', async () => {
    for (const status of ['discovered', 'rolled_back'] as const) {
      const world = await withTarget();
      await db().migration.update({ where: { id: world.migrationId }, data: { status } });
      await expect(rollback(world.migrationId, world.actorId)).rejects.toMatchObject({
        code: 'run.not_permitted',
        httpStatus: 409,
      });
    }
  });

  it('[LIF-077] refuses a rollback while the source is read-only: undo_source_read_only comes first', async () => {
    const world = await withTarget();
    await db().migration.update({
      where: { id: world.migrationId },
      data: { sourceReadOnlyApplied: true },
    });
    await expect(rollback(world.migrationId, world.actorId)).rejects.toMatchObject({
      code: 'run.not_permitted',
      message: expect.stringContaining('undo_source_read_only'),
    });
    await db().migration.update({
      where: { id: world.migrationId },
      data: { sourceReadOnlyApplied: false },
    });
    await expect(rollback(world.migrationId, world.actorId)).resolves.toBeDefined();
  });

  it('[LIF-077] refuses a rollback while a write of the source lock is unsettled (T-073 follow-up): the source may be locked and the ledger does not say how', async () => {
    const world = await withTarget();
    await mutation(
      world,
      { kind: LOCK_INTENT_KIND, noop: true },
      { side: 'source', state: 'intended' },
    );
    await expect(rollback(world.migrationId, world.actorId)).rejects.toMatchObject({
      code: 'run.not_permitted',
      message: expect.stringContaining('unsettled'),
    });
    expect(
      (await db().migration.findUniqueOrThrow({ where: { id: world.migrationId } })).status,
    ).toBe('migrated');
  });

  it('[LIF-077] an endpoint rollback is refused while a live repository Migration of the Route holds a grant for a team it would delete', async () => {
    const world = await withTarget('verified');
    const endpoint = await db().migration.create({
      data: { scope: 'endpoint', routeId: world.routeId, status: 'migrated', readiness: 'ready' },
    });
    const write = async (migrationId: string, facetKey: string, ref: Record<string, unknown>) => {
      const run = await db().run.create({
        data: {
          migrationId,
          kind: 'migrate',
          triggeredById: world.actorId,
          options: {},
          status: 'succeeded',
        },
      });
      return db().mutation.create({
        data: {
          migrationId,
          runId: run.id,
          side: 'target',
          facetKey,
          resourceRef: ref as never,
          paths: [],
          action: 'create',
          state: 'recorded',
        },
      });
    };
    await write(endpoint.id, 'teams', { kind: 'team', slug: 'platform', id: '55' });
    // A grant for another team does not hold this one.
    const other = await write(world.migrationId, 'access-control', {
      kind: 'access-grant',
      principal: 'group:99',
    });
    await expect(rollback(endpoint.id, world.actorId, '')).resolves.toBeDefined();
    // Put the endpoint Migration back: the Run above started.
    await db().run.updateMany({
      where: { migrationId: endpoint.id, kind: 'rollback' },
      data: { status: 'cancelled' },
    });
    await db().migration.update({ where: { id: endpoint.id }, data: { status: 'migrated' } });
    const grant = await write(world.migrationId, 'access-control', {
      kind: 'access-grant',
      principal: 'group:55',
    });
    await expect(rollback(endpoint.id, world.actorId, '')).rejects.toMatchObject({
      code: 'run.not_permitted',
      message: expect.stringContaining('access grants'),
    });
    // Once the repository Migration is rolled back, or its grant is reverted, the team is free.
    await db().mutation.update({ where: { id: grant.id }, data: { undoneAt: new Date() } });
    await expect(rollback(endpoint.id, world.actorId, '')).resolves.toBeDefined();
    void other;
  });

  it('[LIF-077] teamsInUse can be asked about one team, which the rollback step does before each team delete', async () => {
    const world = await withTarget('verified');
    const endpoint = await db().migration.create({
      data: { scope: 'endpoint', routeId: world.routeId, status: 'migrated', readiness: 'ready' },
    });
    const write = async (migrationId: string, facetKey: string, ref: Record<string, unknown>) => {
      const run = await db().run.create({
        data: {
          migrationId,
          kind: 'migrate',
          triggeredById: world.actorId,
          options: {},
          status: 'succeeded',
        },
      });
      return db().mutation.create({
        data: {
          migrationId,
          runId: run.id,
          side: 'target',
          facetKey,
          resourceRef: ref as never,
          paths: [],
          action: 'create',
          state: 'recorded',
        },
      });
    };
    await write(endpoint.id, 'teams', { kind: 'team', slug: 'a', id: '71' });
    await write(endpoint.id, 'teams', { kind: 'team', slug: 'b', id: '72' });
    await write(world.migrationId, 'access-control', {
      kind: 'access-grant',
      principal: 'group:72',
    });
    const scope = { id: endpoint.id, routeId: world.routeId };
    expect(await teamsInUse(db(), scope, '71')).toBe(false);
    expect(await teamsInUse(db(), scope, '72')).toBe(true);
    expect(await teamsInUse(db(), scope)).toBe(true);
  });

  it('[LIF-077] needs a target or a Mutation to undo: adopted and no-op records are not Mutations to undo', async () => {
    const world = await readyMigration();
    await db().migration.update({ where: { id: world.migrationId }, data: { status: 'partial' } });
    await expect(rollback(world.migrationId, world.actorId)).rejects.toMatchObject({
      code: 'run.not_permitted',
    });
    await mutation(world, { kind: 'repository', adopted: true });
    await mutation(world, { kind: 'git-push', noop: true });
    await mutation(world, { kind: 'repository', name: 'x' }, { state: 'not_applied' });
    await expect(rollback(world.migrationId, world.actorId)).rejects.toMatchObject({
      code: 'run.not_permitted',
    });
    // An unconfirmed create may have created the repository: that is a Mutation to undo.
    await mutation(world, { kind: 'repository', name: 'x' }, { state: 'intended' });
    await expect(rollback(world.migrationId, world.actorId)).resolves.toBeDefined();
  });
});

describe('[LIF-046] Runs that fall between transactions', () => {
  it('[LIF-046] settles a Migration left running behind a Run the reaper abandoned', async () => {
    const h = new Harness(t);
    const { world, runId } = await h.queuedRun();
    await t.db.pool.query(
      `UPDATE app.run SET status = 'running', started_at = now(), lease_owner = 'dead',
         lease_expires_at = now() - interval '1 minute', reaper_resumes = 3 WHERE id = $1`,
      [runId],
    );
    await db().runStep.create({
      data: { runId, stepKey: 'git.push-refs', order: 0, status: 'running' },
    });
    const reaped = await reapRuns({ pool: t.db.pool, runs: h.enqueuer.runs, log: silentLog });
    expect(reaped.abandoned).toEqual([runId]);
    // The reaper leaves the Migration alone (LIF-046)...
    expect((await h.migration(world.migrationId)).status).toBe('running');
    // ...and the lifecycle transition is applied afterwards.
    expect(await settleOrphanedMigrations(db(), () => FIXED_NOW, silentLog)).toContain(
      world.migrationId,
    );
    expect((await h.migration(world.migrationId)).status).toBe('failed');
    expect(await h.stepStatuses(runId)).toEqual({ 'git.push-refs': 'skipped' });
    expect(await settleOrphanedMigrations(db(), () => FIXED_NOW, silentLog)).not.toContain(
      world.migrationId,
    );
  });

  it('[LIF-046] does not settle a Migration whose Run is still active', async () => {
    const h = new Harness(t);
    const { world } = await h.queuedRun();
    expect(await settleOrphanedMigrations(db(), () => FIXED_NOW, silentLog)).not.toContain(
      world.migrationId,
    );
    expect((await h.migration(world.migrationId)).status).toBe('running');
  });

  it('[DOM-010] re-enqueues a queued Run whose job never reached the queue, once it is past the grace period', async () => {
    const h = new Harness(t);
    const { runId } = await h.queuedRun();
    expect(await requeueOrphanedQueuedRuns(t.db.pool, h.enqueuer.runs, silentLog)).not.toContain(
      runId,
    );
    await t.db.pool.query(
      "UPDATE app.run SET created_at = now() - interval '10 minutes' WHERE id = $1",
      [runId],
    );
    expect(await requeueOrphanedQueuedRuns(t.db.pool, h.enqueuer.runs, silentLog)).toContain(runId);
    expect(h.enqueuer.calls.at(-1)).toMatchObject({ runId, dedupeId: `run-${runId}` });
    // Its job now exists: it is not queued twice.
    expect(await requeueOrphanedQueuedRuns(t.db.pool, h.enqueuer.runs, silentLog)).not.toContain(
      runId,
    );
  });

  it('[LIF-002] a lost lease cannot finish a Run: finishing is fenced on the token', async () => {
    const h = new Harness(t);
    const { world, runId } = await h.queuedRun();
    await t.db.pool.query(
      "UPDATE app.run SET status = 'running', lease_owner = 'someone-else' WHERE id = $1",
      [runId],
    );
    await expect(
      finishRun(db(), {
        runId,
        token: 'stale-token',
        migrationId: world.migrationId,
        status: 'succeeded',
        now: () => FIXED_NOW,
        log: silentLog,
      }),
    ).rejects.toThrow(/lease lost/i);
    expect((await h.run(runId)).status).toBe('running');
    expect((await h.migration(world.migrationId)).status).toBe('running');
  });
});

describe('[LIF-043] Run options', () => {
  it('[LIF-043] force-adopting a non-empty target needs the exact target full name as confirm, not inside options', async () => {
    const world = await readyMigration();
    await db().migration.update({
      where: { id: world.migrationId },
      data: { plannedTargetName: 'plat-r' },
    });
    const base = {
      migrationId: world.migrationId,
      kind: 'migrate' as const,
      triggeredById: world.actorId,
      options: { adoptNonEmpty: true },
    };
    await expect(createRun(db(), base)).rejects.toMatchObject({
      code: 'run.confirmation_required',
      httpStatus: 422,
    });
    await expect(createRun(db(), { ...base, confirm: 'acme/PLAT-R' })).rejects.toMatchObject({
      code: 'run.confirmation_required',
    });
    expect(await db().run.count({ where: { migrationId: world.migrationId } })).toBe(0);
    const created = await createRun(db(), { ...base, confirm: 'acme/plat-r' });
    const run = await db().run.findUniqueOrThrow({ where: { id: created.runId } });
    expect(run.options).toEqual({ adoptNonEmpty: true });
  });

  it('[LIF-031] a confirmed force-adopt is judged by the blockers it does not override, so only target.exists-nonempty is waived', async () => {
    const adopt = { adoptNonEmpty: true };
    const judge = (blockerCodes: string[], preTasks: number, options: object = adopt) =>
      effectiveReadiness({
        readiness: 'blocked',
        blockerCodes,
        readinessCounts: { blockers: blockerCodes.length, preTasks },
        options,
      });
    expect(judge(['target.exists-nonempty'], 0)).toBe('ready');
    expect(judge(['target.exists-nonempty'], 2)).toBe('needs_attention');
    expect(judge(['target.exists-nonempty', 'change-requests.open'], 0)).toBe('blocked');
    expect(judge(['target.exists-nonempty'], 0, {})).toBe('blocked');
    expect(judge([], 0)).toBe('blocked');
    expect(
      effectiveReadiness({
        readiness: 'ready',
        blockerCodes: [],
        readinessCounts: null,
        options: adopt,
      }),
    ).toBe('ready');

    const world = await readyMigration('blocked');
    await db().migration.update({
      where: { id: world.migrationId },
      data: {
        plannedTargetName: 'plat-r',
        blockerCodes: ['target.exists-nonempty'],
        readinessCounts: { blockers: 1, preTasks: 0, postTasks: 0, warnings: 0 },
      },
    });
    const base = {
      migrationId: world.migrationId,
      kind: 'migrate' as const,
      triggeredById: world.actorId,
    };
    await expect(createRun(db(), base)).rejects.toMatchObject({ code: 'run.readiness_required' });
    const created = await createRun(db(), {
      ...base,
      options: adopt,
      confirm: 'acme/plat-r',
    });
    expect(created.runId).toBeTruthy();
  });

  it('[LIF-077] a rollback needs the target full name as confirm, in any case; no target means nothing to confirm', () => {
    const check = (confirm: string | undefined, targetFullName: string | null) =>
      checkRunOptions({ kind: 'rollback', options: undefined, confirm, targetFullName });
    expect(check(undefined, 'acme/x')).toMatchObject({
      ok: false,
      code: 'run.confirmation_required',
    });
    expect(check('acme/y', 'acme/x')).toMatchObject({ ok: false });
    expect(check('ACME/X', 'acme/x')).toMatchObject({ ok: true });
    expect(check(undefined, null)).toMatchObject({ ok: true });
  });

  it('[LIF-043] refuses unknown options and adoptNonEmpty on kinds that push no refs', () => {
    const check = (
      kind: 'migrate' | 'verify' | 'source_read_only',
      options: unknown,
      confirm?: string,
    ) => checkRunOptions({ kind, options, confirm, targetFullName: 'acme/x' });
    expect(check('migrate', { surprise: true })).toMatchObject({
      ok: false,
      code: 'run.options_invalid',
    });
    expect(check('migrate', { adoptNonEmpty: 'yes' })).toMatchObject({
      ok: false,
      code: 'run.options_invalid',
    });
    expect(check('verify', { adoptNonEmpty: true }, 'acme/x')).toMatchObject({
      ok: false,
      code: 'run.options_invalid',
    });
    expect(check('migrate', { skipSourceReadOnly: true })).toEqual({
      ok: true,
      options: { skipSourceReadOnly: true },
    });
    expect(check('migrate', undefined)).toEqual({ ok: true, options: {} });
    // LIF-070: the opt-out belongs to the Runs that lock the source as their step 14.
    expect(check('verify', { skipSourceReadOnly: true })).toMatchObject({
      ok: false,
      code: 'run.options_invalid',
    });
    expect(check('source_read_only', { skipSourceReadOnly: false })).toMatchObject({
      ok: false,
      code: 'run.options_invalid',
    });
    expect(
      checkRunOptions({
        kind: 'migrate',
        options: { adoptNonEmpty: true },
        confirm: 'x',
        targetFullName: null,
      }),
    ).toMatchObject({ ok: false, code: 'run.confirmation_required' });
  });

  it('[LIF-043] a Run option the request leaves out is not stored, and an unknown one is refused at creation', async () => {
    const world = await readyMigration();
    await expect(
      createRun(db(), {
        migrationId: world.migrationId,
        kind: 'migrate',
        triggeredById: world.actorId,
        options: { force: true },
      }),
    ).rejects.toMatchObject({ code: 'run.options_invalid', httpStatus: 422 });
    const created = await createRun(db(), {
      migrationId: world.migrationId,
      kind: 'run_anyway',
      triggeredById: world.actorId,
    });
    expect((await db().run.findUniqueOrThrow({ where: { id: created.runId } })).options).toEqual(
      {},
    );
  });
});

describe('[LIF-011] a Route retargeted after its target was made (ADR-0504)', () => {
  const repository = (endpointId: string, namespaceId: string, slug = 'acme', key = null) => ({
    endpointId,
    namespaceId,
    namespace: { slug, key },
  });
  const route = (
    targetEndpointId: string,
    targetNamespaceId: string | null,
    targetNamespacePath = 'acme',
  ) => ({ targetEndpointId, targetNamespaceId, targetNamespacePath });

  it('[LIF-011] a target is outside its Route when the target Endpoint or the resolved Namespace changed', () => {
    expect(targetOutsideRoute({ repository: repository('e', 'n'), route: route('e', 'n') })).toBe(
      false,
    );
    expect(targetOutsideRoute({ repository: repository('e', 'n'), route: route('f', 'n') })).toBe(
      true,
    );
    expect(targetOutsideRoute({ repository: repository('e', 'n'), route: route('e', 'm') })).toBe(
      true,
    );
  });

  it('[LIF-011] while the new Namespace is not resolved, the configured path is compared as inventory resolves it', () => {
    const unresolved = (path: string) => route('e', null, path);
    expect(
      targetOutsideRoute({ repository: repository('e', 'n', 'Acme'), route: unresolved('acme') }),
    ).toBe(false);
    expect(
      targetOutsideRoute({
        repository: { endpointId: 'e', namespaceId: 'n', namespace: { slug: 'x', key: 'ACME' } },
        route: unresolved('acme'),
      }),
    ).toBe(false);
    expect(
      targetOutsideRoute({ repository: repository('e', 'n'), route: unresolved('acme-b') }),
    ).toBe(true);
  });

  /** A migrated Migration whose target sits in Namespace `acme`, then the Route moves to `acme-b`. */
  async function retargeted(change: 'namespace' | 'endpoint') {
    const world = await readyMigration('ready', 'verified');
    const namespace = await db().namespace.create({
      data: {
        endpointId: world.targetEndpointId,
        providerId: 'org-a',
        kind: 'organization',
        slug: 'acme',
        name: 'acme',
      },
    });
    const target = await db().repository.create({
      data: {
        endpointId: world.targetEndpointId,
        namespaceId: namespace.id,
        providerId: 'target-a',
        slug: 'r',
        name: 'r',
        fullPath: 'acme/r',
        isPrivate: true,
        lastInventoriedAt: new Date(),
      },
    });
    await db().migration.update({
      where: { id: world.migrationId },
      data: { targetRepositoryId: target.id, targetCreatedByFramework: true },
    });
    if (change === 'namespace') {
      await db().route.update({
        where: { id: world.routeId },
        data: { targetNamespacePath: 'acme-b', targetNamespaceId: null },
      });
    } else {
      const other = await db().endpoint.create({
        data: {
          id: `${world.targetEndpointId}-other`,
          providerType: 'type-a',
          displayName: 'other',
          baseUrl: 'http://other.test',
          status: 'active',
          configHash: 'h',
        },
      });
      await db().route.update({
        where: { id: world.routeId },
        data: { targetEndpointId: other.id, targetNamespaceId: null },
      });
    }
    return world;
  }

  it('[LIF-011] refuses every Run that works on the target in the Route Namespace, and changes nothing', async () => {
    const world = await retargeted('namespace');
    for (const kind of ['migrate', 'run_anyway', 'resync', 'verify'] as const) {
      await expect(
        createRun(db(), { migrationId: world.migrationId, kind, triggeredById: world.actorId }),
        kind,
      ).rejects.toMatchObject({
        code: 'run.not_permitted',
        httpStatus: 409,
        message: expect.stringContaining('acme/r is not in the Route'),
      });
    }
    const after = await db().migration.findUniqueOrThrow({ where: { id: world.migrationId } });
    expect(after.status).toBe('verified');
    expect(await db().run.count({ where: { migrationId: world.migrationId } })).toBe(0);
  });

  it('[LIF-077] a rollback is still admitted, so the target can be removed where it is', async () => {
    const world = await retargeted('namespace');
    const created = await createRun(db(), {
      migrationId: world.migrationId,
      kind: 'rollback',
      triggeredById: world.actorId,
      confirm: 'acme/r',
    });
    expect(created.routing.kind).toBe('rollback');
  });

  it('[LIF-077] a target left on the Route old target Endpoint is rolled back there, while that Endpoint is configured', async () => {
    const world = await retargeted('endpoint');
    const rollback = () =>
      createRun(db(), {
        migrationId: world.migrationId,
        kind: 'rollback',
        triggeredById: world.actorId,
        confirm: 'acme/r',
      });
    await db().endpoint.update({
      where: { id: world.targetEndpointId },
      data: { status: 'retired' },
    });
    await expect(rollback()).rejects.toMatchObject({
      code: 'run.not_permitted',
      message: expect.stringContaining('no longer configured'),
    });
    await db().endpoint.update({
      where: { id: world.targetEndpointId },
      data: { status: 'active' },
    });
    expect((await rollback()).routing.kind).toBe('rollback');
  });

  /** A Migration with no target repository whose writes were pinned to Namespace `acme`. */
  async function pinnedWithoutRepository() {
    const world = await readyMigration('ready', 'verified');
    const namespace = await db().namespace.create({
      data: {
        endpointId: world.targetEndpointId,
        providerId: 'org-pinned',
        kind: 'organization',
        slug: 'acme',
        name: 'acme',
      },
    });
    await db().migration.update({
      where: { id: world.migrationId },
      data: {
        targetPlacedEndpointId: world.targetEndpointId,
        targetPlacedNamespaceId: namespace.id,
      },
    });
    await db().route.update({
      where: { id: world.routeId },
      data: { targetNamespacePath: 'acme-b', targetNamespaceId: null },
    });
    return world;
  }

  it('[LIF-011] an open create intent written in the old Namespace (no target repository yet) refuses the Run', async () => {
    const world = await pinnedWithoutRepository();
    await mutation(world, { kind: 'repository', name: 'r' }, { state: 'intended' });
    await expect(
      createRun(db(), {
        migrationId: world.migrationId,
        kind: 'resync',
        triggeredById: world.actorId,
      }),
    ).rejects.toMatchObject({
      code: 'run.not_permitted',
      message: expect.stringContaining('Namespace acme is not in the Route'),
    });
  });

  it('[LIF-011] a recorded repository creation not undone, with no target repository linked, refuses the Run', async () => {
    const world = await pinnedWithoutRepository();
    await mutation(world, { kind: 'repository', id: 'repo-a', name: 'r' });
    for (const kind of ['migrate', 'resync'] as const) {
      await expect(
        createRun(db(), { migrationId: world.migrationId, kind, triggeredById: world.actorId }),
        kind,
      ).rejects.toMatchObject({ code: 'run.not_permitted' });
    }
  });

  it('[LIF-077] a rollback is refused before it deletes anything when a repository it created is on an Endpoint that is not configured', async () => {
    const world = await retargeted('namespace');
    const retired = await db().endpoint.create({
      data: {
        id: `${world.targetEndpointId}-gone`,
        providerType: 'type-a',
        displayName: 'gone',
        baseUrl: 'http://gone.test',
        status: 'retired',
        configHash: 'h',
      },
    });
    await mutation(world, { kind: 'repository', id: 'earlier', name: 'e', endpointId: retired.id });
    await expect(
      createRun(db(), {
        migrationId: world.migrationId,
        kind: 'rollback',
        triggeredById: world.actorId,
        confirm: 'acme/r',
      }),
    ).rejects.toMatchObject({
      code: 'run.not_permitted',
      message: expect.stringContaining(`Endpoint ${retired.id}, which is no longer configured`),
    });
  });
});

describe('[LIF-011] a pin with nothing to protect, legacy places and confirmation names (ADR-0504)', () => {
  /** A Migration pinned to Namespace `acme`, then the Route corrected to `acme-b`. */
  async function pinned(readiness: 'ready' | 'needs_attention' = 'ready') {
    const world = await readyMigration(readiness, 'analyzed');
    const namespace = await db().namespace.create({
      data: {
        endpointId: world.targetEndpointId,
        providerId: 'org-stale',
        kind: 'organization',
        slug: 'acme',
        name: 'acme',
      },
    });
    await db().migration.update({
      where: { id: world.migrationId },
      data: {
        targetPlacedEndpointId: world.targetEndpointId,
        targetPlacedNamespaceId: namespace.id,
        plannedTargetName: 'r',
      },
    });
    await db().route.update({
      where: { id: world.routeId },
      data: { targetNamespacePath: 'acme-b', targetNamespaceId: null },
    });
    return world;
  }
  const route = async (routeId: string) => db().route.findUniqueOrThrow({ where: { id: routeId } });

  it('[LIF-011] a pin left by a Run that failed before its first write does not refuse a Run once the Route is corrected', async () => {
    const world = await pinned();
    // What the Analysis reads too: no placement, so no target-outside-route blocker.
    expect(await loadPlacement(db(), world.migrationId)).toBeUndefined();
    expect(
      placementOutside(await loadPlacement(db(), world.migrationId), await route(world.routeId)),
    ).toBe(false);
    const created = await createRun(db(), {
      migrationId: world.migrationId,
      kind: 'migrate',
      triggeredById: world.actorId,
    });
    expect(created.routing.kind).toBe('migrate');
  });

  it('[LIF-011] the same pin counts once a target write is recorded', async () => {
    const world = await pinned();
    await mutation(world, { kind: 'branch-rule', pattern: 'main' });
    expect((await loadPlacement(db(), world.migrationId))?.namespace.slug).toBe('acme');
    await expect(
      createRun(db(), {
        migrationId: world.migrationId,
        kind: 'migrate',
        triggeredById: world.actorId,
      }),
    ).rejects.toMatchObject({ code: 'run.not_permitted' });
  });

  it('[LIF-077] a rollback of a ledger-only target outside the Route confirms the name in the pinned Namespace', async () => {
    const world = await pinned();
    await mutation(world, { kind: 'repository', name: 'r' }, { state: 'intended' });
    const rollback = (confirm: string) =>
      createRun(db(), {
        migrationId: world.migrationId,
        kind: 'rollback',
        triggeredById: world.actorId,
        confirm,
      });
    await expect(rollback('acme-b/r')).rejects.toMatchObject({
      code: 'run.confirmation_required',
    });
    expect((await rollback('acme/r')).routing.kind).toBe('rollback');
  });

  it('[LIF-077] a legacy rollback confirms the target full name in the Route Namespace, and pins that place when admitted', async () => {
    const { world, namespaceId } = await legacy();
    await db().migration.update({
      where: { id: world.migrationId },
      data: { plannedTargetName: 'r' },
    });
    const rollback = (confirm?: string) =>
      createRun(db(), {
        migrationId: world.migrationId,
        kind: 'rollback',
        triggeredById: world.actorId,
        ...(confirm === undefined ? {} : { confirm }),
      });
    for (const typed of [undefined, 'acme', 'elsewhere/r']) {
      await expect(rollback(typed), String(typed)).rejects.toMatchObject({
        code: 'run.confirmation_required',
        message: expect.stringContaining('by typing acme/r'),
      });
    }
    expect((await rollback('ACME/r')).routing.kind).toBe('rollback');
    const row = await db().migration.findUniqueOrThrow({ where: { id: world.migrationId } });
    // Pinned in the admitting transaction; the flag stays until the rollback completes.
    expect(row).toMatchObject({
      targetPlacedEndpointId: world.targetEndpointId,
      targetPlacedNamespaceId: namespaceId,
      targetPlacementUnknown: true,
    });

    // The Route is retargeted while the rollback waits: it still reverts in the confirmed place.
    const other = await db().namespace.create({
      data: {
        endpointId: world.targetEndpointId,
        providerId: 'org-new',
        kind: 'organization',
        slug: 'acme-b',
        name: 'acme-b',
      },
    });
    await db().route.update({
      where: { id: world.routeId },
      data: { targetNamespacePath: 'acme-b', targetNamespaceId: other.id },
    });
    const ctx = { services: { db: db() }, migration: { id: world.migrationId } } as never;
    const rollbackWorld = await loadRollbackWorld(ctx);
    expect(rollbackWorld.targetEndpointId).toBe(world.targetEndpointId);
    expect(rollbackWorld.namespace).toEqual({ providerId: 'org-legacy', slug: 'acme' });
  });

  it('[LIF-011] an endpoint-scope legacy Migration confirms the Namespace path', async () => {
    const { world } = await legacy();
    await db().migration.update({
      where: { id: world.migrationId },
      data: { plannedTargetName: 'r' },
    });
    // The repository-scope name is refused for a repository Migration with a planned name.
    await expect(
      createRun(db(), {
        migrationId: world.migrationId,
        kind: 'verify',
        triggeredById: world.actorId,
        confirm: 'acme',
      }),
    ).rejects.toMatchObject({ code: 'run.confirmation_required' });
    expect(
      legacyConfirmationName({
        scope: 'endpoint',
        plannedTargetName: null,
        route: { targetNamespacePath: 'acme' },
      }),
    ).toBe('acme');
    expect(
      legacyConfirmationName({
        scope: 'repository',
        plannedTargetName: 'r',
        route: { targetNamespacePath: 'acme' },
      }),
    ).toBe('acme/r');
  });

  /** A legacy Migration (writes, no known place) whose Route target Namespace is resolved. */
  async function legacy(readiness: 'ready' | 'blocked' = 'ready') {
    const world = await readyMigration(readiness, 'verified');
    await mutation(world, { kind: 'team', id: 't1', slug: 'platform' });
    const namespace = await db().namespace.create({
      data: {
        endpointId: world.targetEndpointId,
        providerId: 'org-legacy',
        kind: 'organization',
        slug: 'acme',
        name: 'acme',
      },
    });
    await db().route.update({
      where: { id: world.routeId },
      data: { targetNamespaceId: namespace.id },
    });
    await db().migration.update({
      where: { id: world.migrationId },
      data: {
        targetPlacementUnknown: true,
        ...(readiness === 'blocked'
          ? {
              blockerCodes: [TARGET_PLACEMENT_UNKNOWN],
              readinessCounts: { blockers: 1, preTasks: 0, postTasks: 0, warnings: 0 },
            }
          : {}),
      },
    });
    return { world, namespaceId: namespace.id };
  }

  it('[LIF-011] a legacy Migration refuses every Run on the target until the Namespace is confirmed', async () => {
    const { world } = await legacy();
    for (const kind of ['migrate', 'run_anyway', 'resync', 'verify'] as const) {
      await expect(
        createRun(db(), { migrationId: world.migrationId, kind, triggeredById: world.actorId }),
        kind,
      ).rejects.toMatchObject({
        code: 'run.confirmation_required',
        message: expect.stringContaining('did not record where'),
      });
    }
    const row = await db().migration.findUniqueOrThrow({ where: { id: world.migrationId } });
    expect(row.targetPlacementUnknown).toBe(true);
    expect(row.targetPlacedEndpointId).toBeNull();
  });

  it('[LIF-011] the confirmation admits the Run past its own blocker, pins the Route place and clears the flag in one step', async () => {
    const { world, namespaceId } = await legacy('blocked');
    const created = await createRun(db(), {
      migrationId: world.migrationId,
      kind: 'migrate',
      triggeredById: world.actorId,
      confirm: 'ACME',
    });
    expect(created.routing.kind).toBe('migrate');
    const row = await db().migration.findUniqueOrThrow({ where: { id: world.migrationId } });
    expect(row).toMatchObject({
      targetPlacementUnknown: false,
      targetPlacedEndpointId: world.targetEndpointId,
      targetPlacedNamespaceId: namespaceId,
    });
  });

  it('[LIF-011] a Run queued past the guard does not pin a legacy Migration: its Step refuses', async () => {
    const { world } = await legacy();
    const route = await db().route.findUniqueOrThrow({ where: { id: world.routeId } });
    await expect(checkPlacement(db(), world.migrationId, 'resync', route)).rejects.toMatchObject({
      code: TARGET_PLACEMENT_UNKNOWN,
    });
    const row = await db().migration.findUniqueOrThrow({ where: { id: world.migrationId } });
    expect(row.targetPlacedEndpointId).toBeNull();
  });
});
