/**
 * T-061: the analysis processor and the feeder against the TST-012 fixture world. The real
 * adapters (through the registry) talk to the fake Bitbucket, GitHub and git server over loopback;
 * Postgres is a throw-away database.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EndpointConnection } from '@git-migrator/adapter-sdk';
import { type Config, resolveConfig } from '@git-migrator/config';
import { hashConfig, syncConfig } from '@git-migrator/db';
import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import {
  resetWorld,
  startWorldFakes,
  WORLD_MEMBERS,
  WORLD_REPOSITORIES,
  WORLD_ROUTE,
  WORLD_WORKSPACE,
  type WorldRepository,
} from '@git-migrator/fixtures';
import {
  type AnalysisDeps,
  createAnalysisGitClient,
  createEndpointConnector,
  createProviderEnvironment,
  type EndpointConnector,
  JobRuntime,
  migrateBullmqSchema,
  noGitClient,
  runAnalysis,
  runFeeder,
  runInventory,
} from '@git-migrator/jobs';
import { createLogger, createMetrics } from '@git-migrator/observability';
import type { RunningFakes } from '@git-migrator/provider-fakes';
import { QuotaLeases, QuotaService } from '@git-migrator/quota';
import { createBuiltinRegistry } from '@git-migrator/registry';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const PEM = readFileSync(join(here, '../../fixtures/fake-github-app.pem'), 'utf8');
const SOURCE = 'bb-src';
const TARGET = 'gh-dst';
const ROUTE = 'r-auto';
const log = createLogger({ level: 'silent' });
const registry = createBuiltinRegistry();
const shutdown = new AbortController();

let fakes: RunningFakes;
let t: TestDatabase;
let config: Config;
let connector: EndpointConnector;
let deps: AnalysisDeps;
let scratch: string;
let quota: QuotaService;

const inventory = (endpointId: string) =>
  runInventory(
    {
      db: t.db.privileged,
      appPool: t.db.pool,
      connector,
      registry,
      config,
      log,
    },
    endpointId,
    { shutdown: shutdown.signal },
  );

async function migrationOf(key: string) {
  const [, slug] = key.split('/') as [string, string];
  const repo = await t.db.privileged.repository.findFirstOrThrow({
    where: { endpointId: SOURCE, slug },
  });
  return t.db.privileged.migration.findFirstOrThrow({
    where: { routeId: ROUTE, sourceRepositoryId: repo.id },
  });
}

const analyze = (migrationId: string, pool: 'interactive' | 'background' = 'interactive') =>
  runAnalysis(deps, migrationId, { shutdown: shutdown.signal, pool });

/** `code (kind)` of every non-step Plan item of the latest Analysis. */
async function findingsOf(migrationId: string): Promise<string[]> {
  const m = await t.db.privileged.migration.findUniqueOrThrow({ where: { id: migrationId } });
  const items = await t.db.privileged.planItem.findMany({
    where: { analysisId: m.latestAnalysisId as string, kind: { not: 'step' } },
  });
  const label: Record<string, string> = {
    blocker: 'B',
    pre_task: 'pre',
    post_task: 'post',
    warning: 'W',
  };
  return items.map((i) => `${i.code} (${label[i.kind]})`).sort();
}

const expectedFindings = (r: WorldRepository): string[] => {
  const label = { blocker: 'B', pre: 'pre', post: 'post', warning: 'W' } as const;
  return r.analysis.findings.map((f) => `${f.code} (${label[f.severity]})`).sort();
};

beforeAll(async () => {
  t = await createTestDatabase('gm_t061_');
  fakes = await startWorldFakes({ bitbucketPort: 0, githubPort: 0, gitPort: 0 });
  await resetWorld(fakes);
  fakes.git?.setTokens('source', ['fake-bitbucket-api-token']);
  const gh = fakes.github;
  if (!gh) throw new Error('the fake GitHub did not start');
  scratch = mkdtempSync(join(tmpdir(), 'gm-t061-'));
  const installationId = [...gh.state.installations.keys()][0] as number;
  const gitBase = fakes.git?.baseUrl ?? 'http://127.0.0.1:1';
  config = resolveConfig({
    text: `
environment: test
endpoints:
  - id: ${SOURCE}
    provider: bitbucket-cloud
    baseUrl: http://127.0.0.1:${fakes.bitbucket.port}
    gitBaseUrl: ${gitBase}/source
    options: { workspace: ${WORLD_WORKSPACE} }
  - id: ${TARGET}
    provider: github
    baseUrl: http://127.0.0.1:${gh.port}
    gitBaseUrl: ${gitBase}/target
    options: { org: acme, appId: ${gh.state.ownApp.id}, installationId: ${installationId} }
routes:
  - id: ${ROUTE}
    source: ${SOURCE}
    target: ${TARGET}
    targetNamespace: acme
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
  quota = new QuotaService({ pool: t.db.pool });
  const environment = createProviderEnvironment({
    quota,
    leases: new QuotaLeases({ pool: t.db.pool }),
    db: t.db.privileged,
    recorders: createMetrics().recorders,
    logger: log,
    environment: 'test',
  });
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
  // AUTH-050 step 1: the Atlassian Admin enrichment is not built (T-060 follow-up), so the source
  // Identities get the emails the TST-012 table assumes, as a decorator on the interface.
  connector = {
    async connect(endpointId, options) {
      const connection = await real.connect(endpointId, options);
      if (endpointId !== SOURCE) return connection;
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
  deps = {
    db: t.db.privileged,
    appPool: t.db.pool,
    connector,
    registry,
    config,
    git: createAnalysisGitClient({ scratchDir: scratch }),
    log,
  };
  await inventory(SOURCE);
  await inventory(TARGET);
}, 180_000);

afterAll(async () => {
  await fakes?.close();
  await t?.drop();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}, 60_000);

describe('analysis against the fixture world', () => {
  it('[TST-020] [LIF-020] every fixture repository gets the readiness and findings of the T-043 table', async () => {
    const all = await t.db.privileged.migration.findMany({
      where: { routeId: ROUTE, scope: 'repository' },
    });
    for (const m of all) await analyze(m.id);
    // Cross-repository facts (FAC-DKY-003) mark holders stale; run those again until none is.
    for (let round = 0; round < 5; round++) {
      const stale = await t.db.privileged.migration.findMany({
        where: { routeId: ROUTE, scope: 'repository', analysisStaleAt: { lte: new Date() } },
      });
      if (stale.length === 0) break;
      for (const m of stale) await analyze(m.id);
    }
    const mismatches: string[] = [];
    for (const r of WORLD_REPOSITORIES) {
      const m = await migrationOf(r.key);
      const fresh = await t.db.privileged.migration.findUniqueOrThrow({ where: { id: m.id } });
      const got = await findingsOf(m.id);
      const want = expectedFindings(r);
      if (
        fresh.readiness !== r.analysis.readiness ||
        JSON.stringify(got) !== JSON.stringify(want)
      ) {
        mismatches.push(
          `${r.key}: ${fresh.readiness} ${JSON.stringify(got)} != ${r.analysis.readiness} ${JSON.stringify(want)}`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  }, 300_000);

  it('[LIF-080] the endpoint Migration of the Route is analyzed against the real adapters', async () => {
    const endpointMigration = await t.db.privileged.migration.findFirstOrThrow({
      where: { routeId: ROUTE, scope: 'endpoint' },
    });
    const result = await analyze(endpointMigration.id);
    expect(result.analysisId).toBeTruthy();
    const row = await t.db.privileged.migration.findUniqueOrThrow({
      where: { id: endpointMigration.id },
    });
    expect(row.latestAnalysisId).toBe(result.analysisId);
    expect(row.status).toBe('analyzed');
    const analysis = await t.db.privileged.analysis.findUniqueOrThrow({
      where: { id: result.analysisId as string },
    });
    const snapshots = await t.db.privileged.facetSnapshot.findMany({
      where: { id: { in: [...analysis.sourceSnapshotIds, ...analysis.targetSnapshotIds] } },
    });
    expect(new Set(snapshots.map((x) => x.facetKey))).toEqual(
      new Set(['members', 'teams', 'org-variables', 'org-secrets', 'org-webhooks']),
    );
  }, 120_000);
});

describe('stale marking (LIF-021) and the feeder (JOB-020) against the fixture world', () => {
  const analyzedIds = () =>
    t.db.privileged.migration.findMany({
      where: { routeId: ROUTE, scope: 'repository', latestAnalysisId: { not: null } },
      select: { id: true, analysisStaleAt: true },
    });

  it('[LIF-021] a changed Route configuration, a NamingRule and an allowlist entry each mark the Analyses stale', async () => {
    const markFresh = () =>
      t.db.privileged.migration.updateMany({
        where: { routeId: ROUTE },
        data: { analysisStaleAt: new Date(Date.now() + 86_400_000) },
      });
    const allStale = async () =>
      (await analyzedIds()).every((m) => m.analysisStaleAt && m.analysisStaleAt <= new Date());
    await markFresh();
    expect(await allStale()).toBe(false);
    await t.db.privileged.webhookAllowlistEntry.create({
      data: { routeId: ROUTE, pattern: 'https://other.example/**' },
    });
    expect(await allStale()).toBe(true);
    await markFresh();
    await t.db.privileged.namingRule.create({
      data: {
        routeId: ROUTE,
        scope: 'namespace',
        scopeRef: (
          await t.db.privileged.namespace.findFirstOrThrow({
            where: { endpointId: SOURCE, slug: 'OPS' },
          })
        ).id,
        pipeline: { steps: [{ var: 'repository', op: 'slug' }], template: '{repository}' },
      },
    });
    expect(await allStale()).toBe(true);
    await markFresh();
    const route = config.routes[0];
    if (!route) throw new Error('no route');
    const changed = { ...route, policies: { ...route.policies, acceptLossy: [] } };
    await syncConfig(t.db.privileged, {
      endpoints: config.endpoints.map((e) => ({
        id: e.id,
        providerType: e.provider,
        displayName: e.id,
        baseUrl: e.baseUrl,
        configHash: hashConfig(e),
      })),
      routes: [
        {
          id: changed.id,
          sourceEndpointId: changed.source,
          targetEndpointId: changed.target,
          targetNamespacePath: changed.targetNamespace,
          policies: changed.policies,
          defaults: changed.defaults,
          sourcePostAction: changed.sourcePostAction,
          configHash: hashConfig(changed),
        },
      ],
    });
    expect(await allStale()).toBe(true);
  }, 60_000);

  it('[JOB-020] the feeder spends only the free background capacity of the source bucket', async () => {
    await migrateBullmqSchema(t.connectionString);
    const runtime = new JobRuntime({
      connectionString: t.connectionString,
      log,
      workerCount: 0,
      applicationName: 'gm-t061-int',
    });
    try {
      await runtime.waitUntilReady();
      const route = await t.db.privileged.route.findUniqueOrThrow({ where: { id: ROUTE } });
      // The analyses above spent real calls in the source buckets and moved the rolling mean.
      expect(route.avgCallsPerAnalysis).not.toBe(30);
      const snapshot = await quota.snapshot();
      const mine = snapshot.filter((b) => b.bucketKey.startsWith(`${SOURCE}:`));
      expect(mine.length).toBeGreaterThan(0);
      const free = Math.min(...mine.map((b) => Math.max(0, b.backgroundLimit - b.used)));
      const feed = () =>
        runFeeder(
          { db: t.db.privileged, runtime, quota, log, maxBatch: 100 },
          { shutdown: shutdown.signal },
        );
      const first = await feed();
      const enqueued = first.enqueued[SOURCE] ?? [];
      expect(enqueued.length).toBeGreaterThan(0);
      expect(enqueued.length).toBeLessThanOrEqual(Math.floor(free / route.avgCallsPerAnalysis));
      // They sit on the background queue under the analysis dedupe id.
      const jobs = await runtime
        .queue('analysis-background')
        .getJobs(['waiting', 'delayed', 'prioritized']);
      expect(jobs.map((j) => (j.data as { migrationId: string }).migrationId).sort()).toEqual(
        [...enqueued].sort(),
      );
      // Spent capacity (the near-limit clamp of JOB-043) stops the feeder.
      await runtime.queue('analysis-background').drain(true);
      for (const b of mine) {
        await quota.recordFeedback({
          bucketKey: b.bucketKey,
          limit: b.limit,
          windowSeconds: b.windowSeconds,
          nearLimit: true,
        });
      }
      expect((await feed()).total).toBe(0);
    } finally {
      await runtime.close();
    }
  }, 120_000);
});
