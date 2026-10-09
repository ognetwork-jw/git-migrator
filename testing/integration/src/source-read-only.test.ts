/**
 * T-073: source read-only (LIF-070) against the fake Bitbucket, the fake GitHub and the fake git
 * server. The real adapters, the real Run executor and a throw-away Postgres (TST-006).
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdapterError, type EndpointConnection } from '@git-migrator/adapter-sdk';
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
  type RunEnqueuerLike,
  RunStepRegistry,
  registerMigrationSteps,
  runAnalysis,
  runInventory,
  withRunScratch,
} from '@git-migrator/jobs';
import { createLogger, createMetrics } from '@git-migrator/observability';
import type { RunningFakes } from '@git-migrator/provider-fakes';
import { QuotaLeases, QuotaService } from '@git-migrator/quota';
import { createBuiltinRegistry } from '@git-migrator/registry';
import { beforeAll, describe, expect, it } from 'vitest';

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
/** Faults the source lock can be told to inject once. */
const faults: {
  ambiguousLock?: 'after' | 'before';
  /** With `ambiguousLock: 'after'`: the source cannot be inspected once the writes happened. */
  downAfterWrite?: boolean;
  /** `SourceLock.inspect` fails while set. */
  inspectDown?: boolean;
} = {};

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

type Kind = 'migrate' | 'resync' | 'verify' | 'source_read_only' | 'undo_source_read_only';

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

/**
 * A source without any lock, whose earlier records are retired, and a Migration that is not marked
 * read-only and has no run-origin blockers left from earlier tests: a clean slate for one scenario.
 */
async function cleanSource(migrationId: string): Promise<void> {
  const repo = sourceRepo('auto-ok');
  repo.branchRestrictions = repo.branchRestrictions.filter(
    (r) => !(r.kind === 'push' && r.pattern === '*'),
  );
  repo.description = repo.description.replace(/^(\[MIGRATED[^\]]*\] )+/, '');
  await t.db.privileged.mutation.updateMany({
    where: { migrationId, side: 'source', undoneAt: null },
    data: { undoneAt: new Date() },
  });
  await t.db.privileged.migration.update({
    where: { id: migrationId },
    data: { sourceReadOnlyApplied: false },
  });
}

/** The `desired` document the latest Analysis translated for a Facet. */
async function desiredOf(migrationId: string, facetKey: string): Promise<unknown> {
  const m = await t.db.privileged.migration.findUniqueOrThrow({ where: { id: migrationId } });
  const analysis = await t.db.privileged.analysis.findUniqueOrThrow({
    where: { id: m.latestAnalysisId as string },
    select: { translation: true },
  });
  const facets = (analysis.translation as { facets?: Record<string, { desired?: unknown }> })
    .facets;
  return facets?.[facetKey]?.desired;
}

beforeAll(async () => {
  t = await createTestDatabase('gm_t071_');
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
  scratch = mkdtempSync(join(tmpdir(), 'gm-t073-'));
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

describe('plat/auto-ok: step 14 and the Analysis that follows (LIF-070, LIF-045)', () => {
  it('[LIF-070] a migrate Run locks the source as its step 14: the restriction, the description prefix, source-side Mutations of origin framework', async () => {
    const m = await migrationOf('plat/auto-ok');
    const originalDescription = sourceRepo('auto-ok').description;
    await analyze(m.id);
    const { runId, result } = await perform(m.id);
    expect(result).toEqual({ outcome: 'finished', status: 'succeeded' });
    const statuses = await stepStatuses(runId);
    expect(statuses.verify).toBe('succeeded');
    expect(statuses['source.read-only']).toBe('succeeded');

    // The source: a push restriction on every branch for nobody, and the prefix.
    const locks = pushLock('auto-ok');
    expect(locks).toHaveLength(1);
    expect(locks[0]).toMatchObject({ users: [], groups: [] });
    const description = sourceRepo('auto-ok').description;
    expect(description).toMatch(
      /^\[MIGRATED → http:\/\/127\.0\.0\.1:\d+\/target\/acme\/plat-auto-ok\] /,
    );
    expect(description.endsWith(originalDescription)).toBe(true);

    const migration = await t.db.privileged.migration.findUniqueOrThrow({ where: { id: m.id } });
    expect(migration.sourceReadOnlyApplied).toBe(true);
    const source = await t.db.privileged.mutation.findMany({
      where: { migrationId: m.id, side: 'source' },
      orderBy: { seq: 'asc' },
    });
    expect(source.every((r) => r.origin === 'framework' && r.state === 'recorded')).toBe(true);
    expect(source.map((r) => [r.facetKey, r.action])).toEqual([
      ['framework', 'update'],
      ['branch-rules', 'create'],
      ['repository-settings', 'update'],
    ]);
    // A source write is no target Expected Difference (LIF-045).
    expect(
      await t.db.privileged.expectedDifference.count({
        where: { migrationId: m.id, facetKey: { in: ['branch-rules', 'repository-settings'] } },
      }),
    ).toBe(0);
  }, 240_000);

  it('[LIF-045] the Analysis that follows does not translate the source lock: no rule for every branch, and the description without the prefix', async () => {
    const m = await migrationOf('plat/auto-ok');
    expect(pushLock('auto-ok')).toHaveLength(1);
    await analyze(m.id);
    const rules = (await desiredOf(m.id, 'branch-rules')) as { rules: { pattern: string }[] };
    expect(rules.rules.map((r) => r.pattern)).toEqual(['main']);
    const settings = (await desiredOf(m.id, 'repository-settings')) as { description?: string };
    expect(settings.description ?? '').not.toContain('[MIGRATED');
    const latest = await t.db.privileged.migration.findUniqueOrThrow({ where: { id: m.id } });
    expect(latest.readiness).not.toBe('blocked');
  }, 120_000);

  it("[LIF-070] a verify Run after the lock finds the source equal to the target: the framework's own source Mutations are not differences", async () => {
    const m = await migrationOf('plat/auto-ok');
    const { runId, result } = await perform(m.id, 'verify');
    expect(result).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect(await stepStatuses(runId)).toEqual({ verify: 'succeeded' });
    const parity = await t.db.privileged.parityResult.findMany({ where: { migrationId: m.id } });
    expect(parity.map((p) => p.facetKey)).toEqual(
      expect.arrayContaining(['branch-rules', 'repository-settings', 'git-refs']),
    );
    expect(parity.filter((p) => p.status === 'different').map((p) => p.facetKey)).toEqual([]);
  }, 240_000);

  it('[LIF-070] a resync after the lock leaves the already read-only source alone', async () => {
    const m = await migrationOf('plat/auto-ok');
    const before = pushLock('auto-ok');
    const { runId, result } = await perform(m.id, 'resync');
    expect(result).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect((await stepStatuses(runId))['source.read-only']).toBe('skipped');
    expect(pushLock('auto-ok')).toEqual(before);
  }, 240_000);
});

describe('undo_source_read_only restores exactly what was recorded (LIF-070)', () => {
  it('[LIF-070] deletes the restriction, restores the description and marks the Mutations undone; the flag is cleared', async () => {
    const m = await migrationOf('plat/auto-ok');
    const original = (
      await t.db.privileged.mutation.findFirstOrThrow({
        where: { migrationId: m.id, side: 'source', facetKey: 'repository-settings' },
        orderBy: { seq: 'asc' },
      })
    ).before as { description: string };
    const { runId, result } = await perform(m.id, 'undo_source_read_only');
    expect(result).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect((await stepStatuses(runId))['source.read-only.undo']).toBe('succeeded');
    expect(pushLock('auto-ok')).toEqual([]);
    expect(sourceRepo('auto-ok').description).toBe(original.description);
    const rows = await t.db.privileged.mutation.findMany({
      where: { migrationId: m.id, side: 'source' },
    });
    expect(rows.filter((r) => r.facetKey !== 'framework').every((r) => r.undoneAt !== null)).toBe(
      true,
    );
    const migration = await t.db.privileged.migration.findUniqueOrThrow({ where: { id: m.id } });
    expect(migration.sourceReadOnlyApplied).toBe(false);
    // The source is writable and unfiltered again: an Analysis sees what the source really has.
    await analyze(m.id);
    expect(((await desiredOf(m.id, 'branch-rules')) as { rules: unknown[] }).rules).toHaveLength(1);
  }, 240_000);

  it('[LIF-070] a second undo has nothing to revert and succeeds', async () => {
    const m = await migrationOf('plat/auto-ok');
    const { runId, result } = await perform(m.id, 'undo_source_read_only');
    expect(result).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect((await stepStatuses(runId))['source.read-only.undo']).toBe('succeeded');
  }, 120_000);

  it('[LIF-070] a source_read_only Run locks the source again, on request, and the identical state already there is not written again', async () => {
    const m = await migrationOf('plat/auto-ok');
    const { result } = await perform(m.id, 'source_read_only');
    expect(result).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect(pushLock('auto-ok')).toHaveLength(1);
    expect(sourceRepo('auto-ok').description).toMatch(/^\[MIGRATED → /);
    const migration = await t.db.privileged.migration.findUniqueOrThrow({ where: { id: m.id } });
    expect(migration.sourceReadOnlyApplied).toBe(true);
    const second = await perform(m.id, 'source_read_only');
    expect(second.result).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect(pushLock('auto-ok')).toHaveLength(1);
    const again = await t.db.privileged.mutation.findMany({
      where: { runId: second.runId, side: 'source' },
    });
    expect(
      again
        .filter((r) => r.facetKey !== 'framework')
        .every((r) => (r.resourceRef as { adopted?: boolean }).adopted === true),
    ).toBe(true);
  }, 240_000);

  it('[LIF-070] a restriction that was already on the source is adopted as pre-existing, still translated, and survives undo', async () => {
    const m = await migrationOf('plat/auto-ok');
    await perform(m.id, 'undo_source_read_only');
    await perform(m.id, 'undo_source_read_only');
    expect(pushLock('auto-ok')).toEqual([]);
    fakes.bitbucket.state.addBranchRestriction(WORLD_WORKSPACE, 'auto-ok', {
      kind: 'push',
      pattern: '*',
    });
    const applied = await perform(m.id, 'source_read_only');
    expect(applied.result).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect(pushLock('auto-ok')).toHaveLength(1);
    const restriction = await t.db.privileged.mutation.findFirstOrThrow({
      where: { runId: applied.runId, facetKey: 'branch-rules' },
    });
    expect(restriction.resourceRef).toMatchObject({ adopted: true, preexisting: true });
    // The customer's own freeze was there before the framework touched the source: it is not the
    // framework's lock, so it is translated as before (a resync mirrors the source).
    await analyze(m.id);
    const desired = (await desiredOf(m.id, 'branch-rules')) as {
      rules: { pattern: string; restrictPushes: unknown[] | null }[];
    };
    const frozen = desired.rules.filter((r) => r.pattern !== 'main');
    expect(desired.rules.map((r) => r.pattern)).toContain('main');
    expect(frozen).toHaveLength(1);
    expect(frozen[0]?.restrictPushes).toEqual([]);
    await perform(m.id, 'undo_source_read_only');
    expect(pushLock('auto-ok')).toHaveLength(1);
    expect(sourceRepo('auto-ok').description).not.toMatch(/^\[MIGRATED/);
  }, 240_000);
});

describe('a lock whose write could not be confirmed is still undoable (LIF-070, LIF-045)', () => {
  it('[LIF-070] the writes are found on the source and recorded, the Analysis does not translate them, and undo removes them and clears the flag', async () => {
    const m = await migrationOf('plat/auto-ok');
    // A clean source: the restriction the adopted test left there is removed by hand.
    const repo = sourceRepo('auto-ok');
    repo.branchRestrictions = repo.branchRestrictions.filter(
      (r) => !(r.kind === 'push' && r.pattern === '*'),
    );
    // And the earlier Runs' records of adopted state are retired, as a clean slate for this one.
    await t.db.privileged.mutation.updateMany({
      where: { migrationId: m.id, side: 'source', undoneAt: null },
      data: { undoneAt: new Date() },
    });
    faults.ambiguousLock = 'after';
    const { runId, result } = await perform(m.id, 'source_read_only');
    expect(result).toEqual({ outcome: 'finished', status: 'failed' });
    const step = await t.db.privileged.runStep.findFirstOrThrow({
      where: { runId, stepKey: 'source.read-only' },
    });
    expect(step.error).toMatchObject({ code: 'source-read-only.possibly-applied' });
    expect(pushLock('auto-ok')).toHaveLength(1);
    const recorded = await t.db.privileged.mutation.findMany({
      where: { runId, side: 'source', facetKey: { not: 'framework' } },
    });
    expect(
      recorded.map((r) => (r.resourceRef as { possiblyFramework?: boolean }).possiblyFramework),
    ).toEqual([true, true]);
    // The lock is recorded, so the Analysis leaves it out.
    await analyze(m.id);
    expect(
      ((await desiredOf(m.id, 'branch-rules')) as { rules: { pattern: string }[] }).rules.map(
        (r) => r.pattern,
      ),
    ).toEqual(['main']);
    const undo = await perform(m.id, 'undo_source_read_only');
    expect(undo.result).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect(pushLock('auto-ok')).toEqual([]);
    expect(sourceRepo('auto-ok').description).not.toMatch(/^\[MIGRATED/);
    const migration = await t.db.privileged.migration.findUniqueOrThrow({ where: { id: m.id } });
    expect(migration.sourceReadOnlyApplied).toBe(false);
  }, 240_000);
});

describe("a crash before the write never claims the customer's own state (LIF-070, ADR-0222)", () => {
  async function crashBeforeWrite(): Promise<string> {
    const m = await migrationOf('plat/auto-ok');
    const repo = sourceRepo('auto-ok');
    repo.branchRestrictions = repo.branchRestrictions.filter(
      (r) => !(r.kind === 'push' && r.pattern === '*'),
    );
    repo.description = repo.description.replace(/^\[MIGRATED[^\]]*\] /, '');
    await t.db.privileged.mutation.updateMany({
      where: { migrationId: m.id, side: 'source', undoneAt: null },
      data: { undoneAt: new Date() },
    });
    return m.id;
  }

  async function lockCrashes(migrationId: string): Promise<string> {
    faults.ambiguousLock = 'before';
    const { runId, result } = await perform(migrationId, 'source_read_only');
    expect(result).toEqual({ outcome: 'finished', status: 'failed' });
    const step = await t.db.privileged.runStep.findFirstOrThrow({
      where: { runId, stepKey: 'source.read-only' },
    });
    expect(step.error).toMatchObject({ code: 'source-read-only.possibly-applied' });
    // Nothing the customer had was recorded as the framework's.
    const claimed = (
      await t.db.privileged.mutation.findMany({ where: { runId, side: 'source' } })
    ).filter((r) => (r.resourceRef as { possiblyFramework?: boolean }).possiblyFramework === true);
    expect(claimed).toEqual([]);
    return runId;
  }

  it('[LIF-070] a user-less push restriction on * that was there before is still there after the crash and after undo', async () => {
    const id = await crashBeforeWrite();
    fakes.bitbucket.state.addBranchRestriction(WORLD_WORKSPACE, 'auto-ok', {
      kind: 'push',
      pattern: '*',
    });
    await lockCrashes(id);
    const undo = await perform(id, 'undo_source_read_only');
    expect(undo.result).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect(pushLock('auto-ok')).toHaveLength(1);
  }, 240_000);

  it('[LIF-070] a description that already carried a prefix is unchanged after the crash and after undo', async () => {
    const id = await crashBeforeWrite();
    const original = `[MIGRATED → https://other.example/x] ${sourceRepo('auto-ok').description}`;
    sourceRepo('auto-ok').description = original;
    await lockCrashes(id);
    const undo = await perform(id, 'undo_source_read_only');
    expect(undo.result).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect(sourceRepo('auto-ok').description).toBe(original);
    expect(pushLock('auto-ok')).toEqual([]);
  }, 240_000);

  it('[LIF-070] a lock over an original description that carried a prefix is undone to that original, and undo succeeds', async () => {
    const id = await crashBeforeWrite();
    const original = `[MIGRATED → https://other.example/x] ${sourceRepo('auto-ok').description}`;
    sourceRepo('auto-ok').description = original;
    const applied = await perform(id, 'source_read_only');
    expect(applied.result).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect(pushLock('auto-ok')).toHaveLength(1);
    const undo = await perform(id, 'undo_source_read_only');
    expect(undo.result).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect(pushLock('auto-ok')).toEqual([]);
    expect(sourceRepo('auto-ok').description).toBe(original);
    const migration = await t.db.privileged.migration.findUniqueOrThrow({ where: { id } });
    expect(migration.sourceReadOnlyApplied).toBe(false);
  }, 240_000);
});

describe('a crash after the writes, over an original that carried a prefix (LIF-070, ADR-0425)', () => {
  it('[LIF-070] the recovered description is recorded with the original from the baseline, and undo restores it exactly', async () => {
    const m = await migrationOf('plat/auto-ok');
    await cleanSource(m.id);
    const original = `[MIGRATED → https://old.example/x] ${sourceRepo('auto-ok').description}`;
    sourceRepo('auto-ok').description = original;
    faults.ambiguousLock = 'after';
    const { runId, result } = await perform(m.id, 'source_read_only');
    expect(result).toEqual({ outcome: 'finished', status: 'failed' });
    expect(sourceRepo('auto-ok').description).toMatch(/^\[MIGRATED → http:\/\/127/);
    const description = await t.db.privileged.mutation.findFirstOrThrow({
      where: { runId, side: 'source', facetKey: 'repository-settings' },
    });
    expect(description.before).toEqual({ description: original });
    const undo = await perform(m.id, 'undo_source_read_only');
    expect(undo.result).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect(sourceRepo('auto-ok').description).toBe(original);
    expect(pushLock('auto-ok')).toEqual([]);
  }, 240_000);
});

describe('an unsettled lock blocks target writes and is never translated (LIF-045, LIF-070)', () => {
  it('[LIF-045] a lock written but neither confirmed nor inspected blocks resync, is unverifiable in parity, and after it is settled a resync never copies it to the target', async () => {
    const m = await migrationOf('plat/auto-ok');
    await cleanSource(m.id);
    const original = sourceRepo('auto-ok').description;
    faults.ambiguousLock = 'after';
    faults.downAfterWrite = true;
    try {
      const { runId, result } = await perform(m.id, 'source_read_only');
      expect(result).toEqual({ outcome: 'finished', status: 'failed' });
      const step = await t.db.privileged.runStep.findFirstOrThrow({
        where: { runId, stepKey: 'source.read-only' },
      });
      expect(step.error).toMatchObject({ code: 'forbidden' });
      expect(pushLock('auto-ok')).toHaveLength(1);
      const blocked = await t.db.privileged.migration.findUniqueOrThrow({ where: { id: m.id } });
      expect(blocked.blockerCodes).toContain('branch-rules.source-lock-unsettled');
      expect(blocked.readiness).toBe('blocked');

      // No Run that writes the target starts.
      await expect(
        createRun(t.db.privileged, { migrationId: m.id, kind: 'resync', triggeredById: actorId }),
      ).rejects.toMatchObject({ code: 'run.readiness_required' });

      // The Parity Check cannot tell the lock apart: the Facets it writes are unverifiable.
      const verify = await perform(m.id, 'verify');
      expect(verify.result).toEqual({ outcome: 'finished', status: 'succeeded' });
      const parity = await t.db.privileged.parityResult.findMany({
        where: { migrationId: m.id, facetKey: { in: ['branch-rules', 'repository-settings'] } },
        orderBy: { checkedAt: 'desc' },
      });
      const latest = (key: string) => parity.find((p) => p.facetKey === key)?.status;
      expect(latest('branch-rules')).toBe('unverifiable');
      expect(latest('repository-settings')).toBe('unverifiable');

      // A scheduled Analysis does not translate the Facets it cannot tell apart.
      await analyze(m.id);
      expect(await desiredOf(m.id, 'branch-rules')).toBeUndefined();
    } finally {
      faults.inspectDown = undefined;
    }

    // A lock Run settles it: the lock is recorded (and so left out of reads), the blocker clears.
    const settle = await perform(m.id, 'source_read_only');
    expect(settle.result).toEqual({ outcome: 'finished', status: 'failed' });
    const settleStep = await t.db.privileged.runStep.findFirstOrThrow({
      where: { runId: settle.runId, stepKey: 'source.read-only' },
    });
    expect(settleStep.error).toMatchObject({ code: 'source-read-only.needs-manual-check' });
    const settled = await t.db.privileged.migration.findUniqueOrThrow({ where: { id: m.id } });
    expect(settled.blockerCodes).not.toContain('branch-rules.source-lock-unsettled');

    // The resync proceeds, and the target never receives a rule for every branch.
    const resync = await perform(m.id, 'resync');
    expect(resync.result).toEqual({ outcome: 'finished', status: 'succeeded' });
    const targetRules =
      fakes.github?.state.findRepo(ORG, 'plat-auto-ok')?.rules.map((r) => r.pattern) ?? [];
    expect(targetRules).toContain('main');
    expect(targetRules).not.toContain('*');
    expect(targetRules).not.toContain('**');

    // Undo removes what the framework wrote, and only that.
    const undo = await perform(m.id, 'undo_source_read_only');
    expect(undo.result).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect(pushLock('auto-ok')).toEqual([]);
    expect(sourceRepo('auto-ok').description).toBe(original);
  }, 300_000);
});

describe('the Run option skipSourceReadOnly (LIF-070)', () => {
  it('[LIF-070] leaves the source writable and the Step skipped', async () => {
    const m = await migrationOf('ops/wiki-issues');
    await analyze(m.id);
    const { runId, result } = await perform(m.id, 'migrate', {
      options: { skipSourceReadOnly: true },
    });
    expect(result).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect((await stepStatuses(runId))['source.read-only']).toBe('skipped');
    expect(pushLock('wiki-issues')).toEqual([]);
    expect(sourceRepo('wiki-issues').description).not.toMatch(/^\[MIGRATED/);
    const migration = await t.db.privileged.migration.findUniqueOrThrow({ where: { id: m.id } });
    expect(migration.sourceReadOnlyApplied).toBe(false);
  }, 240_000);

  it('[LIF-070] the option is refused for Run kinds that do not lock the source as a step', async () => {
    const m = await migrationOf('ops/wiki-issues');
    await expect(
      createRun(t.db.privileged, {
        migrationId: m.id,
        kind: 'source_read_only',
        triggeredById: actorId,
        options: { skipSourceReadOnly: true },
      }),
    ).rejects.toMatchObject({ code: 'run.options_invalid' });
  });
});
