/**
 * T-072: the Parity Check against the TST-012 fixture world. The real adapters (through the
 * registry) talk to the fake Bitbucket, GitHub and git server over loopback; Postgres is a
 * throw-away database. `plat/auto-ok` is migrated by hand with the adapters' own `apply` and the
 * git package (T-071 owns the migrate Steps), then the Parity Check runs against it.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  DriverContext,
  EndpointConnection,
  NamespaceRef,
  RepositoryRef,
} from '@git-migrator/adapter-sdk';
import { type Config, resolveConfig } from '@git-migrator/config';
import type { FieldDecision } from '@git-migrator/core';
import { hashConfig, syncConfig } from '@git-migrator/db';
import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import { resetWorld, startWorldFakes, WORLD_ROUTE, WORLD_WORKSPACE } from '@git-migrator/fixtures';
import { GitService } from '@git-migrator/git';
import {
  type AnalysisDeps,
  createAnalysisGitClient,
  createEndpointConnector,
  createMirrorLfsSource,
  createProviderEnvironment,
  type EndpointConnector,
  noGitClient,
  type ParityDeps,
  runAnalysis,
  runInventory,
  runParity,
} from '@git-migrator/jobs';
import { createLogger, createMetrics } from '@git-migrator/observability';
import { isolatedGitEnv, type RunningFakes, runGit } from '@git-migrator/provider-fakes';
import { QuotaLeases, QuotaService } from '@git-migrator/quota';
import { createBuiltinRegistry } from '@git-migrator/registry';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const PEM = readFileSync(join(here, '../../fixtures/fake-github-app.pem'), 'utf8');
const SOURCE = 'bb-src';
const TARGET = 'gh-dst';
const ROUTE = 'r-parity';
const log = createLogger({ level: 'silent' });
const registry = createBuiltinRegistry();
const shutdown = new AbortController();
const options = { shutdown: shutdown.signal, pool: 'interactive' as const };

let fakes: RunningFakes;
let t: TestDatabase;
let config: Config;
let connector: EndpointConnector;
let analysisDeps: AnalysisDeps;
let parityDeps: ParityDeps;
let scratch: string;
let migrationId: string;
let sourceRef: RepositoryRef;
let targetRef: RepositoryRef;
let targetNs: NamespaceRef;
let git: GitService;

const db = () => t.db.privileged;

const inventory = (endpointId: string) =>
  runInventory({ db: db(), appPool: t.db.pool, connector, registry, config, log }, endpointId, {
    shutdown: shutdown.signal,
  });

async function connect(endpointId: string): Promise<EndpointConnection> {
  return connector.connect(endpointId, { pool: 'interactive', signal: shutdown.signal });
}

beforeAll(async () => {
  t = await createTestDatabase('gm_t072i_');
  fakes = await startWorldFakes({ bitbucketPort: 0, githubPort: 0, gitPort: 0 });
  await resetWorld(fakes);
  fakes.git?.setTokens('source', ['fake-bitbucket-api-token']);
  const gh = fakes.github;
  if (!gh || !fakes.git) throw new Error('the fakes did not start');
  scratch = mkdtempSync(join(tmpdir(), 'gm-t072-'));
  const installationId = [...gh.state.installations.keys()][0] as number;
  const gitBase = fakes.git.baseUrl;
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
  await syncConfig(db(), {
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
    db: db(),
    recorders: createMetrics().recorders,
    logger: log,
    environment: 'test',
  });
  connector = createEndpointConnector({
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
  for (const pattern of WORLD_ROUTE.webhookAllowlist) {
    await db().webhookAllowlistEntry.create({ data: { routeId: ROUTE, pattern } });
  }
  const lsRemote = createAnalysisGitClient({ scratchDir: scratch });
  analysisDeps = {
    db: db(),
    appPool: t.db.pool,
    connector,
    registry,
    config,
    git: lsRemote,
    log,
  };
  parityDeps = {
    db: db(),
    appPool: t.db.pool,
    connector,
    registry,
    git: lsRemote,
    log,
    lfs: createMirrorLfsSource({ scratchRoot: scratch, log }),
  };
  git = new GitService({ quota: { acquire: async () => undefined }, scratchDir: scratch });
  await inventory(SOURCE);
  await inventory(TARGET);

  const repo = await db().repository.findFirstOrThrow({
    where: { endpointId: SOURCE, slug: 'auto-ok' },
    include: { namespace: true },
  });
  const migration = await db().migration.findFirstOrThrow({
    where: { routeId: ROUTE, sourceRepositoryId: repo.id },
  });
  migrationId = migration.id;
  sourceRef = {
    providerId: repo.providerId,
    namespace: { providerId: repo.namespace.providerId, slug: repo.namespace.slug },
    slug: repo.slug,
  };
  const ns = await db().namespace.findFirstOrThrow({ where: { endpointId: TARGET, slug: 'acme' } });
  targetNs = { providerId: ns.providerId, slug: ns.slug };
}, 180_000);

afterAll(async () => {
  await fakes?.close();
  await t?.drop();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}, 60_000);

/** What a migrate Run does to the target (T-071), done by hand with the adapters and git. */
async function migrateByHand(): Promise<void> {
  await runAnalysis(analysisDeps, migrationId, { shutdown: shutdown.signal, pool: 'interactive' });
  const m = await db().migration.findUniqueOrThrow({ where: { id: migrationId } });
  const analysis = await db().analysis.findUniqueOrThrow({
    where: { id: m.latestAnalysisId as string },
  });
  const translation = analysis.translation as unknown as {
    plannedTargetName: string;
    facets: Record<string, { desired: unknown; decisions: FieldDecision[] }>;
  };
  const targetConn = await connect(TARGET);
  const sourceConn = await connect(SOURCE);
  const created = await targetConn.repositories.create(targetNs, {
    name: translation.plannedTargetName,
    visibility: 'private',
    description: '',
  });
  targetRef = { providerId: created.providerId, namespace: targetNs, slug: created.slug };

  // Refs and LFS objects, with the git package and credentials through GIT_ASKPASS only.
  const dir = join(scratch, 'mirror');
  const from = {
    url: sourceConn.git.remoteUrl(sourceRef),
    credential: await sourceConn.git.credential(sourceRef),
  };
  const to = {
    url: targetConn.git.remoteUrl(targetRef),
    credential: await targetConn.git.credential(targetRef),
  };
  await git.mirror({ ...from, dir });
  await git.fetchLfs({ ...from, dir });
  await git.pushLfs({ ...to, dir });
  await git.pushRefs({ ...to, dir, defaultBranch: 'main' });

  const ctx: DriverContext = {
    http: targetConn.http,
    git: createAnalysisGitClient({ scratchDir: scratch }),
    logger: log as never,
    pool: 'interactive',
    signal: shutdown.signal,
  };
  const target = { scope: 'repository' as const, repository: targetRef, namespace: targetNs };
  for (const def of registry.facets.ordered()) {
    if (def.scope !== 'repository') continue;
    const driver = targetConn.facets[def.key as keyof typeof targetConn.facets];
    const desired = translation.facets[def.key];
    if (!driver?.apply || !desired) continue;
    const current = (await driver.read(ctx, target)).data;
    for await (const _record of driver.apply(
      ctx,
      target,
      desired.desired,
      current,
      desired.decisions,
    )) {
      // The Mutation ledger is T-070's; the target state is all this test needs.
    }
  }
  // The target Repository row, as the inventory of a migrate Run records it.
  await inventory(TARGET);
  const row = await db().repository.findFirstOrThrow({
    where: { endpointId: TARGET, slug: created.slug },
  });
  await db().migration.update({
    where: { id: migrationId },
    data: { targetRepositoryId: row.id, status: 'migrated', targetCreatedByFramework: true },
  });
}

const statuses = async () =>
  Object.fromEntries(
    (await db().parityResult.findMany({ where: { migrationId } })).map((r) => [
      r.facetKey,
      r.status,
    ]),
  );

describe('the Parity Check against the fixture world', () => {
  it('[LIF-060] a repository migrated with the adapters is equal in every Facet with the real adapters', async () => {
    await migrateByHand();
    const result = await runParity(parityDeps, migrationId, options);
    expect(result.skipped).toBeUndefined();
    const all = await statuses();
    const notEqual = Object.entries(all).filter(([, status]) => status !== 'equal');
    const detail = await db().parityResult.findMany({
      where: { migrationId, status: { not: 'equal' } },
    });
    expect(notEqual, JSON.stringify(detail.map((d) => [d.facetKey, d.diffs]))).toEqual([]);
    expect(Object.keys(all)).toEqual(
      expect.arrayContaining(['git-refs', 'repository-settings', 'deploy-keys', 'variables']),
    );
  }, 180_000);

  it('[LIF-061] with every Facet equal and no open task the Migration is verified', async () => {
    const m = await db().migration.findUniqueOrThrow({ where: { id: migrationId } });
    expect(await db().manualTask.count({ where: { migrationId, status: 'open' } })).toBe(0);
    expect(m.status).toBe('verified');
    expect(m.verifiedAt).not.toBeNull();
    expect(m.lastParityAt).not.toBeNull();
  });

  it('[FAC-GIT-005] an LFS object the target cannot serve makes git-refs different, and the verified Migration drifts', async () => {
    const dir = join(scratch, 'mirror');
    const objects = await git.listLfsObjects(dir);
    expect(objects.length).toBeGreaterThan(0);
    const wanted = objects[0] as { oid: string };
    const path = fakes.git?.lfsStore('target').objectPath(`acme/${targetRef.slug}`, wanted.oid);
    if (!path) throw new Error('no git server');
    const saved = await readFile(path);
    await rm(path);
    await runParity(parityDeps, migrationId, options);
    const row = await db().parityResult.findFirstOrThrow({
      where: { migrationId, facetKey: 'git-refs' },
    });
    expect(row.status).toBe('different');
    expect(row.diffs).toEqual([{ path: '/lfs/oids', source: [wanted.oid], target: [] }]);
    expect(await db().migration.findUniqueOrThrow({ where: { id: migrationId } })).toMatchObject({
      status: 'drifted',
      statusBeforeDrift: 'verified',
    });

    // The object comes back (a re-push): parity is equal again and the status returns (LIF-065).
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, saved);
    await runParity(parityDeps, migrationId, options);
    expect((await statuses())['git-refs']).toBe('equal');
    expect((await db().migration.findUniqueOrThrow({ where: { id: migrationId } })).status).toBe(
      'verified',
    );
  }, 120_000);

  it("[LIF-063] a framework branch on the target is subtracted by the Route's framework_mutation record", async () => {
    const targetConn = await connect(TARGET);
    const dir = join(scratch, 'mirror');
    const to = {
      url: targetConn.git.remoteUrl(targetRef),
      credential: await targetConn.git.credential(targetRef),
    };
    // A branch under git-migrator/ on the target (a Change Request branch, LIF-047).
    await runGit(['branch', 'git-migrator/code-ownership', 'main'], {
      cwd: dir,
      env: isolatedGitEnv(scratch),
    });
    await git.pushRefs({ ...to, dir, defaultBranch: 'main' });
    // FAC-GIT-007: config sync records the system framework_mutation of the Route.
    const system = await db().expectedDifference.findFirstOrThrow({
      where: {
        routeId: ROUTE,
        facetKey: 'git-refs',
        reason: 'framework_mutation',
        revokedAt: null,
      },
    });
    expect(system.path).toBe('/refs[name=refs/heads/git-migrator/*]');
    await runParity(parityDeps, migrationId, options);
    expect((await statuses())['git-refs']).toBe('equal');
    const stored = await db().parityResult.findFirstOrThrow({
      where: { migrationId, facetKey: 'git-refs' },
    });
    const hidden = stored.excluded as {
      expectedDifferenceId: string;
      reason: string;
      path: string;
    }[];
    expect(hidden.length).toBeGreaterThan(0);
    for (const h of hidden) {
      expect(h).toMatchObject({ expectedDifferenceId: system.id, reason: 'framework_mutation' });
      expect(h.path).toContain('refs/heads/git-migrator/code-ownership');
    }
    // Without the record the same branch is a difference.
    await db().expectedDifference.update({
      where: { id: system.id },
      data: { revokedAt: new Date() },
    });
    await runParity(parityDeps, migrationId, options);
    expect((await statuses())['git-refs']).toBe('different');
    await db().expectedDifference.update({ where: { id: system.id }, data: { revokedAt: null } });
    await runParity(parityDeps, migrationId, options);
    expect((await statuses())['git-refs']).toBe('equal');
  }, 120_000);

  it('[FAC-GIT-006] after the source is read-only, extra target branches are not drift, and a source branch missing on the target still is', async () => {
    await db().migration.update({
      where: { id: migrationId },
      data: { sourceReadOnlyApplied: true },
    });
    // Revoke the framework record: only containment can make the extra branch acceptable now.
    await db().expectedDifference.updateMany({
      where: { routeId: ROUTE, facetKey: 'git-refs', reason: 'framework_mutation' },
      data: { revokedAt: new Date() },
    });
    await runParity(parityDeps, migrationId, options);
    expect((await statuses())['git-refs']).toBe('equal');
    const row = await db().parityResult.findFirstOrThrow({
      where: { migrationId, facetKey: 'git-refs' },
    });
    expect(row.excluded).toEqual([]);

    const targetConn = await connect(TARGET);
    await git.deleteRefs({
      dir: join(scratch, 'mirror'),
      url: targetConn.git.remoteUrl(targetRef),
      credential: await targetConn.git.credential(targetRef),
      refs: ['refs/heads/develop'],
    });
    await runParity(parityDeps, migrationId, options);
    const after = await db().parityResult.findFirstOrThrow({
      where: { migrationId, facetKey: 'git-refs' },
    });
    expect(after.status).toBe('different');
    expect((after.diffs as { path: string }[]).map((d) => d.path).join()).toContain(
      'refs/heads/develop',
    );
  }, 120_000);
});
