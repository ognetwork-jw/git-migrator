import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { computeParity, type FacetParity } from './compute.ts';
import {
  KEY,
  KEYS,
  NOW,
  never,
  parityDeps,
  REFS,
  rateLimitedError,
  SETTINGS,
  SHA_A,
  SHA_B,
  SHA_C,
  Sim,
  seedParityWorld,
  transientError,
} from './parity.fixture.ts';
import { runParity } from './run.ts';

vi.setConfig({ testTimeout: 30_000 });

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase('gm_t072a_');
}, 120_000);
afterAll(async () => {
  await t?.drop();
}, 60_000);

const db = () => t.db.privileged;
const options = { shutdown: never.signal, pool: 'interactive' as const };

const compute = async (
  sim: Sim,
  migrationId: string,
  extra: Parameters<typeof parityDeps>[3] = {},
) => {
  const result = await computeParity(parityDeps(db(), t.db.pool, sim, extra), migrationId, options);
  if (result.skipped) throw new Error(`skipped: ${result.skipped}`);
  return result;
};
const byKey = (facets: readonly FacetParity[], key: string): FacetParity => {
  const found = facets.find((f) => f.facetKey === key);
  if (!found) throw new Error(`no result for ${key}`);
  return found;
};

describe('[LIF-060] the Parity Check', () => {
  it('[LIF-060] compares the translated source with the target per Facet and reports equal Facets', async () => {
    const sim = new Sim()
      .both('repository-settings', SETTINGS)
      .both('deploy-keys', KEYS)
      .both('git-refs', REFS);
    const w = await seedParityWorld(db());
    const result = await compute(sim, w.migrationId);
    expect(result.facets.map((f) => [f.facetKey, f.status])).toEqual([
      ['deploy-keys', 'equal'],
      ['git-refs', 'equal'],
      ['repository-settings', 'equal'],
    ]);
  });

  it('[LIF-060] a differing target gives `different` with the desired and actual values per path', async () => {
    const sim = new Sim().differ('repository-settings', SETTINGS, {
      ...SETTINGS,
      description: 'edited on the target',
    });
    const w = await seedParityWorld(db());
    const facet = byKey((await compute(sim, w.migrationId)).facets, 'repository-settings');
    expect(facet.status).toBe('different');
    expect(facet.diffs).toEqual([
      { path: '/description', source: 'a repository', target: 'edited on the target' },
    ]);
  });

  it('[LIF-060] the desired document is the translation, not the raw source: lossy approximations are not differences', async () => {
    // The target holds the approximated value the framework would write; comparing the raw source
    // with it would report a difference that is no drift.
    const source = { ...SETTINGS, forking: 'private-only' };
    const sim = new Sim().both('repository-settings', source);
    const w = await seedParityWorld(db());
    expect(byKey((await compute(sim, w.migrationId)).facets, 'repository-settings').status).toBe(
      'equal',
    );
  });

  it('[LIF-060] Facets with compare none (change-requests, extras) write no ParityResult', async () => {
    const sim = new Sim()
      .both('repository-settings', SETTINGS)
      .both('change-requests', { requests: [] });
    const w = await seedParityWorld(db());
    const keys = (await compute(sim, w.migrationId)).facets.map((f) => f.facetKey);
    expect(keys).toEqual(['repository-settings']);
  });

  it('[LIF-060] an Overlay is merged into the desired document, and a disabled one is not', async () => {
    const sim = new Sim().differ('repository-settings', SETTINGS, {
      ...SETTINGS,
      description: 'overlay text',
    });
    const w = await seedParityWorld(db());
    const overlay = await db().overlay.create({
      data: {
        routeId: w.routeId,
        facetKey: 'repository-settings',
        data: { description: 'overlay text' },
        enabled: false,
      },
    });
    expect(byKey((await compute(sim, w.migrationId)).facets, 'repository-settings').status).toBe(
      'different',
    );
    await db().overlay.update({ where: { id: overlay.id }, data: { enabled: true } });
    expect(byKey((await compute(sim, w.migrationId)).facets, 'repository-settings').status).toBe(
      'equal',
    );
  });

  it('[LIF-045] a resource the framework created on the source is removed before translation', async () => {
    const withLock = {
      keys: [
        ...KEYS.keys,
        { publicKey: 'ssh-ed25519 AAAAFrameworkOnly', title: 'fw', readOnly: true },
      ],
    };
    const sim = new Sim().differ('deploy-keys', withLock, {
      keys: KEYS.keys.map((k) => ({ ...k })),
    });
    const w = await seedParityWorld(db());
    expect(byKey((await compute(sim, w.migrationId)).facets, 'deploy-keys').status).toBe(
      'different',
    );
    const run = await db().run.create({
      data: {
        migrationId: w.migrationId,
        kind: 'migrate',
        triggeredById: w.actorId,
        options: {},
        status: 'succeeded',
      },
    });
    await db().mutation.create({
      data: {
        migrationId: w.migrationId,
        runId: run.id,
        side: 'source',
        facetKey: 'deploy-keys',
        action: 'create',
        resourceRef: {},
        paths: ['/keys[publicKey=ssh-ed25519 AAAAFrameworkOnly]'],
      },
    });
    expect(byKey((await compute(sim, w.migrationId)).facets, 'deploy-keys').status).toBe('equal');
  });

  it('[LIF-060] stored diffs hold no credentials: a URL with userinfo is scrubbed', async () => {
    const leak = ['https://ci:', 'pw-fake-value', '@h.example/x'].join('');
    const sim = new Sim().differ(
      'repository-settings',
      { ...SETTINGS, homepage: leak },
      { ...SETTINGS, homepage: null },
    );
    const w = await seedParityWorld(db());
    const facet = byKey((await compute(sim, w.migrationId)).facets, 'repository-settings');
    expect(facet.diffs).toHaveLength(1);
    expect(JSON.stringify(facet.diffs)).not.toContain('pw-fake-value');
  });

  it('[LIF-042] a Facet that cannot be read is unverifiable and the others are still compared', async () => {
    const sim = new Sim().both('repository-settings', SETTINGS).both('deploy-keys', KEYS);
    sim.target.set('deploy-keys', () => {
      throw transientError();
    });
    const w = await seedParityWorld(db());
    const result = await compute(sim, w.migrationId);
    expect(byKey(result.facets, 'deploy-keys')).toMatchObject({
      status: 'unverifiable',
      reason: 'read-failed:transient',
    });
    expect(byKey(result.facets, 'repository-settings').status).toBe('equal');
  });

  it('[LIF-042] a source Facet that cannot be read makes that Facet unverifiable', async () => {
    const sim = new Sim().both('repository-settings', SETTINGS);
    sim.source.set('repository-settings', () => {
      throw transientError();
    });
    const w = await seedParityWorld(db());
    expect(byKey((await compute(sim, w.migrationId)).facets, 'repository-settings')).toMatchObject({
      status: 'unverifiable',
    });
  });

  it('[LIF-042] a target repository that is gone makes every Facet unverifiable', async () => {
    const sim = new Sim().both('repository-settings', SETTINGS).both('git-refs', REFS);
    sim.targetExists = false;
    const w = await seedParityWorld(db());
    const result = await compute(sim, w.migrationId);
    expect(result.facets.map((f) => [f.status, f.reason])).toEqual([
      ['unverifiable', 'target-missing'],
      ['unverifiable', 'target-missing'],
    ]);
  });

  it('[LIF-042] a rate limit ends the check so the caller can delay; it is not an unverifiable Facet', async () => {
    const sim = new Sim().both('repository-settings', SETTINGS);
    sim.target.set('repository-settings', () => {
      throw rateLimitedError();
    });
    const w = await seedParityWorld(db());
    await expect(compute(sim, w.migrationId)).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('[LIF-060] a Migration with no source repository, or a retired Route, is skipped', async () => {
    const sim = new Sim().both('repository-settings', SETTINGS);
    const w = await seedParityWorld(db());
    const deps = parityDeps(db(), t.db.pool, sim);
    expect(await computeParity(deps, '00000000-0000-0000-0000-000000000000', options)).toEqual({
      skipped: 'migration-missing',
    });
    await db().repository.update({
      where: { id: w.sourceRepositoryId },
      data: { presence: 'missing' },
    });
    expect(await computeParity(deps, w.migrationId, options)).toEqual({
      skipped: 'source-missing',
    });
    await db().repository.update({
      where: { id: w.sourceRepositoryId },
      data: { presence: 'present' },
    });
    await db().route.update({ where: { id: w.routeId }, data: { retiredAt: NOW } });
    expect(await computeParity(deps, w.migrationId, options)).toEqual({
      skipped: 'route-retired',
    });
  });
});

describe('[LIF-063] Expected Differences are subtracted', () => {
  const gitMigratorBranch = {
    ...REFS,
    refs: [
      ...REFS.refs,
      { name: 'refs/heads/git-migrator/code-ownership', kind: 'branch', target: SHA_B },
    ],
  };

  it('[LIF-063] a framework_mutation hides a target extra, and the ParityResult lists what it hid', async () => {
    const sim = new Sim().differ('git-refs', REFS, gitMigratorBranch);
    const w = await seedParityWorld(db());
    expect(byKey((await compute(sim, w.migrationId)).facets, 'git-refs').status).toBe('different');
    const ed = await db().expectedDifference.create({
      data: {
        routeId: w.routeId,
        facetKey: 'git-refs',
        path: '/refs[name=refs/heads/git-migrator/*]',
        reason: 'framework_mutation',
      },
    });
    const facet = byKey((await compute(sim, w.migrationId)).facets, 'git-refs');
    expect(facet.status).toBe('equal');
    expect(facet.excluded.length).toBeGreaterThan(0);
    expect(facet.excluded[0]).toMatchObject({
      expectedDifferenceId: ed.id,
      reason: 'framework_mutation',
    });
  });

  it('[LIF-063] a manual_accepted record of this Migration hides a difference; a revoked one does not', async () => {
    const sim = new Sim().differ('repository-settings', SETTINGS, {
      ...SETTINGS,
      description: 'drifted',
    });
    const w = await seedParityWorld(db());
    const ed = await db().expectedDifference.create({
      data: {
        routeId: w.routeId,
        migrationId: w.migrationId,
        facetKey: 'repository-settings',
        path: '/description',
        reason: 'manual_accepted',
      },
    });
    expect(byKey((await compute(sim, w.migrationId)).facets, 'repository-settings').status).toBe(
      'equal',
    );
    await db().expectedDifference.update({ where: { id: ed.id }, data: { revokedAt: NOW } });
    expect(byKey((await compute(sim, w.migrationId)).facets, 'repository-settings').status).toBe(
      'different',
    );
  });

  it('[LIF-063] a record of another Migration does not apply', async () => {
    const sim = new Sim().differ('repository-settings', SETTINGS, {
      ...SETTINGS,
      description: 'drifted',
    });
    const w = await seedParityWorld(db());
    const other = await seedParityWorld(db());
    await db().expectedDifference.create({
      data: {
        routeId: w.routeId,
        migrationId: other.migrationId,
        facetKey: 'repository-settings',
        path: '/description',
        reason: 'manual_accepted',
      },
    });
    expect(byKey((await compute(sim, w.migrationId)).facets, 'repository-settings').status).toBe(
      'different',
    );
  });

  it('[LIF-063] identity_excluded hides an element someone added on the target anyway', async () => {
    const sim = new Sim().differ('deploy-keys', KEYS, {
      keys: [...KEYS.keys, { publicKey: 'ssh-ed25519 AAAAExtra', title: 'x', readOnly: true }],
    });
    const w = await seedParityWorld(db());
    expect(byKey((await compute(sim, w.migrationId)).facets, 'deploy-keys').status).toBe(
      'different',
    );
    await db().expectedDifference.create({
      data: {
        routeId: w.routeId,
        migrationId: w.migrationId,
        facetKey: 'deploy-keys',
        path: '/keys[publicKey=ssh-ed25519 AAAAExtra]',
        reason: 'identity_excluded',
      },
    });
    expect(byKey((await compute(sim, w.migrationId)).facets, 'deploy-keys').status).toBe('equal');
  });
});

describe('[FAC-GIT-006] containment once the source is read-only', () => {
  const ahead = { ...REFS, refs: [{ name: 'refs/heads/main', kind: 'branch', target: SHA_C }] };

  it('[FAC-GIT-006] a target ref ahead of the source is a difference while the source is writable', async () => {
    const sim = new Sim().differ('git-refs', REFS, ahead);
    sim.relation = async () => 'ahead';
    const w = await seedParityWorld(db(), 'verified');
    expect(byKey((await compute(sim, w.migrationId)).facets, 'git-refs').status).toBe('different');
    expect(sim.compareCalls).toEqual([]);
  });

  it('[FAC-GIT-006] after sourceReadOnlyApplied a descendant is equal, and the strict compare is untouched', async () => {
    const sim = new Sim().differ('git-refs', REFS, ahead);
    sim.relation = async () => 'ahead';
    const w = await seedParityWorld(db(), 'verified', { sourceReadOnlyApplied: true });
    expect(byKey((await compute(sim, w.migrationId)).facets, 'git-refs').status).toBe('equal');
    expect(sim.compareCalls).toEqual([`${SHA_A}...${SHA_C}`]);
  });

  it('[FAC-GIT-006] a rewritten target ref (diverged) and an extra target branch', async () => {
    const sim = new Sim().differ('git-refs', REFS, {
      ...ahead,
      refs: [...ahead.refs, { name: 'refs/heads/feature', kind: 'branch', target: SHA_B }],
    });
    sim.relation = async () => 'diverged';
    const w = await seedParityWorld(db(), 'verified', { sourceReadOnlyApplied: true });
    const facet = byKey((await compute(sim, w.migrationId)).facets, 'git-refs');
    expect(facet.status).toBe('different');
    // The extra branch is allowed; only the diverged one is reported.
    expect(facet.diffs.map((d) => d.path)).toEqual(['/refs[name=refs/heads/main]/target']);
  });

  it('[FAC-GIT-006] an error of the compare API makes the Facet unverifiable, not equal', async () => {
    const sim = new Sim().differ('git-refs', REFS, ahead);
    sim.relation = async () => {
      throw transientError();
    };
    const w = await seedParityWorld(db(), 'verified', { sourceReadOnlyApplied: true });
    expect(byKey((await compute(sim, w.migrationId)).facets, 'git-refs')).toMatchObject({
      status: 'unverifiable',
      reason: 'compare-failed:transient',
    });
  });
});

describe('[FAC-GIT-005] LFS parity', () => {
  const OID1 = '1'.repeat(64);
  const OID2 = '2'.repeat(64);
  const source = (calls: string[]) => ({
    objects: async () => {
      calls.push('mirror');
      return [
        { oid: OID1, size: 10 },
        { oid: OID2, size: 20 },
      ];
    },
  });

  it('[FAC-GIT-005] every referenced LFS object must be downloadable from the target', async () => {
    const sim = new Sim().both('git-refs', REFS);
    const calls: string[] = [];
    const w = await seedParityWorld(db());
    const equal = byKey(
      (await compute(sim, w.migrationId, { lfs: source(calls) })).facets,
      'git-refs',
    );
    expect(equal.status).toBe('equal');
    expect(sim.lfsCalls).toEqual([[OID1, OID2]]);

    sim.lfsMissing = [OID2];
    const missing = byKey(
      (await compute(sim, w.migrationId, { lfs: source(calls) })).facets,
      'git-refs',
    );
    expect(missing.status).toBe('different');
    expect(missing.diffs).toEqual([{ path: '/lfs/oids', source: [OID2], target: [] }]);
  });

  it('[FAC-GIT-005] a source known to hold no LFS objects (lfsBytes 0) is not mirrored', async () => {
    const sim = new Sim().both('git-refs', REFS);
    const calls: string[] = [];
    const w = await seedParityWorld(db(), 'migrated', { lfsBytes: 0n });
    await compute(sim, w.migrationId, { lfs: source(calls) });
    expect(calls).toEqual([]);
  });

  it('[FAC-GIT-005] a drift check may skip LFS when refs did not change', async () => {
    const sim = new Sim().both('git-refs', REFS);
    const calls: string[] = [];
    const w = await seedParityWorld(db());
    const deps = parityDeps(db(), t.db.pool, sim, { lfs: source(calls) });
    await computeParity(deps, w.migrationId, { ...options, lfs: 'skip' });
    expect(calls).toEqual([]);
  });

  it('[FAC-GIT-005] a batch API failure makes git-refs unverifiable, never equal', async () => {
    const sim = new Sim().both('git-refs', REFS);
    const w = await seedParityWorld(db());
    const failing = {
      objects: async () => {
        throw transientError();
      },
    };
    expect(
      byKey((await compute(sim, w.migrationId, { lfs: failing })).facets, 'git-refs'),
    ).toMatchObject({ status: 'unverifiable' });
  });
});

describe('[LIF-060] ParityResult storage', () => {
  it('[LIF-060] stores one ParityResult per Facet and updates it in place on the next check', async () => {
    const sim = new Sim()
      .both('repository-settings', SETTINGS)
      .differ('deploy-keys', KEYS, { keys: [] });
    const w = await seedParityWorld(db());
    const deps = parityDeps(db(), t.db.pool, sim);
    const first = await runParity(deps, w.migrationId, options);
    expect(first.skipped).toBeUndefined();
    const rows = () =>
      db().parityResult.findMany({
        where: { migrationId: w.migrationId },
        orderBy: { facetKey: 'asc' },
      });
    const stored = await rows();
    expect(stored.map((r) => [r.facetKey, r.status])).toEqual([
      ['deploy-keys', 'different'],
      ['repository-settings', 'equal'],
    ]);
    const diffs = stored[0]?.diffs as { path: string }[];
    // The key rule redacts by key, as the diff endpoint does: public keys show as [REDACTED].
    expect(diffs.map((d) => d.path)).toEqual([
      `/keys[publicKey=${KEY}]/publicKey`,
      `/keys[publicKey=${KEY}]/readOnly`,
      `/keys[publicKey=${KEY}]/title`,
    ]);
    expect(Math.abs(Date.now() - (stored[0]?.checkedAt.getTime() ?? 0))).toBeLessThan(60_000); // database clock

    sim.target.set('deploy-keys', () => KEYS);
    await runParity(deps, w.migrationId, options);
    const again = await rows();
    expect(again.map((r) => [r.facetKey, r.status])).toEqual([
      ['deploy-keys', 'equal'],
      ['repository-settings', 'equal'],
    ]);
    expect(again.map((r) => r.id)).toEqual(stored.map((r) => r.id));
    const migration = await db().migration.findUniqueOrThrow({ where: { id: w.migrationId } });
    expect(migration.lastParityAt).toEqual(NOW);
  });

  it('[LIF-062] on demand, a Migration with a Run in flight or without a target yet is left alone', async () => {
    const sim = new Sim().both('repository-settings', SETTINGS);
    const deps = parityDeps(db(), t.db.pool, sim);
    const running = await seedParityWorld(db(), 'analyzed');
    await db().migration.update({
      where: { id: running.migrationId },
      data: { status: 'running' },
    });
    expect(await runParity(deps, running.migrationId, options)).toEqual({ skipped: 'running' });
    const analyzed = await seedParityWorld(db(), 'analyzed');
    expect(await runParity(deps, analyzed.migrationId, options)).toEqual({ skipped: 'status' });
    expect(await db().parityResult.count({ where: { migrationId: analyzed.migrationId } })).toBe(0);
  });
});
