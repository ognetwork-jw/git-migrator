import { hashCanonical } from '@git-migrator/core';
import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRun } from '../run/guard.ts';
import { FIXED_NOW, Harness, step } from '../run/harness.fixture.ts';
import {
  KEY,
  KEYS,
  never,
  parityDeps,
  REFS,
  rateLimitedError,
  SETTINGS,
  Sim,
  seedParityWorld,
  transientError,
} from './parity.fixture.ts';
import { parityHandlers, runParity } from './run.ts';
import { createVerifyPlanner, createVerifyStep } from './step.ts';
import { PARITY_COMPLETION_ACTION, PARITY_COMPLETION_NOTE } from './store.ts';

vi.setConfig({ testTimeout: 30_000 });

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase('gm_t072b_');
}, 120_000);
afterAll(async () => {
  await t?.drop();
}, 60_000);

const db = () => t.db.privileged;
const options = { shutdown: never.signal, pool: 'interactive' as const };
const equalSim = () =>
  new Sim().both('repository-settings', SETTINGS).both('deploy-keys', KEYS).both('git-refs', REFS);
const migration = (id: string) => db().migration.findUniqueOrThrow({ where: { id } });

const KEY_TASK = { keyName: 'ci', publicKey: KEY };
async function addTask(
  migrationId: string,
  over: Partial<{
    facetKey: string;
    code: string;
    params: Record<string, unknown>;
    verifiable: boolean;
    phase: 'pre' | 'post';
    origin: string;
  }> = {},
) {
  const params = over.params ?? KEY_TASK;
  return db().manualTask.create({
    data: {
      migrationId,
      facetKey: over.facetKey ?? 'deploy-keys',
      code: over.code ?? 'deploy-keys.key-in-use',
      phase: over.phase ?? 'post',
      origin: over.origin ?? 'analysis',
      params: params as never,
      verifiable: over.verifiable ?? true,
      paramsHash: hashCanonical(params),
    },
  });
}

describe('[LIF-061] verifiable tasks complete themselves', () => {
  it('[LIF-061] an open verifiable task whose Facet reports it satisfied becomes done, with the system as actor', async () => {
    const w = await seedParityWorld(db());
    const task = await addTask(w.migrationId);
    const result = await runParity(parityDeps(db(), t.db.pool, equalSim()), w.migrationId, options);
    expect(result.skipped).toBeUndefined();
    expect(result.skipped === undefined && result.completedTasks).toEqual([task.id]);
    const done = await db().manualTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(done).toMatchObject({
      status: 'done',
      completedById: null,
      note: PARITY_COMPLETION_NOTE,
    });
    expect(done.completedAt).not.toBeNull();
    const audit = await db().auditEvent.findMany({ where: { subjectId: task.id } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorId: null,
      action: PARITY_COMPLETION_ACTION,
      subjectType: 'manual_task',
    });
  });

  it('[LIF-061] the completion keeps the reopen rule: no task is dismissed, so none can be reopened by an Analysis', async () => {
    const w = await seedParityWorld(db());
    await addTask(w.migrationId);
    await runParity(parityDeps(db(), t.db.pool, equalSim()), w.migrationId, options);
    // An Analysis reopens `dismissed` tasks with a null completedById (LIF-020 step 6). Parity only
    // ever writes `done`, and an Analysis leaves a done task alone.
    expect(
      await db().manualTask.count({ where: { migrationId: w.migrationId, status: 'dismissed' } }),
    ).toBe(0);
  });

  it('[LIF-061] a task stays open while its condition is not met, and tasks that are not verifiable are never completed', async () => {
    const w = await seedParityWorld(db());
    const sim = equalSim();
    sim.target.set('deploy-keys', () => ({ keys: [] }));
    sim.source.set('deploy-keys', () => ({ keys: [] }));
    const waiting = await addTask(w.migrationId);
    const manual = await addTask(w.migrationId, {
      verifiable: false,
      params: { keyName: 'other', publicKey: KEY },
    });
    await runParity(parityDeps(db(), t.db.pool, sim), w.migrationId, options);
    for (const id of [waiting.id, manual.id]) {
      expect((await db().manualTask.findUniqueOrThrow({ where: { id } })).status).toBe('open');
    }
    // The key arrives on the target: the verifiable one completes, the manual one still waits.
    sim.target.set('deploy-keys', () => KEYS);
    await runParity(parityDeps(db(), t.db.pool, sim), w.migrationId, options);
    expect((await db().manualTask.findUniqueOrThrow({ where: { id: waiting.id } })).status).toBe(
      'done',
    );
    expect((await db().manualTask.findUniqueOrThrow({ where: { id: manual.id } })).status).toBe(
      'open',
    );
  });

  it('[LIF-061] a Facet that could not be read completes nothing', async () => {
    const w = await seedParityWorld(db());
    const sim = equalSim();
    sim.target.set('deploy-keys', () => {
      throw transientError();
    });
    const task = await addTask(w.migrationId);
    await runParity(parityDeps(db(), t.db.pool, sim), w.migrationId, options);
    expect((await db().manualTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe(
      'open',
    );
  });

  it('[LIF-061] completing a pre task recomputes the readiness counts (LIF-004)', async () => {
    const w = await seedParityWorld(db());
    await addTask(w.migrationId, { phase: 'pre' });
    await db().migration.update({
      where: { id: w.migrationId },
      data: { readinessCounts: { blockers: 0, preTasks: 1, postTasks: 0, warnings: 0 } },
    });
    await runParity(parityDeps(db(), t.db.pool, equalSim()), w.migrationId, options);
    expect((await migration(w.migrationId)).readinessCounts).toMatchObject({ preTasks: 0 });
  });
});

describe('[LIF-061] the Migration becomes verified', () => {
  const check = (sim: Sim, id: string) => runParity(parityDeps(db(), t.db.pool, sim), id, options);

  it('[LIF-061] equal everywhere and no open task: migrated becomes verified through parity_equal', async () => {
    const w = await seedParityWorld(db(), 'migrated');
    const result = await check(equalSim(), w.migrationId);
    expect(result.skipped === undefined && result.verdict).toMatchObject({
      applied: true,
      event: 'parity_equal',
      changed: true,
    });
    const m = await migration(w.migrationId);
    expect(m.status).toBe('verified');
    expect(m.verifiedAt).not.toBeNull();
  });

  it('[LIF-061] partial becomes verified too (LIF-002), once the pre-step completes the tasks', async () => {
    const w = await seedParityWorld(db(), 'partial');
    await addTask(w.migrationId);
    await check(equalSim(), w.migrationId);
    expect((await migration(w.migrationId)).status).toBe('verified');
  });

  it('[LIF-061] an open task keeps the Migration migrated even when every Facet is equal', async () => {
    const w = await seedParityWorld(db(), 'migrated');
    await addTask(w.migrationId, { verifiable: false });
    await check(equalSim(), w.migrationId);
    expect((await migration(w.migrationId)).status).toBe('migrated');
    // Dismissing it is the other way out (LIF-061: done or dismissed).
    await db().manualTask.updateMany({
      where: { migrationId: w.migrationId },
      data: { status: 'dismissed', completedById: w.actorId },
    });
    await check(equalSim(), w.migrationId);
    expect((await migration(w.migrationId)).status).toBe('verified');
  });

  it('[LIF-061] a difference leaves a migrated Migration migrated (parity_different changes only verified ones)', async () => {
    const w = await seedParityWorld(db(), 'migrated');
    const sim = equalSim().differ('repository-settings', SETTINGS, {
      ...SETTINGS,
      description: 'x',
    });
    await check(sim, w.migrationId);
    expect((await migration(w.migrationId)).status).toBe('migrated');
  });

  it('[LIF-061] an unverifiable Facet is not a difference and does not verify', async () => {
    const w = await seedParityWorld(db(), 'migrated');
    const sim = equalSim();
    sim.target.set('git-refs', () => {
      throw transientError();
    });
    await check(sim, w.migrationId);
    expect((await migration(w.migrationId)).status).toBe('migrated');
    const verifiedBefore = await seedParityWorld(db(), 'verified');
    await check(sim, verifiedBefore.migrationId);
    expect((await migration(verifiedBefore.migrationId)).status).toBe('verified');
  });

  it('[LIF-065] differences on a verified or manually completed Migration make it drifted and keep the status', async () => {
    const sim = equalSim().differ('repository-settings', SETTINGS, {
      ...SETTINGS,
      description: 'x',
    });
    const verified = await seedParityWorld(db(), 'verified');
    await check(sim, verified.migrationId);
    expect(await migration(verified.migrationId)).toMatchObject({
      status: 'drifted',
      statusBeforeDrift: 'verified',
    });
    const manual = await seedParityWorld(db(), 'manually_completed');
    await check(sim, manual.migrationId);
    expect(await migration(manual.migrationId)).toMatchObject({
      status: 'drifted',
      statusBeforeDrift: 'manually_completed',
    });
  });

  it('[LIF-065] parity_equal returns a drifted Migration to the status it had before', async () => {
    const w = await seedParityWorld(db(), 'drifted');
    await check(equalSim(), w.migrationId);
    expect((await migration(w.migrationId)).status).toBe('verified');
  });

  it('[LIF-003] events the table does not allow are not forced: statuses without a target are skipped', async () => {
    const w = await seedParityWorld(db(), 'analyzed');
    expect(await check(equalSim(), w.migrationId)).toEqual({ skipped: 'status' });
    expect((await migration(w.migrationId)).status).toBe('analyzed');
  });

  it('[LIF-080] an endpoint Migration is checked the same way, over the endpoint Facets', async () => {
    const w = await seedParityWorld(db(), 'migrated', { scope: 'endpoint' });
    const vars = { variables: [{ name: 'ORG_VAR', value: 'v', visibility: 'all' }] };
    const sim = new Sim().both('org-variables', vars);
    const result = await check(sim, w.migrationId);
    expect(result.skipped === undefined && result.facets).toEqual({ 'org-variables': 'equal' });
    expect((await migration(w.migrationId)).status).toBe('verified');
  });

  it('[LIF-062] the parity.migration job runs the check for its Migration', async () => {
    const w = await seedParityWorld(db(), 'migrated');
    const handler = parityHandlers(parityDeps(db(), t.db.pool, equalSim()))['parity.migration'];
    if (!handler) throw new Error('no handler');
    const out = (await handler({ migrationId: w.migrationId }, {
      shutdown: never.signal,
      log: parityDeps(db(), t.db.pool, equalSim()).log,
    } as never)) as { verdict: { event: string } };
    expect(out.verdict.event).toBe('parity_equal');
    expect((await migration(w.migrationId)).status).toBe('verified');
  });
});

describe('[LIF-062] parity at the end of a Run', () => {
  async function runOf(
    kind: 'migrate' | 'verify',
    status: 'analyzed' | 'migrated' | 'verified',
    sim: Sim,
    extraSteps: ReturnType<typeof step>[] = [],
  ) {
    const h = new Harness(t);
    const deps = parityDeps(db(), t.db.pool, sim);
    h.registry.register('verify', createVerifyPlanner(deps));
    h.registry.register('migrate', {
      steps: () => [...extraSteps, createVerifyStep(deps)],
    });
    const w = await seedParityWorld(db(), status);
    const created = await createRun(db(), {
      migrationId: w.migrationId,
      kind,
      triggeredById: w.actorId,
      now: () => FIXED_NOW,
    });
    const result = await h.execute(created.runId);
    return { h, w, runId: created.runId, result };
  }

  it('[LIF-062] a migrate Run ends migrated and its verify Step makes it verified (LIF-002)', async () => {
    const { h, w, runId, result } = await runOf('migrate', 'analyzed', equalSim(), [
      step('git.push-refs'),
    ]);
    expect(result).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect(await h.stepStatuses(runId)).toEqual({
      'git.push-refs': 'succeeded',
      verify: 'succeeded',
    });
    expect((await migration(w.migrationId)).status).toBe('verified');
    expect(await db().parityResult.count({ where: { migrationId: w.migrationId } })).toBe(3);
  });

  it('[LIF-062] a migrate Run with differences stays migrated and keeps the ParityResults', async () => {
    const sim = equalSim().differ('repository-settings', SETTINGS, {
      ...SETTINGS,
      description: 'x',
    });
    const { w } = await runOf('migrate', 'analyzed', sim);
    expect((await migration(w.migrationId)).status).toBe('migrated');
    const stored = await db().parityResult.findFirstOrThrow({
      where: { migrationId: w.migrationId, facetKey: 'repository-settings' },
    });
    expect(stored.status).toBe('different');
  });

  it('[LIF-042] a failing fatal step skips verify: the Migration is failed and nothing is stored', async () => {
    const failing = step(
      'git.prepare',
      async () => {
        throw new Error('disk full');
      },
      { severity: 'fatal' },
    );
    const { h, w, runId } = await runOf('migrate', 'analyzed', equalSim(), [failing]);
    expect((await h.stepStatuses(runId)).verify).toBe('skipped');
    expect((await migration(w.migrationId)).status).toBe('failed');
    expect(await db().parityResult.count({ where: { migrationId: w.migrationId } })).toBe(0);
  });

  it('[LIF-042] a partial Run whose parity is equal becomes verified; the Run itself stays partial', async () => {
    const failing = step('facet.webhooks.apply', async () => {
      throw new Error('nope');
    });
    const { w, result } = await runOf('migrate', 'analyzed', equalSim(), [failing]);
    expect(result).toEqual({ outcome: 'finished', status: 'partial' });
    expect((await migration(w.migrationId)).status).toBe('verified');
  });

  it('[LIF-042] a parity error never fails the Run: the Facet is stored unverifiable', async () => {
    const sim = equalSim();
    sim.target.set('deploy-keys', () => {
      throw transientError();
    });
    const { h, w, runId, result } = await runOf('migrate', 'analyzed', sim);
    expect(result).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect((await h.stepStatuses(runId)).verify).toBe('succeeded');
    const stored = await db().parityResult.findFirstOrThrow({
      where: { migrationId: w.migrationId, facetKey: 'deploy-keys' },
    });
    expect(stored.status).toBe('unverifiable');
    expect((await migration(w.migrationId)).status).toBe('migrated');
    const logs = await db().runLog.findMany({ where: { runId } });
    expect(logs.some((l) => l.message.includes('deploy-keys could not be verified'))).toBe(true);
  });

  it('[LIF-042] a rate limit delays the Run at the verify Step instead of failing it', async () => {
    const sim = equalSim();
    sim.target.set('repository-settings', () => {
      throw rateLimitedError();
    });
    const { h, runId, result } = await runOf('migrate', 'analyzed', sim);
    expect(result).toMatchObject({ outcome: 'delayed' });
    expect((await h.stepStatuses(runId)).verify).toBe('pending');
    expect((await h.run(runId)).status).toBe('running');
  });

  it('[LIF-062] a verify Run returns to the status it started from, then parity decides', async () => {
    const equal = await runOf('verify', 'migrated', equalSim());
    expect(equal.result).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect((await migration(equal.w.migrationId)).status).toBe('verified');

    const sim = equalSim().differ('repository-settings', SETTINGS, {
      ...SETTINGS,
      description: 'x',
    });
    const drifted = await runOf('verify', 'verified', sim);
    expect(await migration(drifted.w.migrationId)).toMatchObject({
      status: 'drifted',
      statusBeforeDrift: 'verified',
    });
  });

  it('[LIF-062] a verify Run completes verifiable tasks before it judges (LIF-061)', async () => {
    const h = new Harness(t);
    const deps = parityDeps(db(), t.db.pool, equalSim());
    h.registry.register('verify', createVerifyPlanner(deps));
    const w = await seedParityWorld(db(), 'migrated');
    const task = await addTask(w.migrationId);
    const created = await createRun(db(), {
      migrationId: w.migrationId,
      kind: 'verify',
      triggeredById: w.actorId,
      now: () => FIXED_NOW,
    });
    await h.execute(created.runId);
    expect((await db().manualTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe(
      'done',
    );
    expect((await migration(w.migrationId)).status).toBe('verified');
  });
});
