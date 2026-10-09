/**
 * T-071: migration Runs against the TST-012 fixture world. The real adapters (through the
 * registry), the real git CLI and the real Run executor talk to the fake Bitbucket, the fake GitHub
 * and the fake git server over loopback; Postgres is a throw-away database (TST-006).
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AdapterError,
  type EndpointConnection,
  type RepositoryRef,
} from '@git-migrator/adapter-sdk';
import { type Config, resolveConfig } from '@git-migrator/config';
import { mutationsToUndo } from '@git-migrator/core';
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
  MirrorRegistry,
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
  createBareRepo,
  isolatedGitEnv,
  type RunningFakes,
  runGit,
  seedBareRepo,
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

/** Faults the target connection can be told to inject once (resume and settle tests). */
const faults: {
  /** The repository is created, then the call fails with this error. */
  createThenFail?: 'retryable' | 'fatal';
  /** After the repository is created, the job is asked to shut down (a hand-off follows). */
  createThenShutdown?: AbortController;
  /** The Facet driver writes, then fails before the records are returned. */
  loseRecordsOf?: string;
} = {};

let freeBytes: (() => Promise<number>) | undefined;

function deps() {
  const registry = new RunStepRegistry<MigrationServices>();
  registerMigrationSteps(registry, services);
  return {
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
}

/** One job of an existing Run, inside its own scratch directory. */
function execute(runId: string, signal: AbortSignal = shutdown.signal): Promise<ExecuteResult> {
  return withRunScratch(scratch, runId, (scratchDir) =>
    executeRun(deps(), runId, { shutdown: signal, scratchDir }),
  );
}

async function start(
  migrationId: string,
  kind: 'migrate' | 'run_anyway' | 'resync' = 'migrate',
  extra: { options?: Record<string, unknown>; confirm?: string } = {},
): Promise<string> {
  const created = await createRun(t.db.privileged, {
    migrationId,
    kind,
    triggeredById: actorId,
    ...extra,
  });
  return created.runId;
}

/** Creates a Run and executes it with the real executor, inside the job scratch directory. */
async function perform(
  migrationId: string,
  kind: 'migrate' | 'run_anyway' | 'resync' = 'migrate',
  extra: { options?: Record<string, unknown>; confirm?: string } = {},
): Promise<{ runId: string; result: ExecuteResult }> {
  const runId = await start(migrationId, kind, extra);
  return { runId, result: await execute(runId) };
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
        return {
          ...connection,
          limits: { ...connection.limits, ...WORLD_LIMITS },
          repositories: {
            ...connection.repositories,
            async create(ns, spec) {
              const created = await connection.repositories.create(ns, spec);
              const fault = faults.createThenFail;
              if (fault) {
                faults.createThenFail = undefined;
                throw new AdapterError({
                  code: fault === 'retryable' ? 'transient' : 'invalid',
                  provider: 'github',
                  message: 'the response was lost',
                  retryable: fault === 'retryable',
                });
              }
              const stop = faults.createThenShutdown;
              if (stop) {
                faults.createThenShutdown = undefined;
                stop.abort();
              }
              return created;
            },
          },
          facets: Object.fromEntries(
            Object.entries(connection.facets).map(([key, driver]) => [
              key,
              driver?.apply
                ? {
                    ...driver,
                    async *apply(...args: Parameters<NonNullable<typeof driver.apply>>) {
                      if (faults.loseRecordsOf !== key) {
                        yield* driver.apply?.(...args) ?? [];
                        return;
                      }
                      faults.loseRecordsOf = undefined;
                      // The write happens; the process dies before its record is returned.
                      for await (const _record of driver.apply?.(...args) ?? []) {
                        // dropped
                      }
                      throw new AdapterError({
                        code: 'transient',
                        provider: 'github',
                        message: 'the connection dropped',
                        retryable: true,
                      });
                    },
                  }
                : driver,
            ]),
          ),
          changeRequests: connection.changeRequests && {
            ...connection.changeRequests,
            // The real provider is one store: a pushed branch is visible to the REST API at once.
            // The fake keeps them apart, so the REST side is told of the pushed default branch.
            async upsert(ref, req) {
              const state = fakes.github?.state;
              const repo = state?.findRepo(ORG, ref.slug);
              const branch = repo?.defaultBranch ?? 'main';
              if (state && repo && !repo.git.refs.has(`refs/heads/${branch}`)) {
                state.addBranch(repo, branch, { 'README.md': 'pushed' });
              }
              return connection.changeRequests?.upsert(ref, req) as never;
            },
          },
        };
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
    freeBytes: () => (freeBytes ? freeBytes() : Promise.resolve(Number.MAX_SAFE_INTEGER)),
    links,
    mirrors: new MirrorRegistry(),
    pool: t.db.pool,
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
    const analyzedBefore = (
      await t.db.privileged.migration.findUniqueOrThrow({ where: { id: m.id } })
    ).latestAnalysisId;
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
    // The end-of-Run Analysis replaced the one the Run started from.
    expect(analyzedBefore).toBeTruthy();
    expect(after.latestAnalysisId).not.toBe(analyzedBefore);
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

describe('adoption of an existing target (LIF-031, LIF-043)', () => {
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

describe('Change Requests (LIF-047)', () => {
  it('[LIF-047] pipelines reach the target as a Change Request from git-migrator/ci, and the branch is a framework Expected Difference', async () => {
    const m = await migrationOf('data/pipelines-simple');
    await analyze(m.id);
    const { runId, result } = await perform(m.id);
    const failed = await t.db.privileged.runStep.findMany({ where: { runId, status: 'failed' } });
    expect(failed.map((f) => `${f.stepKey} ${JSON.stringify(f.error)}`)).toEqual([]);
    expect(result).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect((await stepStatuses(runId))['change-requests.open']).toBe('succeeded');
    const state = fakes.github?.state;
    const repo = state?.findRepo(ORG, 'data-pipelines-simple');
    expect(repo?.pulls).toHaveLength(1);
    expect(repo?.git.refs.has('refs/heads/git-migrator/ci')).toBe(true);
    const framework = await t.db.privileged.expectedDifference.findMany({
      where: { migrationId: m.id, reason: 'framework_mutation' },
    });
    expect(framework.map((e) => `${e.facetKey} ${e.path}`)).toContain(
      'git-refs /refs[name=refs/heads/git-migrator/ci]',
    );
    const ledger = await t.db.privileged.mutation.findMany({
      where: { runId, facetKey: 'change-requests' },
    });
    expect(ledger.length).toBeGreaterThan(0);
  }, 300_000);
});

// -- round 2 ----------------------------------------------------------------------------------------

let extraCount = 0;

/** A fresh, Ready source repository (two commits, optional variable), inventoried and analyzed. */
async function addSourceRepo(options: { variable?: string } = {}) {
  const slug = `extra-${++extraCount}`;
  const git = fakes.git;
  if (!git) throw new Error('no git server');
  const bare = git.repoDir('source', `${WORLD_WORKSPACE}/${slug}`);
  await createBareRepo(bare);
  const seeded = await seedBareRepo(
    bare,
    { commits: 2, branches: [{ name: 'develop' }] },
    { store: git.lfsStore('source'), repo: `${WORLD_WORKSPACE}/${slug}` },
  );
  const state = fakes.bitbucket.state;
  state.addRepository(WORLD_WORKSPACE, {
    slug,
    projectKey: 'PLAT',
    description: slug,
    gitRoot: bare,
    branches: ['main', 'develop'].map((name) =>
      state.makeBranch(WORLD_WORKSPACE, slug, name, {
        mergeStrategies: ['merge_commit', 'squash'],
        defaultMergeStrategy: 'merge_commit',
        ...(seeded.heads[name] ? { hash: seeded.heads[name] } : {}),
      }),
    ),
  });
  if (options.variable) {
    state.addVariable(WORLD_WORKSPACE, slug, { key: options.variable, value: 'x' });
  }
  await runInventory(
    {
      db: t.db.privileged,
      appPool: t.db.pool,
      connector: services.connector,
      registry: services.registry as never,
      config,
      log,
    },
    SOURCE,
    { shutdown: shutdown.signal },
  );
  const repo = await t.db.privileged.repository.findFirstOrThrow({
    where: { endpointId: SOURCE, slug },
  });
  const m = await t.db.privileged.migration.findFirstOrThrow({
    where: { routeId: ROUTE, sourceRepositoryId: repo.id },
  });
  await analyze(m.id);
  expect(
    (await t.db.privileged.migration.findUniqueOrThrow({ where: { id: m.id } })).readiness,
  ).toBe('ready');
  return { slug, target: `plat-${slug}`, migration: m, bare };
}

async function commitOnSource(bare: string, branch: string): Promise<void> {
  const dir = mkdtempSync(join(work, 'src-'));
  const env = isolatedGitEnv(work);
  await runGit(['clone', '-q', bare, dir], { env });
  await runGit(['checkout', '-q', branch], { cwd: dir, env });
  await runGit(['commit', '-q', '--allow-empty', '-m', 'later'], { cwd: dir, env });
  await runGit(['push', '-q', 'origin', branch], { cwd: dir, env });
}

async function protect(slug: string, pattern: string): Promise<void> {
  const connection = await services.connector.connect(TARGET, {
    pool: 'interactive',
    signal: shutdown.signal,
  });
  const state = fakes.github?.state;
  const repo = state?.findRepo(ORG, slug);
  if (!state || !repo) throw new Error(`no target ${slug}`);
  const namespace = { providerId: String(state.requireOrg(ORG).id), slug: ORG };
  const ref = { providerId: String(repo.id), namespace, slug };
  const ctx = {
    http: connection.http,
    git: noGitClient,
    logger: log as never,
    pool: 'interactive' as const,
    signal: shutdown.signal,
  };
  const driver = connection.facets['branch-rules'];
  const target = { scope: 'repository' as const, repository: ref, namespace };
  const current = (await driver?.read(ctx, target))?.data as { rules: unknown[] };
  const rule = {
    pattern,
    enforcement: 'enforced',
    restrictPushes: [],
    restrictMerges: null,
    blockForcePush: false,
    forcePushExempt: [],
    blockDeletion: false,
    deletionExempt: [],
    changeRequest: null,
  };
  for await (const _ of driver?.apply?.(
    ctx,
    target,
    { rules: [...current.rules, rule] },
    current,
    [],
  ) ?? []) {
    // consumed
  }
}

describe('step 3a lifts only the protection that is in the way (LIF-040)', () => {
  it('[LIF-040] a rule on a branch that will change is lifted before the push and recorded; a rule on an unchanged branch stays', async () => {
    const repo = await addSourceRepo();
    expect((await perform(repo.migration.id)).result).toMatchObject({ status: 'succeeded' });
    // The target protects develop (nobody may push) and main; only develop is about to change.
    await protect(repo.target, 'develop');
    await protect(repo.target, 'main');
    await commitOnSource(repo.bare, 'develop');
    await analyze(repo.migration.id);
    const { runId, result } = await perform(repo.migration.id, 'resync');
    // Without the lift the provider would have refused the push to develop.
    expect(result).toEqual({ outcome: 'finished', status: 'succeeded' });
    const source = await refsOf('source', `${WORLD_WORKSPACE}/${repo.slug}`);
    expect(migrated(await refsOf('target', `${ORG}/${repo.target}`))).toEqual(migrated(source));

    const ledger = await t.db.privileged.mutation.findMany({
      where: { runId },
      orderBy: { seq: 'asc' },
    });
    const liftStep = await t.db.privileged.runStep.findFirstOrThrow({
      where: { runId, stepKey: 'target.lift-protection' },
    });
    const deletes = ledger.filter(
      (l) =>
        l.facetKey === 'branch-rules' && l.action === 'delete' && l.writtenByStep === liftStep.id,
    );
    const real = deletes.filter((l) => (l.resourceRef as { noop?: boolean }).noop !== true);
    // Only develop was in the way; main is on a branch that does not change.
    expect(real.flatMap((l) => l.paths)).toEqual(['/rules[pattern=develop]']);
    const lift = deletes.find(
      (l) => (l.resourceRef as { kind?: string }).kind === 'lift-protection',
    );
    const push = ledger.find((l) => (l.resourceRef as { kind?: string }).kind === 'git-push');
    expect(lift && push && lift.seq < push.seq).toBe(true);
    const logs = await t.db.privileged.runLog.findMany({ where: { runId } });
    expect(logs.find((l) => l.message.startsWith('Lifted'))?.data).toEqual({
      patterns: ['develop'],
    });
    // Step 10 then makes the rules equal to the desired ones; the source has none here.
  }, 300_000);
});

describe('Overlays (LIF-048)', () => {
  it('[LIF-048] an Overlay wins over the translated value, leaves one overlay Expected Difference, and revocation sticks', async () => {
    const m = await migrationOf('data/pipelines-pipes');
    const overlay = await t.db.privileged.overlay.create({
      data: {
        routeId: ROUTE,
        facetKey: 'repository-settings',
        data: { description: 'from overlay' },
      },
    });
    await analyze(m.id);
    const { runId, result } = await perform(m.id);
    expect(result).toMatchObject({ status: 'succeeded' });
    expect((await stepStatuses(runId))['overlays.apply']).toBe('succeeded');
    expect(fakes.github?.state.findRepo(ORG, 'data-pipelines-pipes')?.description).toBe(
      'from overlay',
    );

    const rows = () =>
      t.db.privileged.expectedDifference.findMany({
        where: { migrationId: m.id, reason: 'overlay' },
      });
    expect((await rows()).map((r) => `${r.facetKey} ${r.path}`)).toEqual([
      'repository-settings /description',
    ]);
    await analyze(m.id);
    expect((await perform(m.id, 'resync')).result).toMatchObject({ status: 'succeeded' });
    expect(await rows()).toHaveLength(1);
    await t.db.privileged.expectedDifference.updateMany({
      where: { migrationId: m.id, reason: 'overlay' },
      data: { revokedAt: new Date() },
    });
    await analyze(m.id);
    expect((await perform(m.id, 'resync')).result).toMatchObject({ status: 'succeeded' });
    const after = await rows();
    expect(after).toHaveLength(1);
    expect(after[0]?.revokedAt).not.toBeNull();

    // An Overlay that gives an invalid document fails the Step with its own code; the rest of the
    // Run is unaffected (steps 6 to 12 are independent).
    const bad = await t.db.privileged.overlay.create({
      data: { routeId: ROUTE, facetKey: 'repository-settings', data: { visibility: 'bogus' } },
    });
    await analyze(m.id);
    const failed = await perform(m.id, 'resync');
    expect(failed.result).toEqual({ outcome: 'finished', status: 'partial' });
    const step = await t.db.privileged.runStep.findFirstOrThrow({
      where: { runId: failed.runId, stepKey: 'overlays.apply' },
    });
    expect(step.error).toMatchObject({ code: 'overlay.invalid' });

    // An Overlay for a Facet that is not written for a repository is skipped, not applied.
    await t.db.privileged.overlay.deleteMany({ where: { id: { in: [overlay.id, bad.id] } } });
    await t.db.privileged.overlay.create({
      data: { routeId: ROUTE, facetKey: 'teams', data: { teams: [] } },
    });
    await analyze(m.id);
    const skipped = await perform(m.id, 'resync');
    expect(skipped.result).toMatchObject({ status: 'succeeded' });
    expect((await stepStatuses(skipped.runId))['overlays.apply']).toBe('skipped');
    await t.db.privileged.overlay.deleteMany({ where: { routeId: ROUTE } });
  }, 400_000);
});

describe('intent and settle on resume (LIF-045)', () => {
  it('[LIF-045] a create whose response was lost is found again on retry and counts as created by the framework', async () => {
    const repo = await addSourceRepo();
    faults.createThenFail = 'retryable';
    const { runId, result } = await perform(repo.migration.id);
    expect(result).toEqual({ outcome: 'finished', status: 'succeeded' });
    const migration = await t.db.privileged.migration.findUniqueOrThrow({
      where: { id: repo.migration.id },
    });
    expect(migration.targetCreatedByFramework).toBe(true);
    expect(migration.runBlockers).toEqual([]);
    const creates = await t.db.privileged.mutation.findMany({
      where: { runId, action: 'create', facetKey: 'framework' },
    });
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({ state: 'recorded' });
    expect(creates[0]?.resourceRef).not.toHaveProperty('adopted');
  }, 300_000);

  it("[LIF-045] a create intent left open by a failed Run makes the repository the framework's own in the next Run", async () => {
    const repo = await addSourceRepo();
    faults.createThenFail = 'fatal';
    const first = await perform(repo.migration.id);
    expect(first.result).toEqual({ outcome: 'finished', status: 'failed' });
    const open = await t.db.privileged.mutation.findMany({
      where: { runId: first.runId, state: 'intended' },
    });
    expect(open).toHaveLength(1);
    const { runId, result } = await perform(repo.migration.id);
    expect(result).toEqual({ outcome: 'finished', status: 'succeeded' });
    const migration = await t.db.privileged.migration.findUniqueOrThrow({
      where: { id: repo.migration.id },
    });
    expect(migration.targetCreatedByFramework).toBe(true);
    expect(
      await t.db.privileged.mutation.count({
        where: { runId, facetKey: 'framework', action: 'create' },
      }),
    ).toBe(0);
  }, 300_000);

  it('[LIF-045] a Facet write whose record was lost is ledgered as an undoable record when the Step resumes', async () => {
    const repo = await addSourceRepo({ variable: 'LOST_VAR' });
    faults.loseRecordsOf = 'variables';
    const { runId, result } = await perform(repo.migration.id);
    expect(result).toEqual({ outcome: 'finished', status: 'succeeded' });
    const ledger = await t.db.privileged.mutation.findMany({
      where: { runId, facetKey: 'variables' },
      orderBy: { seq: 'asc' },
    });
    const recovered = ledger.filter(
      (l) => (l.resourceRef as { kind?: string }).kind === 'recovered-write',
    );
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.paths.join(',')).toContain('LOST_VAR');
    const undoable = mutationsToUndo(
      ledger.map((l) => ({ ...l, resourceRef: l.resourceRef as Record<string, unknown> })),
    );
    expect(undoable.map((l) => l.id)).toContain(recovered[0]?.id);
    expect(ledger.every((l) => l.state === 'recorded' || l.state === 'not_applied')).toBe(true);
  }, 300_000);

  it('[LIF-049] a blocker raised by the repository Step is cleared when a later Run passes it', async () => {
    const repo = await addSourceRepo();
    // The target appears, non-empty, after the Analysis: the Step blocks.
    const ref = await createTarget(repo.target);
    void ref;
    await fillTarget(repo.target);
    const first = await perform(repo.migration.id);
    expect(first.result).toEqual({ outcome: 'finished', status: 'failed' });
    const blocked = await t.db.privileged.migration.findUniqueOrThrow({
      where: { id: repo.migration.id },
    });
    expect(blocked.blockerCodes).toContain('target.exists-nonempty');
    const { result } = await perform(repo.migration.id, 'migrate', {
      options: { adoptNonEmpty: true },
      confirm: `${ORG}/${repo.target}`,
    });
    expect(result).toEqual({ outcome: 'finished', status: 'succeeded' });
    const cleared = await t.db.privileged.migration.findUniqueOrThrow({
      where: { id: repo.migration.id },
    });
    expect(cleared.runBlockers).toEqual([]);
    expect(cleared.blockerCodes).not.toContain('target.exists-nonempty');
  }, 300_000);
});

describe('jobs, scratch and the mirror (JOB-015)', () => {
  it('[JOB-015] git.prepare waits for scratch space, six times, then fails with scratch.insufficient', async () => {
    const repo = await addSourceRepo();
    freeBytes = async () => -1;
    try {
      const runId = await start(repo.migration.id);
      for (let delay = 1; delay <= 6; delay++) {
        const result = await execute(runId);
        expect(result).toMatchObject({ outcome: 'delayed', delayMs: 10 * 60 * 1000 });
      }
      expect(await execute(runId)).toEqual({ outcome: 'finished', status: 'failed' });
      const step = await t.db.privileged.runStep.findFirstOrThrow({
        where: { runId, stepKey: 'git.prepare' },
      });
      expect(step.delays).toBe(6);
      expect(step.error).toMatchObject({ code: 'scratch.insufficient' });
      expect(await t.db.privileged.mutation.count({ where: { runId } })).toBe(0);
    } finally {
      freeBytes = undefined;
    }
  }, 300_000);

  it('[JOB-015] a mirror rebuilt in a later job passes the disk precheck and the blob scan again, and is offered to parity', async () => {
    const repo = await addSourceRepo();
    const stop = new AbortController();
    faults.createThenShutdown = stop;
    const runId = await start(repo.migration.id);
    // Job 1 ends after the repository exists: the scratch directory (and the mirror) goes with it.
    expect(await execute(runId, stop.signal)).toEqual({ outcome: 'handed_off' });
    expect(await services.mirrors.sourceMirror(runId)).toBeUndefined();
    // Job 2 has no space for the rebuild: the push Step waits instead of filling the disk.
    freeBytes = async () => -1;
    try {
      expect(await execute(runId)).toMatchObject({ outcome: 'delayed' });
    } finally {
      freeBytes = undefined;
    }
    const last = await execute(runId);
    expect(last).toEqual({ outcome: 'finished', status: 'succeeded' });
    const logs = await t.db.privileged.runLog.findMany({ where: { runId } });
    expect(logs.map((l) => l.message)).toContain('The source mirror was rebuilt and scanned');
    const source = await refsOf('source', `${WORLD_WORKSPACE}/${repo.slug}`);
    expect(migrated(await refsOf('target', `${ORG}/${repo.target}`))).toEqual(migrated(source));
  }, 300_000);
});
