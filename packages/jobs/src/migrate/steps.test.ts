import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { seedBasics } from '../world.fixture.ts';
import { afterApply } from './facets.ts';
import { MirrorRegistry } from './mirror.ts';
import { createMigrationPlanner } from './plan.ts';
import { chooseDefaultBranch } from './push.ts';
import { branchesAboutToChange } from './repository.ts';
import type { MigrationContext, MigrationServices } from './services.ts';
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
      'analysis.refresh:advisory',
    ]);
    // Step 13 and 14 join through the services (T-072, T-073) at the place the Plan puts them.
    const verify = { key: 'verify', severity: 'advisory', run: async () => undefined };
    const withVerify = createMigrationPlanner({
      ...services,
      extraSteps: new Map([['verify', verify]]),
    } as never);
    expect((await withVerify.steps(input)).map((s) => s.key)).toContain('verify');
    // An endpoint Migration has no Steps here: it fails visibly instead of doing nothing.
    const endpoint = await planner.steps({
      run: input.run,
      migration: { scope: 'endpoint' },
    } as never);
    expect(endpoint.map((s) => s.key)).toEqual(['run.scope']);
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
    expect(await registry.sourceMirror('run-1')).toBeUndefined();
    registry.note('run-1', root);
    expect(await registry.sourceMirror('run-1')).toBe(root);
    rmSync(root, { recursive: true, force: true });
    expect(await registry.sourceMirror('run-1')).toBeUndefined();
  });
});
