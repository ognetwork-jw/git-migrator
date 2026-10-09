/**
 * T-071: migration Runs against the TST-012 fixture world. The real adapters (through the
 * registry), the real git CLI and the real Run executor talk to the fake Bitbucket, the fake GitHub
 * and the fake git server over loopback; Postgres is a throw-away database (TST-006).
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EndpointConnection, RepositoryRef } from '@git-migrator/adapter-sdk';
import { type Config, resolveConfig } from '@git-migrator/config';
import { hashConfig, syncConfig } from '@git-migrator/db';
import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import {
  resetWorld,
  startWorldFakes,
  WORLD_LIMITS,
  WORLD_MEMBERS,
  WORLD_ROUTE,
  WORLD_WORKSPACE,
} from '@git-migrator/fixtures';
import {
  type AnalysisDeps,
  analyzeForRun,
  createAnalysisGitClient,
  createEndpointConnector,
  createProviderEnvironment,
  createRun,
  createRunAnalysisPort,
  type EndpointConnector,
  type ExecuteResult,
  executeRun,
  MigrationLinks,
  type MigrationServices,
  noGitClient,
  type RunEnqueuerLike,
  RunGuardError,
  RunStepRegistry,
  registerMigrationSteps,
  runAnalysis,
  runInventory,
  withRunScratch,
} from '@git-migrator/jobs';
import { createLogger, createMetrics } from '@git-migrator/observability';
import {
  basicAuthEnv,
  isolatedGitEnv,
  type RunningFakes,
  runGit,
} from '@git-migrator/provider-fakes';
import { QuotaLeases, QuotaService } from '@git-migrator/quota';
import { createBuiltinRegistry } from '@git-migrator/registry';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const PEM = readFileSync(join(here, '../../fixtures/fake-github-app.pem'), 'utf8');
const SOURCE = 'bb-src';
const TARGET = 'gh-dst';
const ROUTE = 'r-auto';
const ORG = 'acme';
const log = createLogger({ level: 'silent' });
const shutdown = new AbortController();

let fakes: RunningFakes;
let t: TestDatabase;
let config: Config;
let services: MigrationServices;
let analysisDeps: AnalysisDeps;
let scratch: string;
let actorId: string;
let work: string;
const delayed: { runId: string; delayMs: number | undefined }[] = [];

const runs: RunEnqueuerLike = {
  async enqueueRun(runId, _routing, options) {
    delayed.push({ runId, delayMs: options?.delayMs });
  },
};

async function migrationOf(key: string) {
  const [, slug] = key.split('/') as [string, string];
  const repo = await t.db.privileged.repository.findFirstOrThrow({
    where: { endpointId: SOURCE, slug },
  });
  return t.db.privileged.migration.findFirstOrThrow({
    where: { routeId: ROUTE, sourceRepositoryId: repo.id },
  });
}

const analyze = (migrationId: string) =>
  runAnalysis(analysisDeps, migrationId, { shutdown: shutdown.signal, pool: 'interactive' });

/** Creates a Run and executes it with the real executor, inside the job scratch directory. */
async function perform(
  migrationId: string,
  kind: 'migrate' | 'run_anyway' | 'resync' = 'migrate',
  extra: { options?: Record<string, unknown>; confirm?: string } = {},
): Promise<{ runId: string; result: ExecuteResult }> {
  const created = await createRun(t.db.privileged, {
    migrationId,
    kind,
    triggeredById: actorId,
    ...extra,
  });
  const registry = new RunStepRegistry<MigrationServices>();
  registerMigrationSteps(registry, services);
  const deps = {
    db: t.db.privileged,
    pool: t.db.pool,
    log,
    registry,
    runs,
    services,
    workerId: 'worker-int',
    analysis: createRunAnalysisPort(analysisDeps, analyzeForRun),
    sleep: async () => undefined,
  };
  const result = await withRunScratch(scratch, created.runId, (scratchDir) =>
    executeRun(deps, created.runId, { shutdown: shutdown.signal, scratchDir }),
  );
  return { runId: created.runId, result };
}

const stepStatuses = async (runId: string): Promise<Record<string, string>> =>
  Object.fromEntries(
    (await t.db.privileged.runStep.findMany({ where: { runId } })).map((s) => [
      s.facetKey ? `${s.stepKey}` : s.stepKey,
      s.status,
    ]),
  );

/** Branches and tags of a bare repository on the fake git server, name to sha. */
async function refsOf(side: 'source' | 'target', repo: string): Promise<Record<string, string>> {
  const out = await runGit(['for-each-ref', '--format=%(objectname) %(refname)'], {
    cwd: fakes.git?.repoDir(side, repo) as string,
    env: isolatedGitEnv(work),
  });
  const entries = out.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line): [string, string] => {
      const [sha, name] = line.split(' ') as [string, string];
      return [name, sha];
    })
    .filter(([name]) => name.startsWith('refs/heads/') || name.startsWith('refs/tags/'));
  return Object.fromEntries(entries);
}

/** The refs a migration carries over: branches and tags, without the framework's own branches. */
const migrated = (refs: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(refs).filter(([name]) => !name.startsWith('refs/heads/git-migrator/')),
  );

/** Number of LFS objects the fake git server holds for a target repository. */
function lfsObjects(repo: string): number {
  const dir = join(fakes.git?.lfsStore('target').dir as string, repo);
  const count = (path: string): number =>
    readdirSync(path, { withFileTypes: true }).reduce(
      (n, e) => n + (e.isDirectory() ? count(join(path, e.name)) : 1),
      0,
    );
  try {
    return count(dir);
  } catch {
    return 0;
  }
}

/** Writes sent to either target since `clear`, apart from minting the App's installation token. */
function targetWrites(): string[] {
  const rest = (fakes.github?.requests() ?? [])
    .filter((r) => r.write)
    .filter((r) => !/^\/app\/installations\/\d+\/access_tokens$/.test(r.path))
    .map((r) => `${r.method} ${r.path}`);
  const git = (fakes.git?.requests() ?? [])
    .filter((r) => r.side === 'target' && r.operation === 'write')
    .map((r) => `git ${r.method} ${r.path}`);
  return [...rest, ...git];
}

beforeAll(async () => {
  t = await createTestDatabase('gm_t071_');
  fakes = await startWorldFakes({ bitbucketPort: 0, githubPort: 0, gitPort: 0 });
  await resetWorld(fakes);
  fakes.git?.setTokens('source', ['fake-bitbucket-api-token']);
  const gh = fakes.github;
  if (!gh) throw new Error('the fake GitHub did not start');
  // The suite migrates many repositories in one hour of the fake's clock; the limits are not what
  // these tests are about (the rate-limit paths have their own tests).
  gh.state.config = {
    ...gh.state.config,
    secondary: { contentCreationPerMinute: null, contentCreationPerHour: null },
    primary: { limits: { core: 10_000_000, graphql: 10_000_000 } },
  };
  scratch = mkdtempSync(join(tmpdir(), 'gm-t071-'));
  work = mkdtempSync(join(tmpdir(), 'gm-t071-work-'));
  const installationId = [...gh.state.installations.keys()][0] as number;
  const gitBase = fakes.git?.baseUrl ?? 'http://127.0.0.1:1';
  config = resolveConfig({
    text: `
environment: test
git:
  maxPushBytes: ${WORLD_LIMITS.maxPushBytes}
endpoints:
  - id: ${SOURCE}
    provider: bitbucket-cloud
    baseUrl: http://127.0.0.1:${fakes.bitbucket.port}
    gitBaseUrl: ${gitBase}/source
    options: { workspace: ${WORLD_WORKSPACE} }
    quota: { overrides: { repository-data: 1000000, raw-files: 1000000, webhooks: 1000000, git: 1000000 } }
  - id: ${TARGET}
    provider: github
    baseUrl: http://127.0.0.1:${gh.port}
    gitBaseUrl: ${gitBase}/target
    options: { org: ${ORG}, appId: ${gh.state.ownApp.id}, installationId: ${installationId} }
    quota: { overrides: { content-minute: 100000, content-hour: 100000, core: 100000 } }
routes:
  - id: ${ROUTE}
    source: ${SOURCE}
    target: ${TARGET}
    targetNamespace: ${ORG}
    policies:
      webhookAllowlistEnabled: true
`,
    env: {},
  });
  await syncConfig(t.db.privileged, {
    endpoints: config.endpoints.map((e) => ({
      id: e.id,
      providerType: e.provider,
      displayName: e.id,
      baseUrl: e.baseUrl,
      configHash: hashConfig(e),
    })),
    routes: config.routes.map((r) => ({
      id: r.id,
      sourceEndpointId: r.source,
      targetEndpointId: r.target,
      targetNamespacePath: r.targetNamespace,
      policies: r.policies,
      defaults: r.defaults,
      sourcePostAction: r.sourcePostAction,
      configHash: hashConfig(r),
    })),
  });
  const quota = new QuotaService({ pool: t.db.pool });
  const environment = createProviderEnvironment({
    quota,
    leases: new QuotaLeases({ pool: t.db.pool }),
    db: t.db.privileged,
    recorders: createMetrics().recorders,
    logger: log,
    environment: 'test',
  });
  const links = new MigrationLinks(config.publicUrl);
  const registry = createBuiltinRegistry({ migrationUrl: links.resolve });
  const real = createEndpointConnector({
    config,
    registry,
    env: {
      BITBUCKET_CREDENTIALS: JSON.stringify([
        {
          id: 'operator',
          accountId: 'acct-operator',
          email: 'operator@test.local',
          apiToken: 'fake-bitbucket-api-token',
        },
      ]),
      GITHUB_APP_PRIVATE_KEY: PEM,
    },
    environment,
    git: noGitClient,
  });
  // The world sets the target's limits on the fake GitHub and the git server (WORLD_LIMITS); the
  // adapter's own are the real provider's, so the connection is told the world's. Source emails
  // are enriched as in the analysis test (AUTH-050 step 1).
  const connector: EndpointConnector = {
    async connect(endpointId, options) {
      const connection = await real.connect(endpointId, options);
      if (endpointId === TARGET) {
        return { ...connection, limits: { ...connection.limits, ...WORLD_LIMITS } };
      }
      const inventory: EndpointConnection['inventory'] = {
        ...connection.inventory,
        async listIdentities(cursor) {
          const page = await connection.inventory.listIdentities(cursor);
          return {
            ...page,
            items: page.items.map((i) => {
              const member = WORLD_MEMBERS.find((m) => m.accountId === i.providerId);
              return member?.email
                ? { ...i, email: member.email, emailSource: 'atlassian-admin' }
                : i;
            }),
          };
        },
      };
      return { ...connection, inventory };
    },
  };
  for (const pattern of WORLD_ROUTE.webhookAllowlist) {
    await t.db.privileged.webhookAllowlistEntry.create({ data: { routeId: ROUTE, pattern } });
  }
  analysisDeps = {
    db: t.db.privileged,
    appPool: t.db.pool,
    connector,
    registry,
    config,
    git: createAnalysisGitClient({ scratchDir: scratch }),
    log,
  };
  services = {
    db: t.db.privileged,
    connector,
    registry,
    config,
    quota,
    scratchRoot: scratch,
    links,
    logger: log,
    reanalyze: async (migrationId, signal) => {
      await runAnalysis(analysisDeps, migrationId, { shutdown: signal, pool: 'interactive' });
    },
  };
  actorId = (
    await t.db.privileged.actor.create({
      data: { kind: 'service', role: 'operator', displayName: 'int', email: 'int@test.local' },
    })
  ).id;
  const inventory = (endpointId: string) =>
    runInventory(
      { db: t.db.privileged, appPool: t.db.pool, connector, registry, config, log },
      endpointId,
      { shutdown: shutdown.signal },
    );
  await inventory(SOURCE);
  await inventory(TARGET);
}, 180_000);

afterAll(async () => {
  await fakes?.close();
  await t?.drop();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  if (work) rmSync(work, { recursive: true, force: true });
}, 60_000);

describe('plat/auto-ok migrates against the fakes', () => {
  it('[LIF-040] steps 1 to 12 create the target, push every ref and LFS object, and apply the Facets', async () => {
    const m = await migrationOf('plat/auto-ok');
    await analyze(m.id);
    const { runId, result } = await perform(m.id);
    expect(result).toEqual({ outcome: 'finished', status: 'succeeded' });

    const statuses = await stepStatuses(runId);
    expect(statuses).toMatchObject({
      preflight: 'succeeded',
      'git.prepare': 'succeeded',
      'target.ensure-repository': 'succeeded',
      'git.push-lfs': 'succeeded',
      'git.push-refs': 'succeeded',
    });
    expect(Object.values(statuses).every((s) => s === 'succeeded' || s === 'skipped')).toBe(true);

    const migration = await t.db.privileged.migration.findUniqueOrThrow({ where: { id: m.id } });
    expect(migration.status).toBe('migrated');
    expect(migration.targetCreatedByFramework).toBe(true);
    expect(migration.targetRepositoryId).toBeTruthy();
    const target = await t.db.privileged.repository.findUniqueOrThrow({
      where: { id: migration.targetRepositoryId as string },
    });
    expect(target.fullPath).toBe(`${ORG}/plat-auto-ok`);
    expect(target.defaultBranch).toBe('main');

    // Every source branch and tag arrived with the same commit.
    const source = await refsOf('source', `${WORLD_WORKSPACE}/auto-ok`);
    const pushed = await refsOf('target', `${ORG}/plat-auto-ok`);
    expect(migrated(pushed)).toEqual(migrated(source));
    expect(Object.keys(migrated(pushed))).toEqual(
      expect.arrayContaining(['refs/heads/main', 'refs/heads/develop', 'refs/tags/v1.0.0']),
    );
    const repoState = fakes.github?.state.snapshot() as unknown as {
      repositories: {
        fullName: string;
        deployKeys: { title: string }[];
        environments: { name: string }[];
        variables: { name: string; value: string }[];
        branchProtectionRules: {
          pattern: string;
          allowsForcePushes: boolean;
          allowsDeletions: boolean;
        }[];
      }[];
    };
    const applied = repoState.repositories.find((r) => r.fullName === `${ORG}/plat-auto-ok`);
    expect(applied?.deployKeys.map((k) => k.title)).toEqual(['e2e-key']);
    expect(applied?.environments.map((e) => e.name)).toEqual(['production']);
    expect(applied?.variables.map((v) => v.name).sort()).toEqual(['E2E_VAR', 'RELEASE_CHANNEL']);
    expect(applied?.branchProtectionRules).toMatchObject([
      { pattern: 'main', allowsForcePushes: false, allowsDeletions: false },
    ]);
    // The LFS object reached the target's LFS store.
    expect(lfsObjects(`${ORG}/plat-auto-ok`)).toBeGreaterThan(0);
    // Every write is in the ledger; the repository is a `create` of the framework's.
    const ledger = await t.db.privileged.mutation.findMany({
      where: { runId },
      orderBy: { seq: 'asc' },
    });
    expect(ledger.length).toBeGreaterThan(3);
    expect(ledger[0]).toMatchObject({ side: 'target', action: 'create', state: 'recorded' });
    expect(ledger.every((l) => l.state === 'recorded')).toBe(true);

    // The Migration was analyzed again at the end of the Run, so its target now counts as owned.
    const after = await t.db.privileged.migration.findUniqueOrThrow({ where: { id: m.id } });
    expect(after.latestAnalysisId).not.toBe(migration.latestAnalysisId === null ? '' : undefined);
    const latest = await t.db.privileged.analysis.findUniqueOrThrow({
      where: { id: after.latestAnalysisId as string },
    });
    expect(latest.createdAt.getTime()).toBeGreaterThanOrEqual(
      (
        await t.db.privileged.run.findUniqueOrThrow({ where: { id: runId } })
      ).startedAt?.getTime() ?? 0,
    );
  }, 240_000);
});

describe('a second Run on the same Migration', () => {
  it('[LIF-043] resync is identical to migrate and finds nothing left to do on the target', async () => {
    const m = await migrationOf('plat/auto-ok');
    const before = await t.db.privileged.migration.findUniqueOrThrow({ where: { id: m.id } });
    expect(before.readiness).not.toBe('blocked');
    fakes.github?.clearRequests();
    fakes.git?.clearRequests();
    const { runId, result } = await perform(m.id, 'resync');
    expect(result).toEqual({ outcome: 'finished', status: 'succeeded' });
    const ledger = await t.db.privileged.mutation.findMany({ where: { runId } });
    const real = ledger.filter((l) => {
      const ref = l.resourceRef as { noop?: boolean; adopted?: boolean };
      return ref.noop !== true && ref.adopted !== true;
    });
    // Nothing differs, so nothing is written to the target.
    expect(real.map((l) => `${l.facetKey} ${l.action}`)).toEqual([]);
    expect(targetWrites()).toEqual([]);
    const after = await t.db.privileged.migration.findUniqueOrThrow({ where: { id: m.id } });
    expect(after.targetRepositoryId).toBe(before.targetRepositoryId);
  }, 240_000);
});

describe('batched push and blob blockers', () => {
  it('[LIF-044] ops/large-history is pushed in several batches under the target push limit', async () => {
    const m = await migrationOf('ops/large-history');
    await analyze(m.id);
    fakes.git?.clearRequests();
    const { runId, result } = await perform(m.id);
    expect(result).toEqual({ outcome: 'finished', status: 'succeeded' });
    // About 4 MiB of history against a 1 MiB limit on the target: one push cannot carry it.
    const pushes = (fakes.git?.requests() ?? []).filter(
      (r) =>
        r.side === 'target' &&
        r.method === 'POST' &&
        r.path === `/target/${ORG}/ops-large-history.git/git-receive-pack`,
    );
    expect(pushes.length).toBeGreaterThanOrEqual(4);
    const source = await refsOf('source', `${WORLD_WORKSPACE}/large-history`);
    const pushed = await refsOf('target', `${ORG}/ops-large-history`);
    expect(migrated(pushed)).toEqual(migrated(source));
    const logs = await t.db.privileged.runLog.findMany({ where: { runId } });
    expect(
      logs.filter((l) => l.message.includes('(default-branch)')).length,
    ).toBeGreaterThanOrEqual(4);
  }, 300_000);

  it('[FAC-GIT-004] ops/big-blob is blocked at git.prepare, with no write to the target', async () => {
    const m = await migrationOf('ops/big-blob');
    await analyze(m.id);
    fakes.github?.clearRequests();
    fakes.git?.clearRequests();
    const { runId, result } = await perform(m.id);
    expect(result).toEqual({ outcome: 'finished', status: 'failed' });
    const statuses = await stepStatuses(runId);
    expect(statuses.preflight).toBe('succeeded');
    expect(statuses['git.prepare']).toBe('failed');
    expect(statuses['target.ensure-repository']).toBe('skipped');
    expect(statuses['git.push-refs']).toBe('skipped');

    // LIF-049: a run-origin blocker; the Migration is blocked until a later Run passes git.prepare.
    const migration = await t.db.privileged.migration.findUniqueOrThrow({ where: { id: m.id } });
    expect(migration.status).toBe('failed');
    expect(migration.readiness).toBe('blocked');
    expect(migration.blockerCodes).toContain('git-refs.blob-too-large');
    expect((migration.runBlockers as { code: string }[]).map((b) => b.code)).toContain(
      'git-refs.blob-too-large',
    );
    // TST-006 and the acceptance: nothing was written to the target, and no repository exists.
    expect(targetWrites()).toEqual([]);
    expect(fakes.github?.state.findRepo(ORG, 'ops-big-blob')).toBeUndefined();
    expect(migration.targetRepositoryId).toBeNull();
    expect(await t.db.privileged.mutation.count({ where: { runId } })).toBe(0);
    await expect(
      createRun(t.db.privileged, { migrationId: m.id, kind: 'migrate', triggeredById: actorId }),
    ).rejects.toMatchObject({ code: 'run.readiness_required' });
  }, 240_000);
});

describe('adoption of an existing target (LIF-031, LIF-043)', () => {
  async function createTarget(name: string): Promise<RepositoryRef> {
    const connection = await services.connector.connect(TARGET, {
      pool: 'interactive',
      signal: shutdown.signal,
    });
    const namespace = (await connection.inventory.listNamespaces()).items[0];
    if (!namespace) throw new Error('no target namespace');
    const ns = { providerId: namespace.providerId, slug: namespace.slug };
    const created = await connection.repositories.create(ns, {
      name,
      visibility: 'private',
      description: 'existing',
    });
    return { providerId: created.providerId, namespace: ns, slug: created.slug };
  }

  /** Pushes a diverged history with a stray branch and tag, as a human would have left it. */
  async function fillTarget(name: string): Promise<void> {
    const token = fakes.github?.token() as string;
    const dir = mkdtempSync(join(work, 'seed-'));
    const env = isolatedGitEnv(work, basicAuthEnv('x-access-token', token));
    await runGit(['init', '-q', '-b', 'main', dir], { env });
    await runGit(['commit', '-q', '--allow-empty', '-m', 'existing'], { cwd: dir, env });
    await runGit(['branch', 'stray'], { cwd: dir, env });
    await runGit(['tag', 'old'], { cwd: dir, env });
    await runGit(
      ['push', '-q', `${fakes.git?.repoUrl('target', `${ORG}/${name}`)}`, 'main', 'stray', 'old'],
      { cwd: dir, env },
    );
    // The fake GitHub keeps its REST data apart from the git server, so the REST side learns of
    // the content too (the real provider is one store).
    const state = fakes.github?.state;
    const repo = state?.findRepo(ORG, name);
    if (state && repo) state.addBranch(repo, 'main', { 'README.md': 'existing' });
  }

  it('[LIF-031] an existing empty target is adopted automatically and recorded as adopted', async () => {
    const ref = await createTarget('plat-with-secrets');
    const m = await migrationOf('plat/with-secrets');
    await analyze(m.id);
    const analysis = await t.db.privileged.migration.findUniqueOrThrow({ where: { id: m.id } });
    expect(analysis.readiness).not.toBe('blocked');
    const { runId, result } = await perform(m.id);
    expect(result).toEqual({ outcome: 'finished', status: 'succeeded' });
    const migration = await t.db.privileged.migration.findUniqueOrThrow({ where: { id: m.id } });
    expect(migration.targetCreatedByFramework).toBe(false);
    const target = await t.db.privileged.repository.findUniqueOrThrow({
      where: { id: migration.targetRepositoryId as string },
    });
    expect(target.providerId).toBe(ref.providerId);
    const adopted = await t.db.privileged.mutation.findMany({
      where: { runId, action: 'create', facetKey: 'framework' },
    });
    expect(adopted).toHaveLength(1);
    expect(adopted[0]?.resourceRef).toMatchObject({ kind: 'repository', adopted: true });
    expect(adopted[0]?.before).toEqual(adopted[0]?.after);
    const source = await refsOf('source', `${WORLD_WORKSPACE}/with-secrets`);
    expect(migrated(await refsOf('target', `${ORG}/plat-with-secrets`))).toEqual(migrated(source));
  }, 300_000);

  it('[LIF-043] a non-empty target blocks, and adoptNonEmpty with the typed name force-adopts it as a reconcile', async () => {
    await createTarget('ops-wiki-issues');
    await fillTarget('ops-wiki-issues');
    const m = await migrationOf('ops/wiki-issues');
    await analyze(m.id);
    const blocked = await t.db.privileged.migration.findUniqueOrThrow({ where: { id: m.id } });
    expect(blocked.readiness).toBe('blocked');
    expect(blocked.blockerCodes).toContain('target.exists-nonempty');
    const base = { migrationId: m.id, kind: 'migrate' as const, triggeredById: actorId };
    await expect(createRun(t.db.privileged, base)).rejects.toMatchObject({
      code: 'run.readiness_required',
    });
    await expect(
      createRun(t.db.privileged, { ...base, options: { adoptNonEmpty: true } }),
    ).rejects.toMatchObject({ code: 'run.confirmation_required' });
    await expect(
      createRun(t.db.privileged, {
        ...base,
        options: { adoptNonEmpty: true },
        confirm: 'acme/ops-wiki',
      }),
    ).rejects.toBeInstanceOf(RunGuardError);

    const { runId, result } = await perform(m.id, 'migrate', {
      options: { adoptNonEmpty: true },
      confirm: `${ORG}/ops-wiki-issues`,
    });
    expect(result).toEqual({ outcome: 'finished', status: 'succeeded' });
    const source = await refsOf('source', `${WORLD_WORKSPACE}/wiki-issues`);
    const pushed = await refsOf('target', `${ORG}/ops-wiki-issues`);
    // The reconcile forced the diverged main and removed the stray branch and tag.
    expect(migrated(pushed)).toEqual(migrated(source));
    expect(Object.keys(pushed)).not.toContain('refs/heads/stray');
    expect(Object.keys(pushed)).not.toContain('refs/tags/old');
    const migration = await t.db.privileged.migration.findUniqueOrThrow({ where: { id: m.id } });
    expect(migration.targetCreatedByFramework).toBe(false);
    const adopted = await t.db.privileged.mutation.findMany({
      where: { runId, action: 'create', facetKey: 'framework' },
    });
    expect(adopted[0]?.resourceRef).toMatchObject({ adopted: true, forced: true });
  }, 300_000);
});

describe('findings of a Run and the guards around it', () => {
  it('[LIF-041] preflight re-reads the source: a Change Request opened after the Analysis aborts the Run before any write', async () => {
    const m = await migrationOf('ops/hooks');
    await analyze(m.id);
    expect(
      (await t.db.privileged.migration.findUniqueOrThrow({ where: { id: m.id } })).readiness,
    ).not.toBe('blocked');
    fakes.bitbucket.state.addPullRequest(WORLD_WORKSPACE, 'hooks', {
      title: 'late',
      authorAccountId: 'acct-alice',
    });
    fakes.github?.clearRequests();
    fakes.git?.clearRequests();
    const { runId, result } = await perform(m.id);
    expect(result).toEqual({ outcome: 'finished', status: 'failed' });
    const step = await t.db.privileged.runStep.findFirstOrThrow({
      where: { runId, stepKey: 'preflight' },
    });
    expect(step.status).toBe('failed');
    expect(step.error).toMatchObject({ code: 'preflight.blocked' });
    expect(JSON.stringify(step.error)).toContain('change-requests.open');
    expect(targetWrites()).toEqual([]);
    // The Analysis is due at once, so the next one shows the blocker (LIF-004).
    const migration = await t.db.privileged.migration.findUniqueOrThrow({ where: { id: m.id } });
    expect(migration.analysisStaleAt && migration.analysisStaleAt <= new Date()).toBe(true);
  }, 240_000);

  it('[LIF-049] a deploy key the target refuses becomes a run-origin post task, and the Run still succeeds', async () => {
    const first = await migrationOf('keys/shared-key-1');
    const second = await migrationOf('keys/shared-key-2');
    await analyze(first.id);
    await analyze(second.id);
    expect((await perform(first.id)).result).toMatchObject({ status: 'succeeded' });
    // The analysis already predicted the task (FAC-DKY-003); drop it so the Run must raise it.
    await t.db.privileged.manualTask.deleteMany({
      where: { migrationId: second.id, code: 'deploy-keys.key-in-use' },
    });
    const { result } = await perform(second.id);
    expect(result).toEqual({ outcome: 'finished', status: 'succeeded' });
    const tasks = await t.db.privileged.manualTask.findMany({
      where: { migrationId: second.id, code: 'deploy-keys.key-in-use' },
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ origin: 'run', phase: 'post', facetKey: 'deploy-keys' });
  }, 300_000);

  it('[LIF-043] run_anyway applies a repository that needs attention, and its pre task stays open', async () => {
    const m = await migrationOf('data/unmapped-user');
    await analyze(m.id);
    await expect(
      createRun(t.db.privileged, { migrationId: m.id, kind: 'migrate', triggeredById: actorId }),
    ).rejects.toMatchObject({ code: 'run.readiness_required' });
    const { result } = await perform(m.id, 'run_anyway');
    expect(result).toEqual({ outcome: 'finished', status: 'succeeded' });
    const open = await t.db.privileged.manualTask.findMany({
      where: { migrationId: m.id, status: 'open', phase: 'pre' },
    });
    expect(open.map((x) => x.code)).toContain('access-control.unmapped-principal');
  }, 240_000);
});
