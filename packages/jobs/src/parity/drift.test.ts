import { hashCanonical } from '@git-migrator/core';
import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { computeParity, type FacetParity } from './compute.ts';
import {
  KEYS,
  never,
  parityDeps,
  REFS,
  SETTINGS,
  SHA_B,
  Sim,
  seedParityWorld,
} from './parity.fixture.ts';
import { DRIFT_STATUSES, parityHandlers, runParity } from './run.ts';

vi.setConfig({ testTimeout: 30_000 });

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase('gm_t089a_');
}, 120_000);
afterAll(async () => {
  await t?.drop();
}, 60_000);

const db = () => t.db.privileged;
const drift = (readsSource: boolean) => ({
  shutdown: never.signal,
  pool: 'background' as const,
  drift: { readsSource },
});

const byKey = (facets: readonly FacetParity[], key: string): FacetParity => {
  const found = facets.find((f) => f.facetKey === key);
  if (!found) throw new Error(`no result for ${key}`);
  return found;
};

/** The Facet documents as the Analysis of the Migration saw the source (its Snapshots). */
async function analyzed(migrationId: string, endpointId: string, sources: Record<string, unknown>) {
  const ids: string[] = [];
  for (const [facetKey, data] of Object.entries(sources)) {
    const row = await db().facetSnapshot.create({
      data: {
        side: 'source',
        endpointId,
        facetKey,
        schemaVersion: 1,
        data: data as never,
        unreadable: [],
        hash: hashCanonical(JSON.parse(JSON.stringify(data))),
        fetchedAt: new Date(),
        rawResponseIds: [],
      },
    });
    ids.push(row.id);
  }
  const analysis = await db().analysis.create({
    data: { migrationId, readiness: 'ready', translation: {}, sourceSnapshotIds: ids },
  });
  await db().migration.update({
    where: { id: migrationId },
    data: { latestAnalysisId: analysis.id },
  });
}

describe('[LIF-060] a drift check reads the target and the source git-refs', () => {
  it('[LIF-060] takes every other source Facet from the Analysis Snapshots unless the schedule reads the source', async () => {
    const sim = new Sim()
      .both('repository-settings', SETTINGS)
      .both('deploy-keys', KEYS)
      .both('git-refs', REFS);
    const read: string[] = [];
    for (const [key, reader] of sim.source) {
      sim.source.set(key, () => {
        read.push(key);
        return reader();
      });
    }
    const w = await seedParityWorld(db(), 'verified');
    await analyzed(w.migrationId, w.sourceEndpointId, {
      'repository-settings': SETTINGS,
      'deploy-keys': KEYS,
      'git-refs': REFS,
    });
    const deps = parityDeps(db(), t.db.pool, sim);

    const refsOnly = await computeParity(deps, w.migrationId, drift(false));
    if (refsOnly.skipped) throw new Error('skipped');
    expect(refsOnly.facets.map((f) => [f.facetKey, f.status])).toEqual([
      ['deploy-keys', 'equal'],
      ['git-refs', 'equal'],
      ['repository-settings', 'equal'],
    ]);
    expect(read).toEqual(['git-refs']);

    // The source changed since the Analysis: only a check that reads the source sees it.
    sim.source.set('repository-settings', () => ({
      ...SETTINGS,
      description: 'new on the source',
    }));
    const stale = await computeParity(deps, w.migrationId, drift(false));
    if (stale.skipped) throw new Error('skipped');
    expect(byKey(stale.facets, 'repository-settings').status).toBe('equal');
    const full = await computeParity(deps, w.migrationId, drift(true));
    if (full.skipped) throw new Error('skipped');
    expect(byKey(full.facets, 'repository-settings').status).toBe('different');
  });

  it('[LIF-060] a Migration with no Analysis is read in full', async () => {
    const sim = new Sim().both('repository-settings', SETTINGS).both('git-refs', REFS);
    const read: string[] = [];
    for (const [key, reader] of sim.source) {
      sim.source.set(key, () => {
        read.push(key);
        return reader();
      });
    }
    const w = await seedParityWorld(db(), 'verified');
    const out = await computeParity(parityDeps(db(), t.db.pool, sim), w.migrationId, drift(false));
    if (out.skipped) throw new Error('skipped');
    expect(new Set(read)).toEqual(new Set(['git-refs', 'repository-settings']));
  });

  it('[FAC-GIT-005] LFS is not checked when the refs are the ones the Analysis saw, and is when they are not', async () => {
    const sim = new Sim().both('git-refs', REFS);
    const calls: string[] = [];
    const lfs = {
      objects: async () => {
        calls.push('mirror');
        return [{ oid: '1'.repeat(64), size: 10 }];
      },
    };
    const w = await seedParityWorld(db(), 'verified');
    await analyzed(w.migrationId, w.sourceEndpointId, { 'git-refs': REFS });
    const deps = parityDeps(db(), t.db.pool, sim, { lfs });

    await computeParity(deps, w.migrationId, drift(false));
    expect(calls).toEqual([]);
    expect(sim.lfsCalls).toEqual([]);

    const moved = {
      ...REFS,
      refs: [{ name: 'refs/heads/main', kind: 'branch', target: SHA_B }],
    };
    sim.both('git-refs', moved);
    await computeParity(deps, w.migrationId, drift(false));
    expect(calls).toEqual(['mirror']);
    expect(sim.lfsCalls).toHaveLength(1);

    // An on-demand check is not a drift check: it always looks (LIF-062).
    calls.length = 0;
    sim.both('git-refs', REFS);
    await computeParity(deps, w.migrationId, {
      shutdown: never.signal,
      pool: 'background',
    });
    expect(calls).toEqual(['mirror']);
  });

  it('[LIF-065] FAC-GIT-006 containment applies to a drift check while the source is read-only', async () => {
    const extra = {
      ...REFS,
      refs: [...REFS.refs, { name: 'refs/heads/hotfix', kind: 'branch', target: SHA_B }],
    };
    const sim = new Sim().both('git-refs', REFS);
    sim.target.set('git-refs', () => extra);
    const w = await seedParityWorld(db(), 'verified', { sourceReadOnlyApplied: true });
    await analyzed(w.migrationId, w.sourceEndpointId, { 'git-refs': REFS });
    const out = await computeParity(parityDeps(db(), t.db.pool, sim), w.migrationId, drift(false));
    if (out.skipped) throw new Error('skipped');
    expect(byKey(out.facets, 'git-refs').status).toBe('equal');

    // Not read-only: the same extra branch is a difference.
    const open = await seedParityWorld(db(), 'verified', { sourceReadOnlyApplied: false });
    await analyzed(open.migrationId, open.sourceEndpointId, { 'git-refs': REFS });
    const strict = await computeParity(
      parityDeps(db(), t.db.pool, sim),
      open.migrationId,
      drift(false),
    );
    if (strict.skipped) throw new Error('skipped');
    expect(byKey(strict.facets, 'git-refs').status).toBe('different');
  });
});

describe('[LIF-065] the drift check as a job', () => {
  const sim = () =>
    new Sim()
      .both('repository-settings', SETTINGS)
      .both('deploy-keys', KEYS)
      .both('git-refs', REFS);

  it('[LIF-065] differences move a verified Migration to drifted, keep the status before and stamp the check', async () => {
    const s = sim().differ('repository-settings', SETTINGS, { ...SETTINGS, description: 'edited' });
    const w = await seedParityWorld(db(), 'verified');
    const out = await runParity(parityDeps(db(), t.db.pool, s), w.migrationId, drift(true));
    expect(out.skipped).toBeUndefined();
    const m = await db().migration.findUniqueOrThrow({ where: { id: w.migrationId } });
    expect(m).toMatchObject({ status: 'drifted', statusBeforeDrift: 'verified' });
    expect(m.lastDriftCheckAt).not.toBeNull();
    expect(m.lastParityAt).not.toBeNull();
  });

  it('[LIF-065] a check that finds nothing leaves a verified Migration alone and still stamps the check', async () => {
    const w = await seedParityWorld(db(), 'verified');
    await runParity(parityDeps(db(), t.db.pool, sim()), w.migrationId, drift(true));
    const m = await db().migration.findUniqueOrThrow({ where: { id: w.migrationId } });
    expect(m.status).toBe('verified');
    expect(m.lastDriftCheckAt).not.toBeNull();
  });

  it('[LIF-065] an on-demand Parity Check does not stamp the drift check', async () => {
    const w = await seedParityWorld(db(), 'verified');
    await runParity(parityDeps(db(), t.db.pool, sim()), w.migrationId, {
      shutdown: never.signal,
      pool: 'background',
    });
    const m = await db().migration.findUniqueOrThrow({ where: { id: w.migrationId } });
    expect(m.lastDriftCheckAt).toBeNull();
    expect(m.lastParityAt).not.toBeNull();
  });

  it('[LIF-065] a drift check applies to verified, manually completed and drifted Migrations only', async () => {
    expect(DRIFT_STATUSES).toEqual(['verified', 'manually_completed', 'drifted']);
    for (const status of ['migrated', 'partial'] as const) {
      const w = await seedParityWorld(db(), status);
      expect(
        await runParity(parityDeps(db(), t.db.pool, sim()), w.migrationId, drift(true)),
      ).toEqual({ skipped: 'status' });
      expect(
        (await db().migration.findUniqueOrThrow({ where: { id: w.migrationId } })).lastDriftCheckAt,
      ).toBeNull();
    }
    const w = await seedParityWorld(db(), 'manually_completed');
    const out = await runParity(parityDeps(db(), t.db.pool, sim()), w.migrationId, drift(true));
    expect(out.skipped).toBeUndefined();
  });

  it('[LIF-065] a drifted Migration whose differences are gone returns to the status before the drift', async () => {
    const w = await seedParityWorld(db(), 'drifted');
    const out = await runParity(parityDeps(db(), t.db.pool, sim()), w.migrationId, drift(true));
    expect(out.skipped).toBeUndefined();
    expect((await db().migration.findUniqueOrThrow({ where: { id: w.migrationId } })).status).toBe(
      'verified',
    );
  });

  it('[LIF-065] the parity.migration handler runs a drift check only for a payload that says so, with the schedule’s source setting', async () => {
    const s = sim().differ('repository-settings', SETTINGS, { ...SETTINGS, description: 'edited' });
    const w = await seedParityWorld(db(), 'verified');
    await analyzed(w.migrationId, w.sourceEndpointId, {
      'repository-settings': { ...SETTINGS, description: 'edited' },
      'deploy-keys': KEYS,
      'git-refs': REFS,
    });
    const handler = parityHandlers(parityDeps(db(), t.db.pool, s, { driftReadsSource: false }))[
      'parity.migration'
    ] as unknown as (payload: unknown, ctx: unknown) => Promise<unknown>;
    const ctx = { shutdown: never.signal, log: parityDeps(db(), t.db.pool, s).log };
    // From the Snapshots the source description is `edited`, so the target equals it: no drift.
    await handler({ migrationId: w.migrationId, drift: true }, ctx);
    let m = await db().migration.findUniqueOrThrow({ where: { id: w.migrationId } });
    expect(m.status).toBe('verified');
    expect(m.lastDriftCheckAt).not.toBeNull();
    // An on-demand check reads the source in full and sees the difference.
    await handler({ migrationId: w.migrationId }, ctx);
    m = await db().migration.findUniqueOrThrow({ where: { id: w.migrationId } });
    expect(m.status).toBe('drifted');
  });
});
describe('[LIF-065] round 2: what a drift check must not do', () => {
  it('[LIF-065] a refs-only check reads live a Facet the Analysis has no Snapshot of, and sees the removed protection instead of dropping the Facet', async () => {
    const sim = new Sim()
      .both('repository-settings', SETTINGS)
      .both('git-refs', REFS)
      .differ('deploy-keys', KEYS, { keys: [] });
    const read: string[] = [];
    for (const [key, reader] of sim.source) {
      sim.source.set(key, () => {
        read.push(key);
        return reader();
      });
    }
    const w = await seedParityWorld(db(), 'verified');
    // The Analysis withheld deploy-keys: it has Snapshots of the others only.
    await analyzed(w.migrationId, w.sourceEndpointId, {
      'repository-settings': SETTINGS,
      'git-refs': REFS,
    });
    const deps = parityDeps(db(), t.db.pool, sim);
    const out = await computeParity(deps, w.migrationId, drift(false));
    if (out.skipped) throw new Error('skipped');
    expect(byKey(out.facets, 'deploy-keys').status).toBe('different');
    expect(new Set(read)).toEqual(new Set(['git-refs', 'deploy-keys']));
    // And as a job: the Migration drifts.
    await runParity(deps, w.migrationId, drift(false));
    expect((await db().migration.findUniqueOrThrow({ where: { id: w.migrationId } })).status).toBe(
      'drifted',
    );
  });

  it('[LIF-065] a Facet that cannot be read live is unverifiable, never omitted', async () => {
    const sim = new Sim().both('repository-settings', SETTINGS).both('git-refs', REFS);
    sim.both('deploy-keys', KEYS);
    sim.source.set('deploy-keys', () => {
      throw new Error('boom');
    });
    const w = await seedParityWorld(db(), 'verified');
    await analyzed(w.migrationId, w.sourceEndpointId, {
      'repository-settings': SETTINGS,
      'git-refs': REFS,
    });
    const out = await computeParity(parityDeps(db(), t.db.pool, sim), w.migrationId, drift(false));
    if (out.skipped) throw new Error('skipped');
    expect(byKey(out.facets, 'deploy-keys').status).toBe('unverifiable');
  });

  it('[LIF-062] a drift check that started before an Expected Difference changed is superseded: it stores nothing, so it cannot replace the check the change enqueued', async () => {
    const sim = new Sim()
      .differ('repository-settings', SETTINGS, { ...SETTINGS, description: 'edited' })
      .both('git-refs', REFS);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    sim.source.set('repository-settings', async () => {
      await gate;
      return SETTINGS;
    });
    const w = await seedParityWorld(db(), 'verified');
    const deps = parityDeps(db(), t.db.pool, sim);
    const running = runParity(deps, w.migrationId, drift(true));
    // The API commits an acceptance meanwhile: it moves the generation in its transaction.
    await new Promise((r) => setTimeout(r, 300));
    await db()
      .$executeRaw`UPDATE app.migration SET parity_generation = parity_generation + 1 WHERE id = ${w.migrationId}`;
    release();
    expect(await running).toEqual({ skipped: 'superseded' });
    const m = await db().migration.findUniqueOrThrow({ where: { id: w.migrationId } });
    expect(m.status).toBe('verified');
    expect(await db().parityResult.count({ where: { migrationId: w.migrationId } })).toBe(0);
    // The check that follows the change stores its result.
    const next = await runParity(parityDeps(db(), t.db.pool, sim), w.migrationId, {
      shutdown: never.signal,
      pool: 'background',
    });
    expect(next.skipped).toBeUndefined();
  });
});
