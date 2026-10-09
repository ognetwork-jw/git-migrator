/**
 * T-089: drift (LIF-065) and rollback (LIF-077) against the fake Bitbucket, the fake GitHub and the
 * fake git server. The real adapters, the real Run executor, the real API app and a throw-away
 * Postgres (TST-006). TST-020 lists these scenarios: drift detection after mutating the fake
 * GitHub and resync, and rollback of a created target and of an adopted target.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AdapterError,
  type EndpointConnection,
  type RepositoryRef,
} from '@git-migrator/adapter-sdk';
import { createApiApp, createEventHub } from '@git-migrator/api';
import { type AuthService, issueApiKey } from '@git-migrator/auth';
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
  createVerifyPlanner,
  createVerifyStep,
  type EndpointConnector,
  type ExecuteResult,
  executeRun,
  MigrationLinks,
  type MigrationServices,
  MirrorRegistry,
  noGitClient,
  type ParityDeps,
  parityHandlers,
  type RunEnqueuerLike,
  RunStepRegistry,
  registerMigrationSteps,
  runAnalysis,
  runDriftSweep,
  runInventory,
  runParity,
  withRunScratch,
} from '@git-migrator/jobs';
import { createLogger, createMetrics } from '@git-migrator/observability';
import {
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
/** Faults the source lock can be told to inject once. */
const faults: {
  ambiguousLock?: 'after' | 'before';
  /** With `ambiguousLock: 'after'`: the source cannot be inspected once the writes happened. */
  downAfterWrite?: boolean;
  /** `SourceLock.inspect` fails while set. */
  inspectDown?: boolean;
  /** The target repository is created, then the call fails: the create intent stays open. */
  createThenFail?: boolean;
  /**
   * Once a lookup by id finds the repository, it is made public and transferred to this owner: a
   * transfer between the rollback's lookup and its writes.
   */
  transferAfterLookup?: string;
  /** With `transferAfterLookup`: a repository is then made on the old name. */
  recreateAfterTransfer?: boolean;
  /**
   * The first driver `undo` of this Facet deletes the target repository and fails `not_found`: the
   * repository goes away under a write.
   */
  goneDuringUndo?: string;
} = {};

const delayed: { runId: string; delayMs: number | undefined }[] = [];
/** The Facets read on the source since the list was last emptied. */
const sourceFacetReads: string[] = [];

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

let parityDeps: ParityDeps;

function deps() {
  const registry = new RunStepRegistry<MigrationServices>();
  registerMigrationSteps(registry, services);
  registry.register('verify', createVerifyPlanner(parityDeps));
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
function execute(runId: string): Promise<ExecuteResult> {
  return withRunScratch(scratch, runId, (scratchDir) =>
    executeRun(deps(), runId, { shutdown: shutdown.signal, scratchDir }),
  );
}

type Kind =
  | 'migrate'
  | 'resync'
  | 'verify'
  | 'rollback'
  | 'source_read_only'
  | 'undo_source_read_only';

/** Creates a Run and executes it with the real executor. */
async function perform(
  migrationId: string,
  kind: Kind = 'migrate',
  extra: { options?: Record<string, unknown>; confirm?: string } = {},
): Promise<{ runId: string; result: ExecuteResult }> {
  const created = await createRun(t.db.privileged, {
    migrationId,
    kind,
    triggeredById: actorId,
    ...extra,
  });
  return { runId: created.runId, result: await execute(created.runId) };
}

const stepStatuses = async (runId: string): Promise<Record<string, string>> =>
  Object.fromEntries(
    (await t.db.privileged.runStep.findMany({ where: { runId } })).map((s) => [
      s.stepKey,
      s.status,
    ]),
  );

/** The fake Bitbucket's repository. */
function sourceRepo(slug: string) {
  const repo = fakes.bitbucket.state
    .workspace(WORLD_WORKSPACE)
    ?.repositories.find((r) => r.slug === slug);
  if (!repo) throw new Error(`no source repository ${slug}`);
  return repo;
}

const pushLock = (slug: string) =>
  sourceRepo(slug).branchRestrictions.filter((r) => r.kind === 'push' && r.pattern === '*');

beforeAll(async () => {
  t = await createTestDatabase('gm_t089_');
  fakes = await startWorldFakes({ bitbucketPort: 0, githubPort: 0, gitPort: 0 });
  await resetWorld(fakes);
  fakes.git?.setTokens('source', ['fake-bitbucket-api-token']);
  const gh = fakes.github;
  if (!gh) throw new Error('the fake GitHub did not start');
  // The fake Bitbucket meters the source by the hour as well (JOB-043); Parity re-reads it.
  await fakes.bitbucket.app.request('/__config', {
    method: 'POST',
    body: JSON.stringify({
      limits: {
        'repository-data': null,
        'raw-files': null,
        webhooks: null,
        'app-properties': null,
      },
    }),
  });
  // The suite migrates many repositories in one hour of the fake's clock; the limits are not what
  // these tests are about (the rate-limit paths have their own tests).
  gh.state.config = {
    ...gh.state.config,
    secondary: { contentCreationPerMinute: null, contentCreationPerHour: null },
    primary: { limits: { core: 10_000_000, graphql: 10_000_000 } },
  };
  scratch = mkdtempSync(join(tmpdir(), 'gm-t089-'));
  work = mkdtempSync(join(tmpdir(), 'gm-t089-work-'));
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
  const inner: EndpointConnector = {
    async connect(endpointId, options) {
      const connection = await real.connect(endpointId, options);
      if (endpointId === TARGET) {
        return {
          ...connection,
          limits: { ...connection.limits, ...WORLD_LIMITS },
          inventory: {
            ...connection.inventory,
            async findRepositoryById(providerId) {
              const found = (await connection.inventory.findRepositoryById?.(providerId)) ?? null;
              const owner = faults.transferAfterLookup;
              const repo = found && fakes.github?.state.findRepo(ORG, found.slug);
              if (owner && repo) {
                faults.transferAfterLookup = undefined;
                repo.visibility = 'public';
                repo.private = false;
                fakes.github?.state.transferRepository(repo, owner);
                if (faults.recreateAfterTransfer) {
                  faults.recreateAfterTransfer = undefined;
                  fakes.github?.state.addRepository(ORG, { name: found.slug });
                }
              }
              return found;
            },
          },
          facets: Object.fromEntries(
            Object.entries(connection.facets).map(([key, driver]) => [
              key,
              driver?.undo
                ? {
                    ...driver,
                    async undo(...args: Parameters<NonNullable<typeof driver.undo>>) {
                      const target = args[1];
                      if (faults.goneDuringUndo === key && target.scope === 'repository') {
                        faults.goneDuringUndo = undefined;
                        const repo = fakes.github?.state.findRepo(ORG, target.repository.slug);
                        if (repo) fakes.github?.state.deleteRepository(repo);
                        throw new AdapterError({
                          code: 'not_found',
                          provider: 'github',
                          message: 'Not Found',
                        });
                      }
                      return driver.undo?.(...args);
                    },
                  }
                : driver,
            ]),
          ) as EndpointConnection['facets'],
          repositories: {
            ...connection.repositories,
            async create(ns, spec) {
              const created = await connection.repositories.create(ns, spec);
              if (faults.createThenFail) {
                faults.createThenFail = undefined;
                throw new AdapterError({
                  code: 'invalid',
                  provider: 'github',
                  message: 'the response was lost',
                });
              }
              return created;
            },
          },
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
              return (await connection.changeRequests?.upsert(ref, req)) as never;
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
      const lock = connection.sourceLock;
      if (!lock) return { ...connection, inventory };
      return {
        ...connection,
        inventory,
        sourceLock: {
          ...lock,
          async inspect(ref, options) {
            if (faults.inspectDown) {
              throw new AdapterError({
                code: 'forbidden',
                provider: 'bitbucket-cloud',
                message: 'the source cannot be read',
              });
            }
            return (await lock.inspect?.(ref, options)) ?? [];
          },
          async apply(ref, ctx) {
            const mode = faults.ambiguousLock;
            faults.ambiguousLock = undefined;
            // 'before': the worker dies before the write; 'after': the writes happen unconfirmed.
            const records = mode === 'before' ? [] : await lock.apply(ref, ctx);
            if (!mode) return records;
            if (mode === 'after' && faults.downAfterWrite) {
              faults.downAfterWrite = undefined;
              faults.inspectDown = true;
            }
            // The writes happened; the adapter could not read them back, so it reports none.
            throw Object.assign(
              new AdapterError({ code: 'conflict', provider: 'bitbucket-cloud', message: 'lost' }),
              { mutations: [], possiblyApplied: ['branch-restriction'] },
            );
          },
        },
      };
    },
  };
  // Counts the Facet reads of the source, to show what a drift check reads (LIF-060 step 1).
  const connector: EndpointConnector = {
    ...inner,
    async connect(endpointId, options) {
      const connection = await inner.connect(endpointId, options);
      if (endpointId !== SOURCE) return connection;
      return {
        ...connection,
        facets: Object.fromEntries(
          Object.entries(connection.facets).map(([key, driver]) => [
            key,
            driver && {
              ...driver,
              async read(...args: Parameters<typeof driver.read>) {
                sourceFacetReads.push(key);
                return driver.read(...args);
              },
            },
          ]),
        ),
      };
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
  parityDeps = {
    db: t.db.privileged,
    appPool: t.db.pool,
    connector,
    registry,
    git: analysisDeps.git,
    log,
  };
  const mirrors = new MirrorRegistry();
  services = {
    db: t.db.privileged,
    connector,
    registry,
    config,
    quota,
    scratchRoot: scratch,
    links,
    // Step 13 (T-072): the Parity Check, against the same fakes.
    extraSteps: new Map([['verify', createVerifyStep<MigrationServices>(parityDeps)]]),
    mirrors,
    sourceMirror: (runId) => mirrors.sourceMirror(runId),
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

let extraCount = 0;

/** A fresh, Ready source repository (two commits, optional variable), inventoried and analyzed. */
async function addSourceRepo(
  options: { variable?: string; variables?: string[]; pipelines?: string } = {},
) {
  const slug = `extra-${++extraCount}`;
  const git = fakes.git;
  if (!git) throw new Error('no git server');
  const bare = git.repoDir('source', `${WORLD_WORKSPACE}/${slug}`);
  await createBareRepo(bare);
  const seeded = await seedBareRepo(
    bare,
    {
      commits: 2,
      branches: [{ name: 'develop' }],
      ...(options.pipelines
        ? { bigBlobs: [{ path: 'bitbucket-pipelines.yml', content: options.pipelines }] }
        : {}),
    },
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
  for (const key of [
    ...(options.variable ? [options.variable] : []),
    ...(options.variables ?? []),
  ]) {
    state.addVariable(WORLD_WORKSPACE, slug, { key, value: 'x' });
  }
  if (options.pipelines) {
    const repo = state.repository(WORLD_WORKSPACE, slug);
    if (repo) {
      repo.pipelinesEnabled = true;
      repo.files['bitbucket-pipelines.yml'] = options.pipelines;
    }
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

// -- the API app, and the Parity Checks the API enqueues ---------------------------------------------

const parityQueue: { migrationId: string; drift: boolean }[] = [];
let app: ReturnType<typeof createApiApp>;
let operatorKey = '';
const ORIGIN = 'http://localhost:3000';

beforeAll(async () => {
  const actor = await t.db.privileged.actor.create({
    data: { kind: 'service', role: 'operator', displayName: 'api operator' },
  });
  operatorKey = (
    await issueApiKey(t.db.privileged, { actorId: actor.id, name: 'k', issuedBy: actor.id })
  ).key;
  app = createApiApp({
    db: t.db,
    auth: {} as AuthService,
    publicUrl: ORIGIN,
    events: createEventHub({
      listener: { start: () => undefined, subscribe: () => () => undefined, connected: false },
    }),
    services: {
      jobs: {
        enqueue: () => Promise.resolve({} as never),
        enqueueAnalysis: () => Promise.resolve({} as never),
        enqueueRun: () => Promise.resolve({} as never),
        enqueueParity: (migrationId: string, options?: { drift?: boolean }) => {
          parityQueue.push({ migrationId, drift: options?.drift === true });
          return Promise.resolve({} as never);
        },
        queue: () => ({}) as never,
      } as never,
      quota: { snapshot: () => Promise.resolve([]) },
      registry: createBuiltinRegistry(),
    },
    logger: log,
  });
}, 60_000);

afterAll(async () => {
  await fakes?.close();
  await t?.drop();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  if (work) rmSync(work, { recursive: true, force: true });
}, 60_000);

const api = (path: string, init: { method?: string; body?: unknown } = {}) =>
  app.request(`${ORIGIN}/api/v1${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${operatorKey}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

/** The `parity.migration` jobs the API enqueued, run as the worker would (LIF-062). */
async function drainParity(): Promise<void> {
  const handler = parityHandlers(parityDeps)['parity.migration'] as unknown as (
    payload: { migrationId: string; drift?: true },
    ctx: unknown,
  ) => Promise<unknown>;
  for (const job of parityQueue.splice(0)) {
    await handler(
      { migrationId: job.migrationId, ...(job.drift ? { drift: true as const } : {}) },
      { shutdown: shutdown.signal, log },
    );
  }
}

const DRIFT = (readsSource: boolean) => ({
  shutdown: shutdown.signal,
  pool: 'background' as const,
  drift: { readsSource },
});

const migration = (id: string) => t.db.privileged.migration.findUniqueOrThrow({ where: { id } });

const parityStatuses = async (id: string): Promise<Record<string, string>> =>
  Object.fromEntries(
    (await t.db.privileged.parityResult.findMany({ where: { migrationId: id } })).map((p) => [
      p.facetKey,
      p.status,
    ]),
  );

/** Moves a branch of a target repository the way a person with push access would. */
async function pushToTarget(
  name: string,
  branch: string,
  mode: 'extra-branch' | 'delete-branch',
): Promise<void> {
  const bare = fakes.git?.repoDir('target', `${ORG}/${name}`) as string;
  const env = isolatedGitEnv(work);
  if (mode === 'delete-branch') {
    await runGit(['update-ref', '-d', `refs/heads/${branch}`], { cwd: bare, env });
    return;
  }
  const dir = mkdtempSync(join(work, 'tgt-'));
  await runGit(['clone', '-q', bare, dir], { env });
  await runGit(['checkout', '-q', '-b', branch], { cwd: dir, env });
  await runGit(['commit', '-q', '--allow-empty', '-m', 'by hand'], { cwd: dir, env });
  await runGit(['push', '-q', 'origin', branch], { cwd: dir, env });
}

const targetRepo = (name: string) => {
  const repo = fakes.github?.state.findRepo(ORG, name);
  if (!repo) throw new Error(`no target repository ${name}`);
  return repo;
};

const PIPELINES_SIMPLE = `image: node:20
pipelines:
  default:
    - step:
        name: Build and test
        script:
          - npm ci
          - npm test
`;

// ---------------------------------------------------------------------------------------------------
// Drift and resync (LIF-065, TST-020)
// ---------------------------------------------------------------------------------------------------

describe('drift on plat/auto-ok (LIF-065)', () => {
  let id = '';

  it('[LIF-065] a migrate Run leaves the Migration verified with the source read-only', async () => {
    id = (await migrationOf('plat/auto-ok')).id;
    await analyze(id);
    const { result } = await perform(id);
    expect(result).toEqual({ outcome: 'finished', status: 'succeeded' });
    const after = await migration(id);
    expect(after.status).toBe('verified');
    expect(after.sourceReadOnlyApplied).toBe(true);
    expect(pushLock('auto-ok')).toHaveLength(1);
    expect(after.lastDriftCheckAt).toBeNull();
  }, 240_000);

  it('[LIF-065] drift ignores the Mutations that made the source read-only, whether the check reads the whole source or only its git-refs', async () => {
    for (const readsSource of [false, true]) {
      sourceFacetReads.length = 0;
      const out = await runParity(parityDeps, id, DRIFT(readsSource));
      expect(out.skipped).toBeUndefined();
      const after = await migration(id);
      expect(after.status).toBe('verified');
      expect(Object.values(await parityStatuses(id))).not.toContain('different');
      expect(after.lastDriftCheckAt).not.toBeNull();
      // LIF-060 step 1: a drift check re-reads the source git-refs, and the rest of the source only
      // when `schedules.driftReadsSource` is true.
      const read = new Set(sourceFacetReads);
      if (readsSource) expect(read.size).toBeGreaterThan(1);
      else expect([...read]).toEqual(['git-refs']);
    }
    // The lock is still on the source: it was ignored, not undone.
    expect(pushLock('auto-ok')).toHaveLength(1);
  }, 240_000);

  it('[LIF-065] a change made on the target by hand drifts the Migration, keeps the status it left and stores the difference', async () => {
    targetRepo('plat-auto-ok').description = 'changed by hand';
    const out = await runParity(parityDeps, id, DRIFT(false));
    expect(out.skipped).toBeUndefined();
    const after = await migration(id);
    expect(after.status).toBe('drifted');
    expect(after.statusBeforeDrift).toBe('verified');
    expect(await parityStatuses(id)).toMatchObject({ 'repository-settings': 'different' });
    const row = await t.db.privileged.parityResult.findFirstOrThrow({
      where: { migrationId: id, facetKey: 'repository-settings' },
    });
    expect(JSON.stringify(row.diffs)).toContain('/description');
  }, 240_000);

  it('[LIF-065] accept turns the shown differences into manual_accepted Expected Differences and a Parity Check returns the Migration to its status before the drift', async () => {
    const res = await api(`/migrations/${id}/drift/accept`, {
      method: 'POST',
      body: { note: 'renamed on purpose' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ migrationId: id, accepted: 1, skipped: [] });
    // The API only enqueued the check (LIF-062); the worker runs it.
    expect(parityQueue).toEqual([{ migrationId: id, drift: false }]);
    expect((await migration(id)).status).toBe('drifted');
    await drainParity();
    const after = await migration(id);
    expect(after.status).toBe('verified');
    const eds = await t.db.privileged.expectedDifference.findMany({
      where: { migrationId: id, reason: 'manual_accepted', revokedAt: null },
    });
    expect(eds.map((e) => [e.facetKey, e.path, e.note])).toEqual([
      ['repository-settings', '/description', 'renamed on purpose'],
    ]);
  }, 240_000);

  it('[LIF-065] revoking the acceptance drifts the Migration again, and resync rewrites the target from the source: running, migrated, verified', async () => {
    const ed = await t.db.privileged.expectedDifference.findFirstOrThrow({
      where: { migrationId: id, reason: 'manual_accepted', revokedAt: null },
    });
    expect((await api(`/expected-differences/${ed.id}`, { method: 'DELETE' })).status).toBe(200);
    await drainParity();
    expect((await migration(id)).status).toBe('drifted');

    const { runId, result } = await perform(id, 'resync');
    expect(result).toEqual({ outcome: 'finished', status: 'succeeded' });
    const after = await migration(id);
    expect(after.status).toBe('verified');
    expect(targetRepo('plat-auto-ok').description).not.toBe('changed by hand');
    expect((await stepStatuses(runId)).verify).toBe('succeeded');
    expect(Object.values(await parityStatuses(id))).not.toContain('different');
  }, 300_000);

  it('[LIF-065] the sweep enqueues a drift check for each verified Migration, spread across the interval, and for no other', async () => {
    const calls: { migrationId: string; drift?: boolean; delayMs?: number }[] = [];
    const out = await runDriftSweep({
      db: t.db.privileged,
      runtime: {
        enqueueParity: async (
          migrationId: string,
          options?: { drift?: boolean; delayMs?: number },
        ) => {
          calls.push({ migrationId, ...(options ?? {}) });
          return {} as never;
        },
      },
      schedule: '17 3 * * *',
      log,
    });
    const verified = await t.db.privileged.migration.findMany({
      where: { scope: 'repository', status: { in: ['verified', 'manually_completed'] } },
    });
    expect(out.eligible).toBe(verified.length);
    expect(calls.map((c) => c.migrationId).sort()).toEqual(verified.map((m) => m.id).sort());
    expect(calls.every((c) => c.drift === true)).toBe(true);
    expect(out.intervalMs).toBe(24 * 3_600_000);
    const delays = calls.map((c) => c.delayMs ?? 0);
    expect(delays).toEqual([...delays].sort((a, b) => a - b));
    expect(Math.max(...delays)).toBeLessThan(out.intervalMs);
  }, 120_000);
});

describe('containment once the source is read-only (FAC-GIT-006, LIF-065)', () => {
  it('[FAC-GIT-006] a branch only the target has is not drift, and a source branch missing from the target is', async () => {
    const repo = await addSourceRepo();
    expect((await perform(repo.migration.id)).result).toMatchObject({ status: 'succeeded' });
    expect((await migration(repo.migration.id)).status).toBe('verified');
    expect((await migration(repo.migration.id)).sourceReadOnlyApplied).toBe(true);

    await pushToTarget(repo.target, 'hotfix', 'extra-branch');
    await runParity(parityDeps, repo.migration.id, DRIFT(false));
    expect((await migration(repo.migration.id)).status).toBe('verified');

    await pushToTarget(repo.target, 'develop', 'delete-branch');
    await runParity(parityDeps, repo.migration.id, DRIFT(false));
    const drifted = await migration(repo.migration.id);
    expect(drifted.status).toBe('drifted');
    expect(drifted.statusBeforeDrift).toBe('verified');
    expect((await parityStatuses(repo.migration.id))['git-refs']).toBe('different');
  }, 400_000);
});

// ---------------------------------------------------------------------------------------------------
// Rollback (LIF-077, TST-020)
// ---------------------------------------------------------------------------------------------------

const confirmOf = (target: string) => `${ORG}/${target}`;

describe('rollback of a target the framework created (LIF-077)', () => {
  it('[LIF-077] is refused while the source is read-only: undo_source_read_only first, then the typed confirmation, then the repository is deleted', async () => {
    const repo = await addSourceRepo();
    const id = repo.migration.id;
    expect((await perform(id)).result).toMatchObject({ status: 'succeeded' });
    expect((await migration(id)).targetCreatedByFramework).toBe(true);
    expect((await migration(id)).sourceReadOnlyApplied).toBe(true);
    expect(targetRepo(repo.target)).toBeDefined();

    await expect(
      createRun(t.db.privileged, {
        migrationId: id,
        kind: 'rollback',
        triggeredById: actorId,
        confirm: confirmOf(repo.target),
      }),
    ).rejects.toMatchObject({ code: 'run.not_permitted' });

    const undone = await perform(id, 'undo_source_read_only');
    expect(undone.result).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect((await migration(id)).sourceReadOnlyApplied).toBe(false);

    await expect(
      createRun(t.db.privileged, { migrationId: id, kind: 'rollback', triggeredById: actorId }),
    ).rejects.toMatchObject({ code: 'run.confirmation_required' });

    const { runId, result } = await perform(id, 'rollback', { confirm: confirmOf(repo.target) });
    expect(result).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect(await stepStatuses(runId)).toEqual({
      'rollback.target': 'succeeded',
      'rollback.settle': 'succeeded',
    });
    // LIF-002: the Run changed the target, so a cancel halfway would have left the Migration partial.
    expect(
      (await t.db.privileged.run.findUniqueOrThrow({ where: { id: runId } })).hasMutations,
    ).toBe(true);
    // The repository is gone from the target, and so is the Migration's link to it.
    expect(fakes.github?.state.findRepo(ORG, repo.target)).toBeUndefined();
    const after = await migration(id);
    expect(after.status).toBe('rolled_back');
    expect(after.targetCreatedByFramework).toBe(false);
    expect(after.sourceReadOnlyApplied).toBe(false);
    expect(after.targetRepositoryId).toBeNull();
    expect(await parityStatuses(id)).toEqual({});
    // Every target record is undone, none is left to revert.
    const left = await t.db.privileged.mutation.findMany({
      where: { migrationId: id, side: 'target', undoneAt: null, state: { not: 'not_applied' } },
    });
    expect(left.filter((r) => (r.resourceRef as { noop?: boolean }).noop !== true)).toEqual([]);
    // The source is as it was before the migration (the undo ran first).
    expect(pushLock(repo.slug)).toHaveLength(0);

    // A rolled back Migration has nothing to roll back; the next Analysis makes it analyzed.
    await expect(
      createRun(t.db.privileged, {
        migrationId: id,
        kind: 'rollback',
        triggeredById: actorId,
        confirm: confirmOf(repo.target),
      }),
    ).rejects.toMatchObject({ code: 'run.not_permitted' });
    await analyze(id);
    expect((await migration(id)).status).toBe('analyzed');
  }, 600_000);

  it('[LIF-077] an organization that does not let the App delete fails the Run with guidance, and a later Run succeeds', async () => {
    const repo = await addSourceRepo();
    const id = repo.migration.id;
    expect(
      (await perform(id, 'migrate', { options: { skipSourceReadOnly: true } })).result,
    ).toMatchObject({ status: 'succeeded' });
    const gh = fakes.github;
    if (!gh) throw new Error('no fake GitHub');
    gh.state.config.repositoryDeletion = 'forbidden';
    const failed = await perform(id, 'rollback', { confirm: confirmOf(repo.target) });
    expect(failed.result).toEqual({ outcome: 'finished', status: 'failed' });
    expect(fakes.github?.state.findRepo(ORG, repo.target)).toBeDefined();
    const after = await migration(id);
    expect(after.status).toBe('partial');
    expect(after.targetCreatedByFramework).toBe(true);
    const step = await t.db.privileged.runStep.findFirstOrThrow({
      where: { runId: failed.runId, stepKey: 'rollback.target' },
    });
    expect(step.error).toMatchObject({ code: 'repository-settings.deletion-forbidden' });
    const tasks = await t.db.privileged.manualTask.findMany({
      where: { migrationId: id, code: 'repository-settings.deletion-forbidden' },
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ phase: 'post', origin: 'run', status: 'open' });

    gh.state.config.repositoryDeletion = 'allowed';
    const again = await perform(id, 'rollback', { confirm: confirmOf(repo.target) });
    expect(again.result).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect(fakes.github?.state.findRepo(ORG, repo.target)).toBeUndefined();
    expect((await migration(id)).status).toBe('rolled_back');
  }, 600_000);
});

describe('rollback of an adopted target (LIF-077)', () => {
  it('[LIF-077] leaves the repository and its git refs, and reverts the writes of the framework newest first', async () => {
    const repo = await addSourceRepo({
      variables: ['ROLL_A', 'ROLL_B'],
      pipelines: PIPELINES_SIMPLE,
    });
    const id = repo.migration.id;
    const ref = await createTarget(repo.target);
    const before = targetRepo(repo.target);
    const original = {
      description: before.description,
      variables: before.variables.map((v) => v.name),
      keys: before.keys.length,
      rules: before.rules.length,
      hooks: before.hooks.length,
      environments: before.environments.length,
    };
    const run = await perform(id, 'migrate', { options: { skipSourceReadOnly: true } });
    expect(run.result).toMatchObject({ status: 'succeeded' });
    const migrated = await migration(id);
    expect(migrated.targetCreatedByFramework).toBe(false);
    const written = targetRepo(repo.target);
    expect(written.variables.map((v) => v.name).sort()).toEqual(['ROLL_A', 'ROLL_B']);
    expect(written.pulls).toHaveLength(1);
    const refsBefore = migrated_(await refsOf('target', `${ORG}/${repo.target}`));
    expect(Object.keys(refsBefore)).toContain('refs/heads/main');

    const { runId, result } = await perform(id, 'rollback', { confirm: confirmOf(repo.target) });
    expect(result).toEqual({ outcome: 'finished', status: 'succeeded' });
    const after = targetRepo(repo.target);
    // The repository is the operator's: it stays, as it was, apart from the git content.
    expect(after.nodeId).toBe(ref.providerId);
    expect(after.description).toBe(original.description);
    expect(after.variables.map((v) => v.name)).toEqual(original.variables);
    expect(after.keys).toHaveLength(original.keys);
    expect(after.rules).toHaveLength(original.rules);
    expect(after.hooks).toHaveLength(original.hooks);
    expect(after.environments).toHaveLength(original.environments);
    // The Change Request the framework opened is closed.
    expect(after.pulls.map((p) => p.state)).toEqual(['closed']);
    // Git refs are left untouched (LIF-077).
    expect(migrated_(await refsOf('target', `${ORG}/${repo.target}`))).toEqual(refsBefore);

    expect(
      (await t.db.privileged.run.findUniqueOrThrow({ where: { id: runId } })).hasMutations,
    ).toBe(true);
    const done = await migration(id);
    expect(done.status).toBe('rolled_back');
    expect(done.targetCreatedByFramework).toBe(false);
    const undoneRows = await t.db.privileged.mutation.findMany({
      where: { migrationId: id, side: 'target', undoneAt: { not: null } },
      orderBy: { undoneAt: 'asc' },
    });
    expect(undoneRows.length).toBeGreaterThan(2);
    // Newest first: no record is undone before one recorded after it.
    const bySeq = [...undoneRows].sort((a, b) => Number(b.seq - a.seq));
    expect(undoneRows.map((r) => r.id)).toEqual(bySeq.map((r) => r.id));
    expect(await stepStatuses(runId)).toEqual({
      'rollback.target': 'succeeded',
      'rollback.settle': 'succeeded',
    });
    // The adopted repository is still the Migration's target until a new Analysis decides.
    expect(done.targetRepositoryId).toBe(migrated.targetRepositoryId);
  }, 600_000);

  it('[LIF-077] a rollback with nothing to undo is refused', async () => {
    const repo = await addSourceRepo();
    await expect(
      createRun(t.db.privileged, {
        migrationId: repo.migration.id,
        kind: 'rollback',
        triggeredById: actorId,
        confirm: confirmOf(repo.target),
      }),
    ).rejects.toMatchObject({ code: 'run.not_permitted' });
  }, 200_000);
});

/** The refs a migration carries over, without the framework's own branches. */
function migrated_(refs: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(refs).filter(([name]) => !name.startsWith('refs/heads/git-migrator/')),
  );
}

/** Branches and tags of a bare repository on the fake git server, name to sha. */
async function refsOf(side: 'source' | 'target', repo: string): Promise<Record<string, string>> {
  const out = await runGit(['for-each-ref', '--format=%(objectname) %(refname)'], {
    cwd: fakes.git?.repoDir(side, repo) as string,
    env: isolatedGitEnv(work),
  });
  return Object.fromEntries(
    out.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line): [string, string] => {
        const [sha, name] = line.split(' ') as [string, string];
        return [name, sha];
      })
      .filter(([name]) => name.startsWith('refs/heads/') || name.startsWith('refs/tags/')),
  );
}

describe('rollback after a create whose response was lost (LIF-077, T-071 follow-up)', () => {
  it('[LIF-077] the repository the framework created, found through the open create intent, is deleted', async () => {
    const repo = await addSourceRepo();
    const id = repo.migration.id;
    faults.createThenFail = true;
    const first = await perform(id);
    expect(first.result).toEqual({ outcome: 'finished', status: 'failed' });
    expect(
      await t.db.privileged.mutation.count({ where: { runId: first.runId, state: 'intended' } }),
    ).toBe(1);
    expect((await migration(id)).targetRepositoryId).toBeNull();
    expect(targetRepo(repo.target)).toBeDefined();

    const { result } = await perform(id, 'rollback', { confirm: confirmOf(repo.target) });
    expect(result).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect(fakes.github?.state.findRepo(ORG, repo.target)).toBeUndefined();
    expect((await migration(id)).status).toBe('rolled_back');
  }, 400_000);

  it('[LIF-077] an EMPTY repository somebody made by hand after the Run ended is not the framework’s and is never deleted', async () => {
    const repo = await addSourceRepo();
    const id = repo.migration.id;
    faults.createThenFail = true;
    const first = await perform(id);
    expect(first.result).toEqual({ outcome: 'finished', status: 'failed' });
    // What the Run created is replaced by a repository of the operator's own, well after the Run.
    await t.db.pool.query(
      "UPDATE app.run SET finished_at = now() - interval '1 hour' WHERE id = $1",
      [first.runId],
    );
    fakes.github?.state.deleteRepository(targetRepo(repo.target));
    const handMade = await createTarget(repo.target);

    const { result } = await perform(id, 'rollback', { confirm: confirmOf(repo.target) });
    expect(result).toEqual({ outcome: 'finished', status: 'succeeded' });
    const still = fakes.github?.state.findRepo(ORG, repo.target);
    expect(still?.nodeId).toBe(handMade.providerId);
    // The intent is settled as not applied, and the Migration is rolled back without a deletion.
    expect(
      await t.db.privileged.mutation.count({ where: { runId: first.runId, state: 'intended' } }),
    ).toBe(0);
    expect((await migration(id)).status).toBe('rolled_back');
  }, 400_000);
});

// ---------------------------------------------------------------------------------------------------
// Round 2: a 404 is not "gone", a conflict is not "gone", and what cannot be undone is not undone
// ---------------------------------------------------------------------------------------------------

async function renameTarget(name: string, to: string): Promise<void> {
  const gh = fakes.github;
  if (!gh) throw new Error('no fake GitHub');
  const res = await fetch(`http://127.0.0.1:${gh.port}/repos/${ORG}/${name}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${gh.token()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: to }),
  });
  expect(res.status).toBe(200);
}

const installation = () => {
  const inst = [...(fakes.github?.state.installations.values() ?? [])][0];
  if (!inst) throw new Error('no installation');
  return inst;
};

describe('rollback never takes "not found" for "gone" (LIF-077)', () => {
  it('[LIF-077] an installation that cannot see the target fails the Run with guidance, reverts and releases nothing, and a later Run succeeds', async () => {
    const repo = await addSourceRepo({ variables: ['HID_A'] });
    const id = repo.migration.id;
    await createTarget(repo.target);
    expect(
      (await perform(id, 'migrate', { options: { skipSourceReadOnly: true } })).result,
    ).toMatchObject({ status: 'succeeded' });
    const linked = (await migration(id)).targetRepositoryId;
    expect(targetRepo(repo.target).variables).toHaveLength(1);

    // The installation now sees only some repositories, and not this one.
    installation().repositorySelection = 'selected';
    installation().repositories = [];
    const failed = await perform(id, 'rollback', { confirm: confirmOf(repo.target) });
    expect(failed.result).toEqual({ outcome: 'finished', status: 'failed' });
    const step = await t.db.privileged.runStep.findFirstOrThrow({
      where: { runId: failed.runId, stepKey: 'rollback.target' },
    });
    expect(step.error).toMatchObject({ code: 'repository-settings.target-unreadable' });
    expect(
      await t.db.privileged.manualTask.count({
        where: { migrationId: id, code: 'repository-settings.target-unreadable', phase: 'post' },
      }),
    ).toBe(1);
    // Nothing is marked undone and the repository is still the Migration's.
    expect(
      await t.db.privileged.mutation.count({ where: { migrationId: id, undoneAt: { not: null } } }),
    ).toBe(0);
    const after = await migration(id);
    expect(after.targetRepositoryId).toBe(linked);
    expect(after.status).toBe('partial');

    installation().repositorySelection = 'all';
    const again = await perform(id, 'rollback', { confirm: confirmOf(repo.target) });
    expect(again.result).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect(targetRepo(repo.target).variables).toHaveLength(0);
  }, 600_000);

  it('[LIF-077] a created repository that was renamed is deleted under its new name, and a repository made on the old name is left alone', async () => {
    const repo = await addSourceRepo();
    const id = repo.migration.id;
    expect(
      (await perform(id, 'migrate', { options: { skipSourceReadOnly: true } })).result,
    ).toMatchObject({ status: 'succeeded' });
    const original = targetRepo(repo.target).nodeId;
    await renameTarget(repo.target, `${repo.target}-renamed`);
    const handMade = await createTarget(repo.target);

    const { result } = await perform(id, 'rollback', { confirm: confirmOf(repo.target) });
    expect(result).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect(fakes.github?.state.findRepo(ORG, `${repo.target}-renamed`)).toBeUndefined();
    expect(fakes.github?.state.findRepo(ORG, repo.target)?.nodeId).toBe(handMade.providerId);
    expect(handMade.providerId).not.toBe(original);
    expect((await migration(id)).status).toBe('rolled_back');
  }, 600_000);

  it('[LIF-077] a created repository that was renamed, with nothing made on the old name, is deleted under its new name (the old name redirects on real GitHub)', async () => {
    const repo = await addSourceRepo();
    const id = repo.migration.id;
    expect(
      (await perform(id, 'migrate', { options: { skipSourceReadOnly: true } })).result,
    ).toMatchObject({ status: 'succeeded' });
    await renameTarget(repo.target, `${repo.target}-moved`);
    expect(fakes.github?.state.findRepo(ORG, repo.target)).toBeUndefined();

    const { result } = await perform(id, 'rollback', { confirm: confirmOf(repo.target) });
    expect(result).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect(fakes.github?.state.findRepo(ORG, `${repo.target}-moved`)).toBeUndefined();
    expect((await migration(id)).status).toBe('rolled_back');
  }, 600_000);

  it('[LIF-077] a created repository that cannot be found and cannot be ruled out fails the Run; one the provider positively says is gone is done', async () => {
    const repo = await addSourceRepo();
    const id = repo.migration.id;
    expect(
      (await perform(id, 'migrate', { options: { skipSourceReadOnly: true } })).result,
    ).toMatchObject({ status: 'succeeded' });
    installation().repositorySelection = 'selected';
    installation().repositories = [];
    const failed = await perform(id, 'rollback', { confirm: confirmOf(repo.target) });
    expect(failed.result).toEqual({ outcome: 'finished', status: 'failed' });
    expect(fakes.github?.state.findRepo(ORG, repo.target)).toBeDefined();
    expect((await migration(id)).targetRepositoryId).not.toBeNull();

    installation().repositorySelection = 'all';
    fakes.github?.state.deleteRepository(targetRepo(repo.target));
    const done = await perform(id, 'rollback', { confirm: confirmOf(repo.target) });
    expect(done.result).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect((await migration(id)).targetRepositoryId).toBeNull();
  }, 600_000);

  /** Another organization of the fake GitHub, which the installation does not cover. */
  const otherOrg = () => {
    const gh = fakes.github;
    if (!gh) throw new Error('no fake GitHub');
    if (!gh.state.orgs.has('other')) gh.state.addOrg({ login: 'other' });
    return 'other';
  };
  /** The fake GitHub's writes since `from`, as `METHOD path`, without token requests. */
  const writesSince = (from: number): string[] =>
    (fakes.github?.requests() ?? [])
      .slice(from)
      .filter((r) => r.write)
      .filter((r) => !/^\/app\/installations\/\d+\/access_tokens$/.test(r.path))
      .map((r) => `${r.method} ${r.path}`);

  it('[LIF-077] a public adopted target transferred to another owner is gone from the organization: the repository made on its old name gets none of the rollback’s writes', async () => {
    const repo = await addSourceRepo({ variables: ['XFER_A'] });
    const id = repo.migration.id;
    await createTarget(repo.target);
    expect(
      (await perform(id, 'migrate', { options: { skipSourceReadOnly: true } })).result,
    ).toMatchObject({ status: 'succeeded' });
    const adopted = targetRepo(repo.target);
    expect(adopted.variables).toHaveLength(1);
    adopted.visibility = 'public';
    adopted.private = false;
    fakes.github?.state.transferRepository(adopted, otherOrg());
    const handMade = await createTarget(repo.target);
    const from = fakes.github?.requests().length ?? 0;

    const { runId, result } = await perform(id, 'rollback', { confirm: confirmOf(repo.target) });
    expect(result).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect(await stepStatuses(runId)).toEqual({
      'rollback.target': 'succeeded',
      'rollback.settle': 'succeeded',
    });
    // Nothing was written anywhere: not to the new repository, not to the transferred one.
    expect(writesSince(from)).toEqual([]);
    const now = targetRepo(repo.target);
    expect(now.nodeId).toBe(handMade.providerId);
    expect(now.variables).toHaveLength(0);
    expect(fakes.github?.state.findRepo('other', repo.target)?.variables).toHaveLength(1);
    expect((await migration(id)).status).toBe('rolled_back');
  }, 600_000);

  it('[LIF-077] a target transferred between the rollback’s lookup and its writes is caught by the read before the first write: it ends as gone, and nothing is written', async () => {
    const repo = await addSourceRepo({ variables: ['XFER_B'] });
    const id = repo.migration.id;
    await createTarget(repo.target);
    expect(
      (await perform(id, 'migrate', { options: { skipSourceReadOnly: true } })).result,
    ).toMatchObject({ status: 'succeeded' });
    otherOrg();
    faults.transferAfterLookup = 'other';
    const from = fakes.github?.requests().length ?? 0;

    const { runId, result } = await perform(id, 'rollback', { confirm: confirmOf(repo.target) });
    expect(faults.transferAfterLookup).toBeUndefined();
    expect(result).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect(await stepStatuses(runId)).toEqual({
      'rollback.target': 'succeeded',
      'rollback.settle': 'succeeded',
    });
    expect(writesSince(from)).toEqual([]);
    expect(fakes.github?.state.findRepo('other', repo.target)?.variables).toHaveLength(1);
    expect(fakes.github?.state.findRepo(ORG, repo.target)).toBeUndefined();
    expect((await migration(id)).status).toBe('rolled_back');
  }, 600_000);

  it('[LIF-077] a target replaced on its name between the lookup and the writes (transferred, and a new repository made on the name) gets nothing: the read before the write sees another provider id', async () => {
    const repo = await addSourceRepo({ variables: ['XFER_C'] });
    const id = repo.migration.id;
    await createTarget(repo.target);
    expect(
      (await perform(id, 'migrate', { options: { skipSourceReadOnly: true } })).result,
    ).toMatchObject({ status: 'succeeded' });
    otherOrg();
    faults.transferAfterLookup = 'other';
    faults.recreateAfterTransfer = true;
    const from = fakes.github?.requests().length ?? 0;

    const { result } = await perform(id, 'rollback', { confirm: confirmOf(repo.target) });
    expect(faults.recreateAfterTransfer).toBeUndefined();
    expect(result).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect(writesSince(from)).toEqual([]);
    expect(targetRepo(repo.target).variables).toHaveLength(0);
    expect(fakes.github?.state.findRepo('other', repo.target)?.variables).toHaveLength(1);
    expect((await migration(id)).status).toBe('rolled_back');
  }, 600_000);

  it('[LIF-077] a target deleted under a write (the write answers not_found) ends as gone, not as a bare not_found', async () => {
    const repo = await addSourceRepo({ variables: ['GONE_A'] });
    const id = repo.migration.id;
    await createTarget(repo.target);
    expect(
      (await perform(id, 'migrate', { options: { skipSourceReadOnly: true } })).result,
    ).toMatchObject({ status: 'succeeded' });
    faults.goneDuringUndo = 'variables';

    const { runId, result } = await perform(id, 'rollback', { confirm: confirmOf(repo.target) });
    expect(faults.goneDuringUndo).toBeUndefined();
    expect(result).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect(await stepStatuses(runId)).toEqual({
      'rollback.target': 'succeeded',
      'rollback.settle': 'succeeded',
    });
    expect(fakes.github?.state.findRepo(ORG, repo.target)).toBeUndefined();
    // The settle Step found nothing left to revert.
    expect((await migration(id)).status).toBe('rolled_back');
  }, 600_000);
});

describe('what rollback cannot revert is reported, not hidden (LIF-077)', () => {
  it('[LIF-077] a recovered write (no exact reverse) keeps an adopted rollback from completing: the Run fails rollback.incomplete and the Migration is partial', async () => {
    const repo = await addSourceRepo();
    const id = repo.migration.id;
    await createTarget(repo.target);
    const migrate = await perform(id, 'migrate', { options: { skipSourceReadOnly: true } });
    expect(migrate.result).toMatchObject({ status: 'succeeded' });
    await t.db.privileged.mutation.create({
      data: {
        migrationId: id,
        runId: migrate.runId,
        side: 'target',
        facetKey: 'variables',
        resourceRef: { kind: 'recovered-write', umbrella: 'facet-apply' },
        paths: ['/variables[key=repository:LOST]'],
        action: 'update',
        state: 'recorded',
      },
    });
    const { runId, result } = await perform(id, 'rollback', { confirm: confirmOf(repo.target) });
    expect(result).toEqual({ outcome: 'finished', status: 'failed' });
    const settle = await t.db.privileged.runStep.findFirstOrThrow({
      where: { runId, stepKey: 'rollback.settle' },
    });
    expect(settle.error).toMatchObject({ code: 'rollback.incomplete' });
    expect((await migration(id)).status).toBe('partial');
  }, 600_000);

  it('[LIF-077] a target that is gone does not take with it a repository an earlier Run created: that one is checked by id, left, and reported', async () => {
    const repo = await addSourceRepo();
    const id = repo.migration.id;
    await createTarget(repo.target);
    expect(
      (await perform(id, 'migrate', { options: { skipSourceReadOnly: true } })).result,
    ).toMatchObject({ status: 'succeeded' });
    const earlier = await createTarget(`${repo.target}-earlier`);
    const run = await t.db.privileged.run.findFirstOrThrow({ where: { migrationId: id } });
    const created = await t.db.privileged.mutation.create({
      data: {
        migrationId: id,
        runId: run.id,
        side: 'target',
        facetKey: 'framework',
        resourceRef: { kind: 'repository', id: earlier.providerId, name: earlier.slug },
        paths: [],
        action: 'create',
        state: 'recorded',
      },
    });
    // The adopted target is deleted by hand; the earlier repository still exists.
    const adopted = fakes.github?.state.findRepo(ORG, repo.target);
    if (!adopted) throw new Error('no adopted target');
    fakes.github?.state.deleteRepository(adopted);

    const { runId, result } = await perform(id, 'rollback', { confirm: confirmOf(repo.target) });
    expect(result).toEqual({ outcome: 'finished', status: 'failed' });
    const step = await t.db.privileged.runStep.findFirstOrThrow({
      where: { runId, stepKey: 'rollback.target' },
    });
    expect(step.error).toMatchObject({ code: 'rollback.left-in-place' });
    expect(
      (await t.db.privileged.mutation.findUniqueOrThrow({ where: { id: created.id } })).undoneAt,
    ).toBeNull();
    expect(fakes.github?.state.findRepo(ORG, earlier.slug)).toBeDefined();
  }, 600_000);

  it('[LIF-077] a record the driver leaves (a rule replaced by hand) keeps the Run from completing and stays recorded', async () => {
    const repo = await addSourceRepo();
    const id = repo.migration.id;
    await createTarget(repo.target);
    expect(
      (await perform(id, 'migrate', { options: { skipSourceReadOnly: true } })).result,
    ).toMatchObject({ status: 'succeeded' });
    // A rule the framework updated, which somebody has since deleted and made again: its record
    // names a rule that is not there.
    const run = await t.db.privileged.run.findFirstOrThrow({ where: { migrationId: id } });
    const created = await t.db.privileged.mutation.create({
      data: {
        migrationId: id,
        runId: run.id,
        side: 'target',
        facetKey: 'branch-rules',
        resourceRef: {
          kind: 'branch-protection-rule',
          repository: repo.target,
          pattern: 'replaced-by-hand',
          id: 'BPR_gone',
        },
        paths: ['/rules[pattern=replaced-by-hand]'],
        action: 'update',
        before: {
          pattern: 'replaced-by-hand',
          enforcement: 'enforced',
          restrictPushes: null,
          restrictMerges: null,
          blockForcePush: true,
          forcePushExempt: [],
          blockDeletion: true,
          deletionExempt: [],
          changeRequest: null,
        },
        state: 'recorded',
      },
    });
    const { runId, result } = await perform(id, 'rollback', { confirm: confirmOf(repo.target) });
    expect(result).toEqual({ outcome: 'finished', status: 'failed' });
    const step = await t.db.privileged.runStep.findFirstOrThrow({
      where: { runId, stepKey: 'rollback.target' },
    });
    expect(step.error).toMatchObject({ code: 'rollback.left-in-place' });
    // The operator is told what to do by hand.
    const tasks = await t.db.privileged.manualTask.findMany({
      where: { migrationId: id, code: 'repository-settings.left-in-place', phase: 'post' },
    });
    expect(tasks).toHaveLength(1);
    // Structured entries, rendered by guidance in the glossary's terms (GLO-002).
    expect(tasks[0]?.params).toEqual({
      details: [{ kind: 'branch-rule-replaced', name: 'replaced-by-hand' }],
    });
    expect(
      (await t.db.privileged.mutation.findUniqueOrThrow({ where: { id: created.id } })).undoneAt,
    ).toBeNull();
    // The rest of the framework's writes were reverted before the Run reported what it left.
    expect(targetRepo(repo.target).variables).toHaveLength(0);

    // A later rollback that leaves more replaces the task: one open task, with the current list.
    const also = await t.db.privileged.mutation.create({
      data: {
        migrationId: id,
        runId: run.id,
        side: 'target',
        facetKey: 'branch-rules',
        resourceRef: {
          kind: 'branch-protection-rule',
          repository: repo.target,
          pattern: 'also-replaced',
          id: 'BPR_gone_too',
        },
        paths: ['/rules[pattern=also-replaced]'],
        action: 'update',
        before: { ...(created.before as Record<string, unknown>), pattern: 'also-replaced' },
        state: 'recorded',
      },
    });
    const second = await perform(id, 'rollback', { confirm: confirmOf(repo.target) });
    expect(second.result).toEqual({ outcome: 'finished', status: 'failed' });
    const all = await t.db.privileged.manualTask.findMany({
      where: { migrationId: id, code: 'repository-settings.left-in-place' },
      orderBy: { createdAt: 'asc' },
    });
    expect(all.map((task) => task.status)).toEqual(['dismissed', 'open']);
    expect(all[0]).toMatchObject({ completedById: null, note: 'superseded by a later rollback' });
    expect(all[1]?.params).toEqual({
      details: [
        { kind: 'branch-rule-replaced', name: 'also-replaced' },
        { kind: 'branch-rule-replaced', name: 'replaced-by-hand' },
      ],
    });

    // Once nothing is left, the rollback finishes and no left-in-place task stays open.
    await t.db.privileged.mutation.updateMany({
      where: { id: { in: [created.id, also.id] } },
      data: { undoneAt: new Date() },
    });
    const last = await perform(id, 'rollback', { confirm: confirmOf(repo.target) });
    expect(last.result).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect(
      await t.db.privileged.manualTask.count({
        where: { migrationId: id, code: 'repository-settings.left-in-place', status: 'open' },
      }),
    ).toBe(0);
    expect((await migration(id)).status).toBe('rolled_back');
  }, 600_000);

  it('[LIF-077] a target the framework says it created, with no recorded create for its provider id, is not deleted: the Run fails rollback.deletion-unproven with one post task', async () => {
    const repo = await addSourceRepo();
    const id = repo.migration.id;
    expect(
      (await perform(id, 'migrate', { options: { skipSourceReadOnly: true } })).result,
    ).toMatchObject({ status: 'succeeded' });
    const migrated = await migration(id);
    expect(migrated.targetCreatedByFramework).toBe(true);
    const created = targetRepo(repo.target);
    // The recorded create names another repository: nothing proves the framework made this one.
    const changed = await t.db.privileged.$executeRaw`
      UPDATE app.mutation SET resource_ref = jsonb_set(resource_ref, '{id}', '"R_not_this_one"')
      WHERE migration_id = ${id} AND side = 'target' AND action = 'create'
        AND resource_ref->>'kind' = 'repository'`;
    expect(changed).toBe(1);

    const { runId, result } = await perform(id, 'rollback', { confirm: confirmOf(repo.target) });
    expect(result).toEqual({ outcome: 'finished', status: 'failed' });
    const step = await t.db.privileged.runStep.findFirstOrThrow({
      where: { runId, stepKey: 'rollback.target' },
    });
    expect(step.error).toMatchObject({ code: 'rollback.deletion-unproven' });
    const tasks = await t.db.privileged.manualTask.findMany({
      where: { migrationId: id, phase: 'post', origin: 'run' },
    });
    expect(tasks.map((task) => task.code)).toEqual(['repository-settings.deletion-unproven']);
    expect(tasks[0]?.params).toEqual({ repository: `${ORG}/${repo.target}` });
    // The repository is still there, and still the Migration's.
    expect(targetRepo(repo.target).nodeId).toBe(created.nodeId);
    const after = await migration(id);
    expect(after.targetRepositoryId).toBe(migrated.targetRepositoryId);
    expect(after.status).toBe('partial');
  }, 600_000);
});
