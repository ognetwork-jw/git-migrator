import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { seedBasics } from '../world.fixture.ts';
import { afterApply, applyWithLedger } from './facets.ts';
import { MirrorRegistry } from './mirror.ts';
import { createMigrationPlanner } from './plan.ts';
import { chooseDefaultBranch } from './push.ts';
import { branchesAboutToChange } from './repository.ts';
import {
  type MigrationContext,
  MigrationLinks,
  type MigrationServices,
  withSessionLock,
} from './services.ts';
import type { RunWorld } from './world.ts';

vi.setConfig({ testTimeout: 30_000 });

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase('gm_t071u_');
}, 120_000);
afterAll(async () => {
  await t?.drop();
}, 60_000);

describe('[LIF-040] the Steps of a migration Run', () => {
  it('[LIF-040] follow the Plan of the Run, leave out Steps nobody implements yet, and end with the re-analysis', async () => {
    const world = await seedBasics(t.db.privileged);
    const analysis = await t.db.privileged.analysis.create({
      data: { migrationId: world.migrationId, readiness: 'ready', translation: {} },
    });
    const codes = [
      ['preflight', 'framework'],
      ['git.prepare', 'framework'],
      ['target.ensure-repository', 'framework'],
      ['git.push-refs', 'framework'],
      ['facet.repository-settings.apply', 'repository-settings'],
      ['facet.branch-rules.apply', 'branch-rules'],
      ['verify', 'framework'],
      ['source.read-only', 'framework'],
    ] as const;
    let order = 0;
    for (const [code, facetKey] of codes) {
      await t.db.privileged.planItem.create({
        data: {
          analysisId: analysis.id,
          kind: 'step',
          code,
          facetKey,
          fieldPaths: [],
          params: {},
          order: order++,
        },
      });
    }
    const services = { db: t.db.privileged } as unknown as MigrationServices;
    const planner = createMigrationPlanner(services);
    const input = {
      run: { analysisId: analysis.id },
      migration: { scope: 'repository' },
    } as unknown as Parameters<typeof planner.steps>[0];
    const keys = async () => (await planner.steps(input)).map((s) => `${s.key}:${s.severity}`);
    expect(await keys()).toEqual([
      'preflight:fatal',
      'git.prepare:fatal',
      'target.ensure-repository:fatal',
      'git.push-refs:fatal',
      'facet.repository-settings.apply:independent',
      'facet.branch-rules.apply:independent',
      // Planned but not provided here: skipped with a reason, never dropped silently.
      'verify:advisory',
      'source.read-only:advisory',
      'analysis.refresh:advisory',
    ]);
    // Step 13 and 14 join through the services (T-072, T-073) at the place the Plan puts them.
    const verify = { key: 'verify', severity: 'advisory', run: async () => undefined };
    const withVerify = createMigrationPlanner({
      ...services,
      extraSteps: new Map([['verify', verify]]),
    } as never);
    expect((await withVerify.steps(input)).map((s) => s.key)).toContain('verify');
  });

  it('[LIF-081] an endpoint Run plans the Facet Steps the Plan lists (members has no target writer, so no Step), then verify and the re-analysis', async () => {
    const world = await seedBasics(t.db.privileged);
    const analysis = await t.db.privileged.analysis.create({
      data: { migrationId: world.migrationId, readiness: 'ready', translation: {} },
    });
    const codes = [
      ['facet.teams.apply', 'teams'],
      ['facet.org-variables.apply', 'org-variables'],
      ['facet.org-webhooks.apply', 'org-webhooks'],
      ['verify', 'framework'],
      // Not an endpoint Facet: never mapped to an implementation.
      ['facet.webhooks.apply', 'webhooks'],
    ] as const;
    let order = 0;
    for (const [code, facetKey] of codes) {
      await t.db.privileged.planItem.create({
        data: {
          analysisId: analysis.id,
          kind: 'step',
          code,
          facetKey,
          fieldPaths: [],
          params: {},
          order: order++,
        },
      });
    }
    const verify = { key: 'verify', severity: 'advisory', run: async () => undefined };
    const planner = createMigrationPlanner({
      db: t.db.privileged,
      extraSteps: new Map([['verify', verify]]),
    } as unknown as MigrationServices);
    const steps = await planner.steps({
      run: { analysisId: analysis.id },
      migration: { scope: 'endpoint' },
    } as never);
    expect(steps.map((s) => `${s.key}:${s.severity}`)).toEqual([
      'facet.teams.apply:independent',
      'facet.org-variables.apply:independent',
      'facet.org-webhooks.apply:independent',
      'verify:advisory',
      'facet.webhooks.apply:advisory',
      'analysis.refresh:advisory',
    ]);
    // A planned Step with no implementation is a skipped Step with a reason and a warning.
    const warnings: string[] = [];
    const unplanned = steps.find((s) => s.key === 'facet.webhooks.apply');
    await expect(
      unplanned?.run({ runLog: async (_l: string, m: string) => void warnings.push(m) } as never),
    ).resolves.toMatchObject({ status: 'skipped' });
    expect(warnings).toHaveLength(1);
    const none = await planner.steps({
      run: { analysisId: null },
      migration: { scope: 'endpoint' },
    } as never);
    expect(none.map((s) => s.key)).toEqual(['run.analysis']);
    await expect(none[0]?.run({} as never)).rejects.toMatchObject({
      code: 'run.analysis_missing',
    });
  });

  it('[LIF-040] a Run with no Analysis plans one fatal Step that fails with run.analysis_missing', async () => {
    const planner = createMigrationPlanner({ db: t.db.privileged } as unknown as MigrationServices);
    const steps = await planner.steps({
      run: { analysisId: null },
      migration: { scope: 'repository' },
    } as never);
    expect(steps.map((s) => `${s.key}:${s.severity}`)).toEqual(['run.analysis:fatal']);
    await expect(steps[0]?.run({} as never)).rejects.toMatchObject({
      code: 'run.analysis_missing',
    });
  });

  it('[LIF-044] the default branch is the source default, else main, else the first branch', () => {
    const refs = ['refs/heads/zeta', 'refs/heads/main', 'refs/heads/alpha', 'refs/tags/v1'];
    expect(chooseDefaultBranch('zeta', refs)).toBe('zeta');
    expect(chooseDefaultBranch('gone', refs)).toBe('main');
    expect(chooseDefaultBranch(null, ['refs/heads/zeta', 'refs/heads/alpha'])).toBe('alpha');
    expect(chooseDefaultBranch('main', ['refs/tags/v1'])).toBeUndefined();
  });
});

describe('[LIF-049] findings that only the write shows', () => {
  const ctxOf = () => {
    const tasks: Record<string, unknown>[] = [];
    const ctx = {
      findings: { addTask: async (f: Record<string, unknown>) => void tasks.push(f) },
    } as unknown as MigrationContext;
    return { ctx, tasks };
  };
  const world = {} as RunWorld;

  it('[LIF-049] force-push exemptions the target refused become a post task per rule pattern', async () => {
    const { ctx, tasks } = ctxOf();
    const record = (pattern: string, dropped: boolean) => ({
      facetKey: 'branch-rules',
      action: 'create' as const,
      resourceRef: {
        kind: 'branch-protection-rule',
        ...(dropped ? { exemptionsDropped: true } : {}),
      },
      paths: [`/rules[pattern=${pattern}]`],
      before: null,
      after: {},
    });
    await afterApply(
      ctx,
      world,
      'branch-rules',
      [record('main', true), record('dev', false), record('release/*', true), record('main', true)],
      async () => ({}),
      {},
    );
    expect(tasks.map((x) => (x.params as { pattern: string }).pattern)).toEqual([
      'main',
      'release/*',
    ]);
    expect(tasks[0]).toMatchObject({
      code: 'branch-rules.exemptions-not-applied',
      facetKey: 'branch-rules',
      phase: 'post',
    });
  });

  it('[LIF-049] a deploy key missing from the target after the apply becomes a verifiable post task', async () => {
    const { ctx, tasks } = ctxOf();
    const keys = [
      { publicKey: 'ssh-ed25519 AAAA1', title: 'one' },
      { publicKey: 'ssh-ed25519 AAAA2', title: '  ' },
    ];
    await afterApply(ctx, world, 'deploy-keys', [], async () => ({ keys: [keys[0]] }), { keys });
    expect(tasks).toEqual([
      {
        code: 'deploy-keys.key-in-use',
        facetKey: 'deploy-keys',
        phase: 'post',
        verifiable: true,
        params: { keyName: 'deploy-key', publicKey: 'ssh-ed25519 AAAA2' },
      },
    ]);
  });
});

describe('[LIF-040] step 3a chooses what to lift', () => {
  const world = (facets: Record<string, Record<string, unknown>>, adoptNonEmpty = false) =>
    ({
      adoptNonEmpty,
      facets: new Map(
        Object.entries(facets).map(([k, desired]) => [k, { desired, decisions: [] }]),
      ),
    }) as unknown as RunWorld;
  const refs = [
    { name: 'refs/heads/main', kind: 'branch', target: 'a' },
    { name: 'refs/heads/dev', kind: 'branch', target: 'b' },
    { name: 'refs/tags/v1', kind: 'tag', target: 'c' },
  ];

  it('[LIF-040] only branches the target lacks or has elsewhere count', () => {
    const w = world({ 'git-refs': { refs } });
    const have = [
      { name: 'refs/heads/main', kind: 'branch', target: 'a' },
      { name: 'refs/heads/dev', kind: 'branch', target: 'old' },
    ];
    expect(branchesAboutToChange(w, have)).toEqual(['dev']);
  });

  it('[LIF-040] target branches the reconcile deletes and the framework branches of a Change Request count', () => {
    const have = [
      { name: 'refs/heads/main', kind: 'branch', target: 'a' },
      { name: 'refs/heads/dev', kind: 'branch', target: 'b' },
      { name: 'refs/heads/stray', kind: 'branch', target: 'z' },
    ];
    expect(branchesAboutToChange(world({ 'git-refs': { refs } }), have)).toEqual([]);
    expect(branchesAboutToChange(world({ 'git-refs': { refs } }, true), have)).toEqual(['stray']);
    expect(
      branchesAboutToChange(
        world({ 'git-refs': { refs }, pipelines: { files: [{ path: 'x' }] } }),
        have,
      ),
    ).toEqual(['git-migrator/ci', 'git-migrator/codeowners']);
  });
});

describe('[JOB-015] the mirror registry', () => {
  it('[JOB-015] offers a mirror only while its directory exists', async () => {
    const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = mkdtempSync(join(tmpdir(), 'gm-mirrors-'));
    mkdirSync(join(root, 'objects'));
    const registry = new MirrorRegistry(2);
    expect(registry.sourceMirror('run-1')).toBeUndefined();
    registry.note('run-1', root);
    expect(registry.sourceMirror('run-1')).toBe(root);
    rmSync(root, { recursive: true, force: true });
    expect(registry.sourceMirror('run-1')).toBeUndefined();
  });
});

describe('[LIF-047] the Migration link in a Change Request body', () => {
  const ref = {
    providerId: 'R_1',
    namespace: { providerId: 'ns', slug: 'acme' },
    slug: 'repo',
  };

  it('[LIF-047] every apply carries the link while it writes, so an Overlay on code-ownership keeps it, and nested notes share one', async () => {
    const links = new MigrationLinks('https://gm.example/');
    const seen: (string | undefined)[] = [];
    const ctx = {
      migration: { id: 'mig-1' },
      services: { links },
      checkpoint: () => undefined,
      ledger: {
        intend: async () => 'intent',
        confirm: async () => undefined,
        recordAll: async (_write: unknown, records: AsyncIterable<unknown>) => {
          for await (const _record of records) {
            // consumed
          }
          return 0;
        },
      },
    } as unknown as MigrationContext;
    const driver = {
      async *apply() {
        seen.push(links.resolve(ref));
        yield* [] as never[];
      },
    };
    links.note(ref.providerId, 'mig-1'); // an outer holder, as the pipelines upsert is
    await applyWithLedger(ctx, {
      facetKey: 'code-ownership',
      driver: driver as never,
      side: {} as never,
      target: { scope: 'repository', repository: ref, namespace: ref.namespace },
      desired: {},
      decisions: [],
      current: {},
      umbrella: 'overlay-apply',
    });
    expect(seen).toEqual(['https://gm.example/repositories/mig-1']);
    // The inner apply ended its note; the outer holder's is still there.
    expect(links.resolve(ref)).toBe('https://gm.example/repositories/mig-1');
    links.forget(ref.providerId);
    expect(links.resolve(ref)).toBeUndefined();
  });
});

describe('[LIF-046] the name lock around the target repository', () => {
  it('[LIF-046] a lock held by another connection times out with a retryable error', async () => {
    const holder = await t.db.pool.connect();
    try {
      await holder.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', ['k-timeout']);
      await expect(
        withSessionLock(t.db.pool, 'k-timeout', async () => 'ran', { waitMs: 120, pollMs: 20 }),
      ).rejects.toMatchObject({ code: 'transient', retryable: true });
    } finally {
      await holder.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', ['k-timeout']);
      holder.release();
    }
    // Free again: it runs, and unlocks.
    await expect(withSessionLock(t.db.pool, 'k-timeout', async () => 'ran')).resolves.toBe('ran');
  });

  it('[LIF-046] the wait stops at once when the Run is cancelled', async () => {
    const holder = await t.db.pool.connect();
    const abort = new AbortController();
    try {
      await holder.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', ['k-abort']);
      setTimeout(() => abort.abort(), 50);
      await expect(
        withSessionLock(t.db.pool, 'k-abort', async () => 'ran', {
          signal: abort.signal,
          waitMs: 60_000,
          pollMs: 20,
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      await holder.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', ['k-abort']);
      holder.release();
    }
  });

  it('[LIF-046] a connection whose unlock failed is destroyed, not returned to the pool, and the outcome of the work is kept', async () => {
    const released: unknown[] = [];
    const client = {
      query: async (sql: string) => {
        if (sql.includes('pg_advisory_unlock')) throw new Error('connection reset');
        return { rows: [{ ok: true }] };
      },
      release: (error?: Error) => released.push(error),
    };
    const pool = { connect: async () => client } as never;
    await expect(withSessionLock(pool, 'k', async () => 42)).resolves.toBe(42);
    expect(released).toHaveLength(1);
    expect(released[0]).toBeInstanceOf(Error);
    await expect(
      withSessionLock(pool, 'k', async () => {
        throw new Error('work failed');
      }),
    ).rejects.toThrow('work failed');
  });
});
