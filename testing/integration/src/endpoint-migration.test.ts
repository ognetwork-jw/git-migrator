/**
 * T-086: the endpoint migration (LIF-080, LIF-081) against the TST-012 fixture world. The real
 * adapters (through the registry) and the real Run executor talk to the fake Bitbucket and the
 * fake GitHub over loopback; Postgres is a throw-away database (TST-006).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdapterError, type EndpointConnection } from '@git-migrator/adapter-sdk';
import { type Config, resolveConfig } from '@git-migrator/config';
import { hashConfig, routeMappingLockKey, syncConfig } from '@git-migrator/db';
import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import {
  resetWorld,
  startWorldFakes,
  WORLD_MEMBERS,
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
  createVerifyStep,
  type EndpointConnector,
  type ExecuteResult,
  executeRun,
  MigrationLinks,
  type MigrationServices,
  MirrorRegistry,
  noGitClient,
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const PEM = readFileSync(join(here, '../../fixtures/fake-github-app.pem'), 'utf8');
const SOURCE = 'bb-src';
const TARGET = 'gh-dst';
const ROUTE = 'r-endpoint';
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

/** Faults the target connection can be told to inject once. */
const faults: { loseTeamRecords?: boolean; foreignTeam?: string } = {};

const runs: RunEnqueuerLike = { async enqueueRun() {} };

const analyze = (migrationId: string) =>
  runAnalysis(analysisDeps, migrationId, { shutdown: shutdown.signal, pool: 'interactive' });

const endpointMigration = () =>
  t.db.privileged.migration.findFirstOrThrow({ where: { routeId: ROUTE, scope: 'endpoint' } });

async function withGrants() {
  const repo = await t.db.privileged.repository.findFirstOrThrow({
    where: { endpointId: SOURCE, slug: 'with-grants' },
  });
  return t.db.privileged.migration.findFirstOrThrow({
    where: { routeId: ROUTE, sourceRepositoryId: repo.id },
  });
}

async function findingCodes(migrationId: string): Promise<string[]> {
  const m = await t.db.privileged.migration.findUniqueOrThrow({ where: { id: migrationId } });
  const items = await t.db.privileged.planItem.findMany({
    where: { analysisId: m.latestAnalysisId as string, kind: { not: 'step' } },
  });
  return items.map((i) => i.code).sort();
}

async function perform(
  migrationId: string,
  kind: 'run_anyway' | 'rollback' = 'run_anyway',
  /** Runs after the Run was admitted and before it executes. */
  admitted?: (runId: string) => Promise<void>,
): Promise<{ runId: string; result: ExecuteResult }> {
  const created = await createRun(t.db.privileged, {
    migrationId,
    kind,
    triggeredById: actorId,
  });
  await admitted?.(created.runId);
  const registry = new RunStepRegistry<MigrationServices>();
  registerMigrationSteps(registry, services);
  const result = await withRunScratch(scratch, created.runId, (scratchDir) =>
    executeRun(
      {
        db: t.db.privileged,
        pool: t.db.pool,
        log,
        registry,
        runs,
        services,
        workerId: 'worker-int',
        analysis: createRunAnalysisPort(analysisDeps, analyzeForRun),
        sleep: async () => undefined,
      },
      created.runId,
      { shutdown: shutdown.signal, scratchDir },
    ),
  );
  return { runId: created.runId, result };
}

const githubWrites = (): string[] =>
  (fakes.github?.requests() ?? [])
    .filter((r) => r.write)
    .filter((r) => !/^\/app\/installations\/\d+\/access_tokens$/.test(r.path))
    .map((r) => `${r.method} ${r.path}`);

interface OrgState {
  login: string;
  members: Record<string, string>;
  invitations: unknown[];
  teams: { slug: string; members: Record<string, unknown> }[];
}
const orgState = (): OrgState => {
  const snap = fakes.github?.state.snapshot() as unknown as { orgs: OrgState[] };
  return snap.orgs.find((o) => o.login === ORG) as OrgState;
};
const teamSlugs = (): string[] =>
  orgState()
    .teams.map((x) => x.slug)
    .sort();

beforeAll(async () => {
  t = await createTestDatabase('gm_t086_');
  fakes = await startWorldFakes({ bitbucketPort: 0, githubPort: 0, gitPort: 0 });
  await resetWorld(fakes);
  fakes.git?.setTokens('source', ['fake-bitbucket-api-token']);
  const gh = fakes.github;
  if (!gh) throw new Error('the fake GitHub did not start');
  gh.state.config = {
    ...gh.state.config,
    secondary: { contentCreationPerMinute: null, contentCreationPerHour: null },
    primary: { limits: { core: 10_000_000, graphql: 10_000_000 } },
  };
  scratch = mkdtempSync(join(tmpdir(), 'gm-t086-'));
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
  const connector: EndpointConnector = {
    async connect(endpointId, options) {
      const connection = await real.connect(endpointId, options);
      if (endpointId === TARGET) {
        const teams = connection.facets.teams;
        if (!teams?.apply) return connection;
        const apply = teams.apply.bind(teams);
        return {
          ...connection,
          facets: {
            ...connection.facets,
            teams: {
              ...teams,
              async *apply(...args: Parameters<typeof apply>) {
                if (!faults.loseTeamRecords) {
                  yield* apply(...args);
                  return;
                }
                faults.loseTeamRecords = false;
                // The write happens; the process dies before its records are returned.
                for await (const _record of apply(...args)) {
                  // dropped
                }
                throw new AdapterError({
                  code: 'transient',
                  provider: 'github',
                  message: 'the connection dropped',
                  retryable: true,
                });
              },
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
  analysisDeps = {
    db: t.db.privileged,
    appPool: t.db.pool,
    connector,
    registry,
    config,
    git: createAnalysisGitClient({ scratchDir: scratch }),
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
    mirrors,
    // Step `verify`, wired as the worker does (LIF-081).
    extraSteps: new Map([
      [
        'verify',
        createVerifyStep<MigrationServices>({
          db: t.db.privileged,
          appPool: t.db.pool,
          connector,
          registry,
          git: analysisDeps.git,
          log,
        }),
      ],
    ]),
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
  for (const endpointId of [SOURCE, TARGET]) {
    await runInventory(
      { db: t.db.privileged, appPool: t.db.pool, connector, registry, config, log },
      endpointId,
      { shutdown: shutdown.signal },
    );
  }
}, 180_000);

afterAll(async () => {
  await fakes?.close();
  await t?.drop();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}, 60_000);

describe('the endpoint migration against the fixture world', () => {
  it('[LIF-080] creates the missing team, confirms its Group Mapping and clears access-control.team-missing', async () => {
    const repo = await withGrants();
    await analyze(repo.id);
    expect(await findingCodes(repo.id)).toContain('access-control.team-missing');
    expect(teamSlugs()).toEqual([]);

    const endpoint = await endpointMigration();
    await analyze(endpoint.id);
    fakes.github?.clearRequests();
    const { runId, result } = await perform(endpoint.id);
    expect(result).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect(teamSlugs()).toEqual(['platform-team']);

    // [LIF-081] the Steps of the Plan, in its order, then the re-analysis.
    const steps = await t.db.privileged.runStep.findMany({ where: { runId } });
    const order = steps.map((s) => s.stepKey);
    expect(order.indexOf('facet.teams.apply')).toBeLessThan(
      order.indexOf('facet.org-variables.apply'),
    );
    // [LIF-081] step `verify` runs for the endpoint Run and stores a ParityResult.
    expect(order).toContain('verify');
    expect(steps.find((s) => s.stepKey === 'verify')?.status).toBe('succeeded');
    expect(
      await t.db.privileged.parityResult.count({ where: { migrationId: endpoint.id } }),
    ).toBeGreaterThan(0);
    expect(order.at(-1)).toBe('analysis.refresh');
    expect(steps.find((s) => s.stepKey === 'facet.teams.apply')?.status).toBe('succeeded');
    // Members are never written by the endpoint Run (AUTH-061): the Plan has no step for them.
    expect(order).not.toContain('facet.members.apply');

    // The team is a recorded create, so rollback can undo it (LIF-077).
    const ledger = await t.db.privileged.mutation.findMany({
      where: { runId, facetKey: 'teams', action: 'create' },
    });
    expect(ledger.length).toBeGreaterThan(0);
    expect(ledger.every((l) => l.state === 'recorded' && l.side === 'target')).toBe(true);

    // AUTH-050: the Group Mapping is confirmed with the target Group.
    const mapping = await t.db.privileged.groupMapping.findFirstOrThrow({
      where: { routeId: ROUTE, plannedSlug: 'platform-team' },
      include: { targetGroup: true },
    });
    expect(mapping.status).toBe('confirmed');
    expect(mapping.targetGroup?.slug).toBe('platform-team');

    // The repository Migration was marked stale by the Run, and its next Analysis is unblocked.
    await analyze(repo.id);
    const after = await findingCodes(repo.id);
    expect(after).not.toContain('access-control.team-missing');
    const row = await t.db.privileged.migration.findUniqueOrThrow({ where: { id: repo.id } });
    expect(row.readiness).not.toBe('blocked');
  }, 240_000);

  it('[LIF-077] rolling the endpoint Run back deletes the team it created, returns its Group Mapping to unmapped and stales the Route’s Analyses, so the blocker comes back', async () => {
    const endpoint = await endpointMigration();
    const repo = await withGrants();
    const mapping = await t.db.privileged.groupMapping.findFirstOrThrow({
      where: { routeId: ROUTE, plannedSlug: 'platform-team' },
    });
    expect(mapping.status).toBe('confirmed');
    expect(teamSlugs()).toEqual(['platform-team']);

    const { runId, result } = await perform(endpoint.id, 'rollback');
    expect(result).toEqual({ outcome: 'finished', status: 'succeeded' });
    const steps = Object.fromEntries(
      (await t.db.privileged.runStep.findMany({ where: { runId } })).map((s) => [
        s.stepKey,
        s.status,
      ]),
    );
    expect(steps).toEqual({
      'rollback.target': 'succeeded',
      'rollback.group-mappings': 'succeeded',
      'rollback.settle': 'succeeded',
    });
    // The team is gone from the target, and the Group Mapping that pointed at it is open again.
    expect(teamSlugs()).toEqual([]);
    const after = await t.db.privileged.groupMapping.findUniqueOrThrow({
      where: { id: mapping.id },
    });
    expect(after).toMatchObject({ status: 'unmapped', targetGroupId: null });
    const audit = await t.db.privileged.auditEvent.findMany({
      where: { action: 'group-mapping.unmap', subjectId: mapping.id },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorId).toBeNull();
    expect(audit[0]?.data).toMatchObject({ origin: 'run', reason: 'rollback', runId });
    expect((await endpointMigration()).status).toBe('rolled_back');
    // Every record of the Run is undone, and the Route's Analyses are stale.
    expect(
      await t.db.privileged.mutation.count({
        where: { migrationId: endpoint.id, facetKey: 'teams', undoneAt: null, action: 'create' },
      }),
    ).toBe(0);
    const stale = await t.db.privileged.migration.findUniqueOrThrow({ where: { id: repo.id } });
    expect(stale.analysisStaleAt).not.toBeNull();
    // The repository's next Analysis finds the team missing again (FAC-ACL-004).
    await analyze(repo.id);
    expect(await findingCodes(repo.id)).toContain('access-control.team-missing');

    // The endpoint migration can run again: the team and the mapping come back.
    await analyze(endpoint.id);
    const again = await perform(endpoint.id);
    expect(again.result).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect(teamSlugs()).toEqual(['platform-team']);
    expect(
      (await t.db.privileged.groupMapping.findUniqueOrThrow({ where: { id: mapping.id } })).status,
    ).toBe('confirmed');
  }, 400_000);

  it('[LIF-077] a grant written after the rollback was admitted keeps the team and its memberships: the Step leaves them and reports them, and a later rollback deletes them', async () => {
    const endpoint = await endpointMigration();
    const repo = await withGrants();
    expect(teamSlugs()).toEqual(['platform-team']);
    const openTeamRecords = async (kind: string) =>
      (
        await t.db.privileged.mutation.findMany({
          where: { migrationId: endpoint.id, facetKey: 'teams', undoneAt: null },
          orderBy: { seq: 'desc' },
        })
      ).filter((m) => (m.resourceRef as { kind?: string }).kind === kind);
    const [team] = await openTeamRecords('team');
    if (!team) throw new Error('no team record');
    const teamId = String((team.resourceRef as { id: string }).id);
    const memberships = (await openTeamRecords('team-membership')).length;
    expect(memberships).toBeGreaterThan(0);
    const membersBefore = orgState().teams[0]?.members;

    let grantId = '';
    const { runId, result } = await perform(endpoint.id, 'rollback', async () => {
      // The admission guard saw no grant; a repository Migration of the Route writes one now.
      const run = await t.db.privileged.run.create({
        data: {
          migrationId: repo.id,
          kind: 'migrate',
          triggeredById: actorId,
          options: {},
          status: 'succeeded',
        },
      });
      grantId = (
        await t.db.privileged.mutation.create({
          data: {
            migrationId: repo.id,
            runId: run.id,
            side: 'target',
            facetKey: 'access-control',
            resourceRef: { kind: 'access-grant', principal: `group:${teamId}` },
            paths: [],
            action: 'create',
            state: 'recorded',
          },
        })
      ).id;
    });
    expect(result).toEqual({ outcome: 'finished', status: 'failed' });
    const step = await t.db.privileged.runStep.findFirstOrThrow({
      where: { runId, stepKey: 'rollback.target' },
    });
    expect(step.error).toMatchObject({ code: 'rollback.left-in-place' });
    // Neither the team nor any of its members was removed.
    expect(teamSlugs()).toEqual(['platform-team']);
    expect(orgState().teams[0]?.members).toEqual(membersBefore);
    expect(await openTeamRecords('team-membership')).toHaveLength(memberships);
    expect(await openTeamRecords('team')).toHaveLength(1);
    const task = await t.db.privileged.manualTask.findFirstOrThrow({
      where: {
        migrationId: endpoint.id,
        code: 'repository-settings.left-in-place',
        status: 'open',
      },
    });
    expect(task.params).toEqual({
      details: [
        ...Array.from({ length: memberships }, () => ({
          kind: 'group-membership-in-use',
          name: 'platform-team',
        })),
        { kind: 'group-in-use', name: 'platform-team' },
      ],
    });

    // Once the grant is reverted, the team is free: a later rollback deletes it.
    await t.db.privileged.mutation.update({
      where: { id: grantId },
      data: { undoneAt: new Date() },
    });
    const again = await perform(endpoint.id, 'rollback');
    expect(again.result).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect(teamSlugs()).toEqual([]);
    // The endpoint migration runs again, as the tests below expect.
    await analyze(endpoint.id);
    expect((await perform(endpoint.id)).result).toEqual({
      outcome: 'finished',
      status: 'succeeded',
    });
    expect(teamSlugs()).toEqual(['platform-team']);
  }, 400_000);

  it('[LIF-080] invites nobody: no invitation is posted and only organization members join teams', () => {
    const writes = githubWrites();
    expect(writes.filter((w) => /invitations/.test(w))).toEqual([]);
    const org = orgState();
    const members = new Set(Object.keys(org.members).map((m) => m.toLowerCase()));
    for (const team of org.teams) {
      for (const login of Object.keys(team.members))
        expect(members.has(login.toLowerCase())).toBe(true);
    }
    expect(org.invitations).toEqual([]);
  });

  it('[LIF-081] a second Run changes nothing on the target', async () => {
    const endpoint = await endpointMigration();
    await analyze(endpoint.id);
    fakes.github?.clearRequests();
    const { result } = await perform(endpoint.id);
    expect(result.outcome).toBe('finished');
    expect(githubWrites().filter((w) => w.startsWith('POST /orgs/acme/teams'))).toEqual([]);
    expect(teamSlugs()).toEqual(['platform-team']);
  }, 240_000);

  it('[LIF-080] settling waits for the Route mapping lock the mapping API holds', async () => {
    const endpoint = await endpointMigration();
    await analyze(endpoint.id);
    const holder = await t.db.pool.connect();
    let finished = false;
    try {
      await holder.query('BEGIN');
      // The key and hash are the helpers' own (`advisoryXactLock(routeMappingLockKey(...))`).
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [
        routeMappingLockKey(ROUTE),
      ]);
      const run = perform(endpoint.id).then((r) => {
        finished = true;
        return r;
      });
      await new Promise((resolve) => setTimeout(resolve, 3000));
      expect(finished).toBe(false);
      await holder.query('COMMIT');
      expect((await run).result.outcome).toBe('finished');
    } finally {
      holder.release();
    }
  }, 240_000);

  it('[LIF-080] a team written just before a crash is settled after the resume, and a foreign team of the same slug is not claimed', async () => {
    // A new team the framework creates for a second group, whose write loses its records.
    const org = fakes.github?.state.orgs.get(ORG);
    if (!org) throw new Error('no org');
    org.teams.length = 0;
    const mapping = await t.db.privileged.groupMapping.findFirstOrThrow({
      where: { routeId: ROUTE, plannedSlug: 'platform-team' },
    });
    await t.db.privileged.groupMapping.update({
      where: { id: mapping.id },
      data: { status: 'unmapped', targetGroupId: null },
    });
    // Earlier ledger rows prove an earlier creation: forget them, so only the crash counts.
    await t.db.privileged
      .$executeRaw`UPDATE app.mutation SET undone_at = now() WHERE facet_key = 'teams'`;
    const endpoint = await endpointMigration();
    await analyze(endpoint.id);
    faults.loseTeamRecords = true;
    const { result } = await perform(endpoint.id);
    expect(result.outcome).toBe('finished');
    expect(teamSlugs()).toEqual(['platform-team']);
    const after = await t.db.privileged.groupMapping.findUniqueOrThrow({
      where: { id: mapping.id },
    });
    expect(after.status).toBe('confirmed');
    expect(after.targetGroupId).not.toBeNull();
  }, 240_000);

  it('[LIF-080] a team that exists but was not created by the framework is never confirmed', async () => {
    const org = fakes.github?.state.orgs.get(ORG);
    if (!org) throw new Error('no org');
    const mapping = await t.db.privileged.groupMapping.findFirstOrThrow({
      where: { routeId: ROUTE, plannedSlug: 'platform-team' },
    });
    await t.db.privileged.groupMapping.update({
      where: { id: mapping.id },
      data: { status: 'unmapped', targetGroupId: null },
    });
    await t.db.privileged
      .$executeRaw`UPDATE app.mutation SET undone_at = now() WHERE facet_key = 'teams'`;
    const endpoint = await endpointMigration();
    await analyze(endpoint.id);
    const { result } = await perform(endpoint.id);
    expect(result.outcome).toBe('finished');
    const after = await t.db.privileged.groupMapping.findUniqueOrThrow({
      where: { id: mapping.id },
    });
    expect(after.status).not.toBe('confirmed');
  }, 240_000);

  it('[LIF-080] [FAC-WEB-002] no ledger row of an endpoint or repository webhook write holds a URL credential', async () => {
    const rows = await t.db.privileged.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM app.mutation
       WHERE facet_key IN ('webhooks', 'org-webhooks')
         AND (before::text ~* '://[^/"]*@' OR after::text ~* '://[^/"]*@'
              OR resource_ref::text ~* '://[^/"]*@' OR resource_ref::text ~* '(token|secret|key)=')`;
    expect(Number(rows[0]?.n ?? 0)).toBe(0);
  });
});
