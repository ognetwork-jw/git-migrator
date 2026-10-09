/** Round-1 review probes of T-072 as permanent tests (ADR-0395 to ADR-0397). */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { computeParity } from './compute.ts';
import { createMirrorLfsSource } from './lfs-source.ts';
import {
  KEYS,
  never,
  parityDeps,
  REFS,
  SETTINGS,
  SHA_B,
  Sim,
  seedParityWorld,
  silent,
  transientError,
} from './parity.fixture.ts';
import { runParity } from './run.ts';
import { createVerifyStep } from './step.ts';

vi.setConfig({ testTimeout: 30_000 });

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase('gm_t072c_');
}, 120_000);
afterAll(async () => {
  await t?.drop();
}, 60_000);

const db = () => t.db.privileged;
const options = { shutdown: never.signal, pool: 'interactive' as const };
const migration = (id: string) => db().migration.findUniqueOrThrow({ where: { id } });
const row = (migrationId: string, facetKey: string) =>
  db().parityResult.findFirstOrThrow({ where: { migrationId, facetKey } });

describe('a stale check never overwrites a newer one (ADR-0396)', () => {
  it('[LIF-061] a check that read an equal target, stored after a newer different one, is discarded: no row, no event', async () => {
    const w = await seedParityWorld(db(), 'verified');
    let enter: () => void = () => undefined;
    const entered = new Promise<void>((r) => {
      enter = r;
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const stale = new Sim().both('repository-settings', SETTINGS);
    const equalTarget = stale.target.get('repository-settings') as () => unknown;
    stale.target.set('repository-settings', async () => {
      enter();
      await gate; // the provider answers slowly; the document it read is the old, equal one
      return equalTarget();
    });
    const a = runParity(parityDeps(db(), t.db.pool, stale), w.migrationId, options);
    await entered;

    // Meanwhile a newer check finds the drift and the Migration drifts.
    const fresh = new Sim().differ('repository-settings', SETTINGS, {
      ...SETTINGS,
      description: 'x',
    });
    await runParity(parityDeps(db(), t.db.pool, fresh), w.migrationId, options);
    expect((await migration(w.migrationId)).status).toBe('drifted');

    release();
    expect(await a).toEqual({ skipped: 'superseded' });
    expect((await row(w.migrationId, 'repository-settings')).status).toBe('different');
    expect(await migration(w.migrationId)).toMatchObject({
      status: 'drifted',
      statusBeforeDrift: 'verified',
    });
  });

  it('[LIF-061] every stored check bumps the generation, and a stored result is never replaced by an older stamp', async () => {
    const w = await seedParityWorld(db(), 'migrated');
    const sim = new Sim().both('repository-settings', SETTINGS);
    const deps = parityDeps(db(), t.db.pool, sim);
    const before = (await migration(w.migrationId)).parityGeneration;
    await runParity(deps, w.migrationId, options);
    await runParity(deps, w.migrationId, options);
    expect((await migration(w.migrationId)).parityGeneration).toBe(before + 2n);
    const stamp = (await row(w.migrationId, 'repository-settings')).checkedAt;
    // A computation stamped earlier than the stored row (clock order) does not replace it.
    const computation = await computeParity(deps, w.migrationId, options);
    if (computation.skipped) throw new Error('skipped');
    const { storeParity } = await import('./store.ts');
    await db().$transaction(async (tx) => {
      await storeParity(tx, {
        computation: {
          ...computation,
          checkedAt: new Date(stamp.getTime() - 60_000),
          facets: computation.facets.map((f) => ({ ...f, status: 'different' as const })),
        },
        registry: deps.registry.facets,
        now: new Date(),
        log: silent,
      });
    });
    const after = await row(w.migrationId, 'repository-settings');
    expect(after.status).toBe('equal');
    expect(after.checkedAt).toEqual(stamp);
  });
});

describe('ParityResults of Facets the check did not produce', () => {
  it('[LIF-061] a stale row of a Facet that is gone is deleted and cannot decide the verdict', async () => {
    const w = await seedParityWorld(db(), 'migrated');
    await db().parityResult.create({
      data: {
        migrationId: w.migrationId,
        facetKey: 'webhooks',
        status: 'different',
        diffs: [],
        excluded: [],
        checkedAt: new Date('2026-01-01T00:00:00Z'),
      },
    });
    const sim = new Sim().both('repository-settings', SETTINGS);
    await runParity(parityDeps(db(), t.db.pool, sim), w.migrationId, options);
    expect(
      await db().parityResult.count({
        where: { migrationId: w.migrationId, facetKey: 'webhooks' },
      }),
    ).toBe(0);
    expect((await migration(w.migrationId)).status).toBe('verified');
  });

  it('[LIF-060] a check with no Facet to compare stores nothing, and the verify Step is skipped', async () => {
    const w = await seedParityWorld(db(), 'verified');
    const sim = new Sim();
    expect(await runParity(parityDeps(db(), t.db.pool, sim), w.migrationId, options)).toEqual({
      skipped: 'no-facets',
    });
    expect(await db().parityResult.count({ where: { migrationId: w.migrationId } })).toBe(0);
    expect((await migration(w.migrationId)).status).toBe('verified');
    const step = createVerifyStep(parityDeps(db(), t.db.pool, sim));
    const result = await step.run({
      migration: { id: w.migrationId },
      run: { id: 'run-1' },
      signal: never.signal,
      log: silent,
      services: undefined,
    } as never);
    expect(result).toMatchObject({ status: 'skipped' });
  });
});

describe('degraded inputs make a Facet unverifiable', () => {
  it('[LIF-042] a Facet whose dependency could not be read from the source is not compared', async () => {
    const w = await seedParityWorld(db());
    const sim = new Sim()
      .both('variables', { variables: [] })
      .both('environments', { environments: [] });
    sim.source.set('environments', () => {
      throw transientError();
    });
    const result = await computeParity(parityDeps(db(), t.db.pool, sim), w.migrationId, options);
    if (result.skipped) throw new Error('skipped');
    const byKey = Object.fromEntries(result.facets.map((f) => [f.facetKey, f.reason]));
    expect(byKey.environments).toBe('read-failed:transient');
    expect(byKey.variables).toBe('dependency-unreadable:environments');
  });

  it('[LIF-060] a repository that now holds the migrated name but is not the migrated one is target-missing', async () => {
    const w = await seedParityWorld(db());
    const sim = new Sim().both('repository-settings', SETTINGS);
    sim.targetProviderId = 'someone-elses';
    const result = await computeParity(parityDeps(db(), t.db.pool, sim), w.migrationId, options);
    if (result.skipped) throw new Error('skipped');
    expect(result.facets.map((f) => [f.status, f.reason])).toEqual([
      ['unverifiable', 'target-missing'],
    ]);
  });

  it('[LIF-063] the exclusions of a ParityResult are capped, with the total in a last entry', async () => {
    const many = {
      ...REFS,
      refs: [
        ...REFS.refs,
        ...Array.from({ length: 400 }, (_, i) => ({
          name: `refs/heads/git-migrator/b${i}`,
          kind: 'branch',
          target: SHA_B,
        })),
      ],
    };
    const w = await seedParityWorld(db());
    await db().expectedDifference.create({
      data: {
        routeId: w.routeId,
        facetKey: 'git-refs',
        path: '/refs[name=refs/heads/git-migrator/*]',
        reason: 'framework_mutation',
      },
    });
    const sim = new Sim().differ('git-refs', REFS, many);
    const result = await computeParity(parityDeps(db(), t.db.pool, sim), w.migrationId, options);
    if (result.skipped) throw new Error('skipped');
    const facet = result.facets[0];
    expect(facet?.status).toBe('equal');
    expect(facet?.excluded).toHaveLength(1001);
    expect(facet?.excluded.at(-1)).toMatchObject({ reason: 'truncated', total: 1200 });
  });
});

describe('the LFS mirror is metered, prechecked and reused', () => {
  const OID = '1'.repeat(64);
  const lfs = (log: unknown[]) => ({
    objects: async (input: Record<string, unknown>) => {
      log.push(input);
      await (input.quota as { acquire(n: number): Promise<void> } | undefined)?.acquire(3);
      return [{ oid: OID, size: 1 }];
    },
  });

  it('[JOB-041] the source endpoint’s git bucket is passed to the LFS source, and units are acquired', async () => {
    const w = await seedParityWorld(db());
    const sim = new Sim().both('git-refs', REFS);
    const seen: unknown[] = [];
    await computeParity(
      parityDeps(db(), t.db.pool, sim, { lfs: lfs(seen) }),
      w.migrationId,
      options,
    );
    expect(seen).toHaveLength(1);
    expect(sim.gitUnits).toEqual([3]);
  });

  it('[JOB-044] a denied quota ends the check as rate_limited and stores nothing', async () => {
    const w = await seedParityWorld(db(), 'verified');
    const sim = new Sim().both('git-refs', REFS);
    sim.denyGit = true;
    await expect(
      runParity(parityDeps(db(), t.db.pool, sim, { lfs: lfs([]) }), w.migrationId, options),
    ).rejects.toMatchObject({ code: 'rate_limited' });
    expect(await db().parityResult.count({ where: { migrationId: w.migrationId } })).toBe(0);
    expect((await migration(w.migrationId)).status).toBe('verified');
  });

  it('[JOB-015] the Run’s mirror from git.prepare is handed to the LFS source', async () => {
    const w = await seedParityWorld(db());
    const sim = new Sim().both('git-refs', REFS);
    const seen: Record<string, unknown>[] = [];
    await computeParity(parityDeps(db(), t.db.pool, sim, { lfs: lfs(seen) }), w.migrationId, {
      ...options,
      mirrorDir: '/scratch/run-1/mirror',
    });
    expect(seen[0]?.mirrorDir).toBe('/scratch/run-1/mirror');
  });

  it('[JOB-015] a scratch volume that is too small makes the git-refs Facet unverifiable, not the check', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gm-t072-scratch-'));
    try {
      const w = await seedParityWorld(db());
      await db().repository.update({
        where: { id: w.sourceRepositoryId },
        data: { sizeBytes: 1_000_000n },
      });
      const sim = new Sim().both('git-refs', REFS).both('repository-settings', SETTINGS);
      const source = createMirrorLfsSource({
        scratchRoot: root,
        log: silent,
        freeBytes: async () => 10,
      });
      const result = await computeParity(
        parityDeps(db(), t.db.pool, sim, { lfs: source }),
        w.migrationId,
        options,
      );
      if (result.skipped) throw new Error('skipped');
      const byKey = Object.fromEntries(result.facets.map((f) => [f.facetKey, f]));
      expect(byKey['git-refs']).toMatchObject({
        status: 'unverifiable',
        reason: 'compare-failed:scratch.insufficient',
      });
      expect(byKey['repository-settings']?.status).toBe('equal');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('[FAC-GIT-005] an existing mirror is read locally: no clone, no quota, no scratch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gm-t072-mirror-'));
    try {
      const work = join(root, 'work');
      const bare = join(root, 'bare.git');
      mkdirSync(work);
      const oid = 'a'.repeat(64);
      writeFileSync(
        join(work, 'big.bin'),
        `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 12345\n`,
      );
      writeFileSync(join(work, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
      const env = {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.invalid',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.invalid',
      };
      const git = (cwd: string, ...args: string[]) =>
        execFileSync('git', args, { cwd, env, stdio: 'pipe' });
      git(work, 'init', '-q', '-b', 'main');
      git(work, 'add', '-A');
      git(work, 'commit', '-q', '-m', 'pointer');
      git(root, 'clone', '-q', '--bare', work, bare);

      const source = createMirrorLfsSource({ scratchRoot: join(root, 'scratch'), log: silent });
      const quota = {
        acquire: async () => {
          throw new Error('a local read must not touch the quota');
        },
      };
      const objects = await source.objects({
        connection: {
          git: {
            credential: async () => {
              throw new Error('a local read needs no credential');
            },
            remoteUrl: () => 'https://git.example/x.git',
          },
        } as never,
        repository: { providerId: 'r', namespace: { providerId: 'n', slug: 'n' }, slug: 'r' },
        migrationId: 'm-1',
        signal: never.signal,
        sizeBytes: 10n ** 12n,
        quota,
        mirrorDir: bare,
      });
      expect(objects).toEqual([{ oid, size: 12345 }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('[JOB-015] the verify Step takes the mirror directory from the Run’s services', async () => {
    const w = await seedParityWorld(db());
    const sim = new Sim().both('git-refs', REFS).both('deploy-keys', KEYS);
    const seen: Record<string, unknown>[] = [];
    const step = createVerifyStep(
      parityDeps(db(), t.db.pool, sim, {
        lfs: {
          objects: async (input) => {
            seen.push(input as never);
            return [];
          },
        },
      }),
    );
    const stored: unknown[] = [];
    await step.run({
      migration: { id: w.migrationId },
      run: { id: 'run-7' },
      signal: never.signal,
      log: silent,
      services: { sourceMirror: (runId: string) => `/scratch/${runId}/mirror` },
      checkpoint: () => undefined,
      runLog: async () => undefined,
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        stored.push(1);
        return db().$transaction((tx) => fn(tx));
      },
    } as never);
    expect(seen[0]?.mirrorDir).toBe('/scratch/run-7/mirror');
    expect(stored).toHaveLength(1);
  });
});
