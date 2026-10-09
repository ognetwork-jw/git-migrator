import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { reapRuns } from '../reaper.ts';
import { seedBasics } from '../world.fixture.ts';
import { finishRun, settleOrphanedMigrations } from './finish.ts';
import {
  allowedReadiness,
  createRun,
  effectiveReadiness,
  RunGuardError,
  requestRunCancel,
} from './guard.ts';
import { FIXED_NOW, Harness, silentLog, step } from './harness.fixture.ts';
import { checkRunOptions } from './options.ts';
import { requeueOrphanedQueuedRuns } from './orphans.ts';

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
