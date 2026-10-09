import { sha256Hex } from '@git-migrator/core';
import { markAnalysesStale } from '@git-migrator/db';
import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import { createLogger } from '@git-migrator/observability';
import { createBuiltinRegistry } from '@git-migrator/registry';
import { UnrecoverableError } from 'bullmq';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EndpointConnector } from '../inventory/connector.ts';
import {
  type AnalysisDeps,
  AnalysisError,
  AnalysisInterruptedError,
  analysisHandlers,
  runAnalysis,
} from './analysis.ts';
import { analyzeForRun } from './fresh.ts';

const log = createLogger({ level: 'silent' });
const registry = createBuiltinRegistry();
const never = new AbortController();

type Doc = Record<string, unknown>;
interface StubRead {
  data: Doc;
  unreadable?: string[];
  warnings?: { code: string; paths: string[]; params: Record<string, unknown> }[];
  attachments?: Record<string, string>;
  capabilities?: Record<string, { kind: string }>;
  /** Provider calls the driver makes through `ctx.http`. */
  calls?: number;
}

let t: TestDatabase;
let n = 0;
const reads: Record<string, StubRead> = {};
let live: { name: string; empty: boolean } | null = null;
let connects = 0;

const NAMING_LIMITS = { maxLength: 100, pattern: /^[A-Za-z0-9._-]+$/, caseInsensitiveUnique: true };

/** A connection that answers only what the Analysis asks: facet reads and the target lookup. */
function stubConnection(side: 'source' | 'target') {
  const facets: Record<string, unknown> = {};
  if (side === 'source') {
    for (const key of Object.keys(reads)) {
      facets[key] = {
        async read(ctx: { http: { request(r: unknown): Promise<unknown> } }) {
          const r = reads[key] as StubRead;
          for (let i = 0; i < (r.calls ?? 0); i++) await ctx.http.request({ path: '/x' });
          return {
            data: r.data,
            unreadable: r.unreadable ?? [],
            warnings: r.warnings ?? [],
            rawResponseIds: [],
            ...(r.attachments ? { attachments: r.attachments } : {}),
            ...(r.capabilities ? { capabilities: r.capabilities } : {}),
          };
        },
      };
    }
  }
  return {
    facets,
    http: { request: async () => ({ status: 200, body: {} }) },
    limits: { repositoryName: NAMING_LIMITS, hiddenRefPrefixes: [] },
    inventory: {
      async listGroups() {
        return {
          items: liveTeams.map((x) => ({ ...x, name: x.slug, memberProviderIds: [] })),
        };
      },
      async getRepository() {
        return null;
      },
      async findRepository(_ns: unknown, name: string) {
        return live && live.name.toLowerCase() === name.toLowerCase()
          ? { providerId: 'live-1', slug: live.name, name: live.name }
          : null;
      },
    },
    repositories: {
      async isEmpty() {
        return live?.empty ?? true;
      },
    },
  };
}

/** The teams the stub target lists (ADR-0435: a mapping is live by provider id). */
let liveTeams: { providerId: string; slug: string }[] = [
  { providerId: '777', slug: 'platform-team' },
];

const connector: EndpointConnector = {
  async connect(endpointId) {
    connects++;
    return stubConnection(endpointId.startsWith('src') ? 'source' : 'target') as never;
  },
};

let deps: AnalysisDeps;
let events: string[] = [];
let listener: pg.Client;

interface World {
  routeId: string;
  sourceEndpointId: string;
  targetEndpointId: string;
  actorId: string;
  sourceNamespaceId: string;
}

async function seedWorld(policies: { acceptLossy?: string[] } = {}): Promise<World> {
  const db = t.db.privileged;
  const k = ++n;
  const actor = await db.actor.create({
    data: { kind: 'service', role: 'operator', displayName: `t${k}`, email: `t${k}@test.local` },
  });
  const endpoint = (id: string, providerType: string) =>
    db.endpoint.create({
      data: {
        id,
        providerType,
        displayName: id,
        baseUrl: `http://${id}.test`,
        status: 'active',
        configHash: 'h',
      },
    });
  const source = await endpoint(`src-${k}`, 'bitbucket-cloud');
  const target = await endpoint(`dst-${k}`, 'github');
  const targetNs = await db.namespace.create({
    data: {
      endpointId: target.id,
      providerId: 'org',
      kind: 'organization',
      slug: 'acme',
      name: 'acme',
    },
  });
  const route = await db.route.create({
    data: {
      id: `route-${k}`,
      sourceEndpointId: source.id,
      targetEndpointId: target.id,
      targetNamespaceId: targetNs.id,
      targetNamespacePath: 'acme',
      policies,
      defaults: {},
      configHash: 'h',
      sourcePostAction: 'read-only',
    },
  });
  const ns = await db.namespace.create({
    data: {
      endpointId: source.id,
      providerId: `ns-${k}`,
      kind: 'project',
      slug: 'PLAT',
      key: 'PLAT',
      name: 'Plat',
    },
  });
  return {
    routeId: route.id,
    sourceEndpointId: source.id,
    targetEndpointId: target.id,
    actorId: actor.id,
    sourceNamespaceId: ns.id,
  };
}

let repoCounter = 0;
async function seedMigration(w: World, slug = `repo-${++repoCounter}`) {
  const db = t.db.privileged;
  const repo = await db.repository.create({
    data: {
      endpointId: w.sourceEndpointId,
      namespaceId: w.sourceNamespaceId,
      providerId: `uuid-${slug}-${w.routeId}`,
      slug,
      name: slug,
      fullPath: `acme/PLAT/${slug}`,
      isPrivate: true,
      lastInventoriedAt: new Date(),
    },
  });
  return db.migration.create({
    data: { scope: 'repository', routeId: w.routeId, sourceRepositoryId: repo.id },
  });
}

const analyze = (migrationId: string, extra: Partial<AnalysisDeps> = {}) =>
  runAnalysis({ ...deps, ...extra }, migrationId, { shutdown: never.signal, pool: 'background' });

const ADVISORY_RULE = {
  pattern: 'main',
  enforcement: 'advisory',
  restrictPushes: null,
  restrictMerges: null,
  blockForcePush: false,
  forcePushExempt: [],
  blockDeletion: false,
  deletionExempt: [],
  changeRequest: {
    minApprovals: 1,
    requireCodeOwnerApproval: false,
    dismissStaleApprovals: false,
    requireNoChangesRequested: false,
    requireTasksResolved: false,
    requireUpToDate: false,
    minPassingBuilds: 0,
  },
};

const setReads = (next: Record<string, StubRead>) => {
  for (const key of Object.keys(reads)) delete reads[key];
  Object.assign(reads, next);
};

const tasksOf = (migrationId: string) =>
  t.db.privileged.manualTask.findMany({ where: { migrationId }, orderBy: { code: 'asc' } });
const migrationRow = (id: string) => t.db.privileged.migration.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  t = await createTestDatabase('gm_t061u_');
  listener = new pg.Client({ connectionString: t.connectionString });
  await listener.connect();
  await listener.query('LISTEN gm_events');
  listener.on('notification', (m) => {
    if (m.payload) events.push(m.payload);
  });
  deps = {
    db: t.db.privileged,
    appPool: t.db.pool,
    connector,
    registry,
    config: {
      schedules: { analysisStaleAfter: 7 * 86_400_000, runRequiresAnalysisWithin: 86_400_000 },
    } as never,
    git: { lsRemote: async () => ({ refs: [] }) },
    log,
  };
}, 120_000);

afterAll(async () => {
  await listener?.end();
  await t?.drop();
}, 60_000);

describe('runAnalysis', () => {
  it('[LIF-020] stores Snapshots, an Analysis and PlanItems, sets readiness and the planned name, and applies analysis_completed', async () => {
    const w = await seedWorld();
    const m = await seedMigration(w, 'My_Repo');
    setReads({ 'deploy-keys': { data: { keys: [] } }, 'branch-rules': { data: { rules: [] } } });
    const before = Date.now();
    const result = await analyze(m.id);
    expect(result.analysisId).toBeTruthy();
    const row = await migrationRow(m.id);
    expect(row).toMatchObject({
      status: 'analyzed',
      readiness: 'ready',
      plannedTargetName: 'plat-my-repo',
      latestAnalysisId: result.analysisId,
      blockerCodes: [],
    });
    expect(row.analysisStaleAt?.getTime()).toBeGreaterThanOrEqual(before + 7 * 86_400_000 - 5_000);
    const analysis = await t.db.privileged.analysis.findUniqueOrThrow({
      where: { id: row.latestAnalysisId as string },
    });
    expect(analysis.sourceSnapshotIds).toHaveLength(2);
    const snapshots = await t.db.privileged.facetSnapshot.findMany({
      where: { id: { in: analysis.sourceSnapshotIds } },
    });
    expect(snapshots.map((s) => s.facetKey).sort()).toEqual(['branch-rules', 'deploy-keys']);
    expect(snapshots.every((s) => /^[0-9a-f]{64}$/.test(s.hash))).toBe(true);
    const steps = await t.db.privileged.planItem.findMany({
      where: { analysisId: analysis.id, kind: 'step' },
      orderBy: { order: 'asc' },
    });
    expect(steps[0]?.code).toBe('preflight');
  });

  it('[LIF-020][LIF-004] a blocker blocks, a run-origin blocker keeps blocking, and readiness counts follow', async () => {
    const w = await seedWorld();
    const m = await seedMigration(w);
    setReads({ 'deploy-keys': { data: { keys: [] } } });
    await t.db.privileged.migration.update({
      where: { id: m.id },
      data: {
        runBlockers: [
          { code: 'git-refs.blob-too-large', params: {}, at: new Date().toISOString() },
        ],
      },
    });
    await analyze(m.id);
    const row = await migrationRow(m.id);
    expect(row.readiness).toBe('blocked');
    expect(row.blockerCodes).toEqual(['git-refs.blob-too-large']);
    expect(row.readinessCounts).toMatchObject({ blockers: 1 });
  });

  it('[LIF-020] accept-lossy tasks: done stays done, an obsolete one is dismissed and reopens on recurrence, an operator dismissal stays', async () => {
    const w = await seedWorld({ acceptLossy: [] });
    const m = await seedMigration(w);
    setReads({ 'branch-rules': { data: { rules: [ADVISORY_RULE] } } });
    await analyze(m.id);
    let tasks = await tasksOf(m.id);
    expect(tasks.map((x) => [x.code, x.status, x.phase, x.origin])).toEqual([
      ['branch-rules.accept-lossy', 'open', 'pre', 'analysis'],
    ]);
    expect((await migrationRow(m.id)).readiness).toBe('needs_attention');

    // The finding stops: the open task becomes obsolete.
    setReads({ 'branch-rules': { data: { rules: [] } } });
    await analyze(m.id);
    tasks = await tasksOf(m.id);
    expect(tasks[0]).toMatchObject({ status: 'dismissed', note: 'obsolete', completedById: null });
    expect((await migrationRow(m.id)).readiness).toBe('ready');

    // Same uncovered path set again: reopened, not duplicated (T-012).
    setReads({ 'branch-rules': { data: { rules: [ADVISORY_RULE] } } });
    await analyze(m.id);
    tasks = await tasksOf(m.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ status: 'open', note: null, completedAt: null });

    // Done stays done; an obsolete pass does not touch it.
    await t.db.privileged.manualTask.update({
      where: { id: tasks[0]?.id as string },
      data: { status: 'done', completedAt: new Date() },
    });
    await analyze(m.id);
    setReads({ 'branch-rules': { data: { rules: [] } } });
    await analyze(m.id);
    expect((await tasksOf(m.id))[0]?.status).toBe('done');

    // An operator's dismissal is not reopened.
    await t.db.privileged.manualTask.update({
      where: { id: tasks[0]?.id as string },
      data: { status: 'dismissed', note: 'not needed', completedById: w.actorId },
    });
    setReads({ 'branch-rules': { data: { rules: [ADVISORY_RULE] } } });
    await analyze(m.id);
    expect((await tasksOf(m.id))[0]).toMatchObject({ status: 'dismissed', note: 'not needed' });
  });

  it('[LIF-020] a run-origin task with the same identity is never touched by an Analysis', async () => {
    const w = await seedWorld({ acceptLossy: [] });
    const m = await seedMigration(w);
    setReads({ 'branch-rules': { data: { rules: [ADVISORY_RULE] } } });
    await analyze(m.id);
    const [task] = await tasksOf(m.id);
    await t.db.privileged.manualTask.update({
      where: { id: task?.id as string },
      data: { origin: 'run' },
    });
    setReads({ 'branch-rules': { data: { rules: [] } } });
    await analyze(m.id);
    expect((await tasksOf(m.id))[0]).toMatchObject({ origin: 'run', status: 'open' });
  });

  it('[LIF-002] a Run that starts before the Analysis is stored is not overwritten', async () => {
    const w = await seedWorld();
    const m = await seedMigration(w);
    setReads({ 'deploy-keys': { data: { keys: [] } } });
    await analyze(m.id);
    const plannedBefore = (await migrationRow(m.id)).plannedTargetName;
    await t.db.privileged.namingRule.create({
      data: {
        routeId: w.routeId,
        scope: 'repository',
        scopeRef: (await migrationRow(m.id)).sourceRepositoryId as string,
        pipeline: { steps: [], template: 'x' },
        override: 'renamed',
      },
    });
    await analyze(m.id, {
      hooks: {
        async beforePersist(id) {
          await t.db.privileged.migration.update({
            where: { id },
            data: { status: 'running', statusBeforeRun: 'analyzed' },
          });
        },
      },
    });
    const row = await migrationRow(m.id);
    // analysis_completed leaves `running` alone and keeps the saved status the Run wrote; the
    // planned name a running Run was started with stays.
    expect(row).toMatchObject({
      status: 'running',
      statusBeforeRun: 'analyzed',
      readiness: 'ready',
      plannedTargetName: plannedBefore,
    });
  });

  describe('a change that lands after the Analysis read its inputs (LIF-021)', () => {
    const FUTURE = new Date('2099-01-01T00:00:00Z');
    const PAST = new Date('2020-01-01T00:00:00Z');
    const isStaleNow = async (id: string) =>
      ((await migrationRow(id)).analysisStaleAt as Date) <= new Date();
    // The real writers: the staleness trigger and the JS marker.
    const viaTrigger = (routeId: string, override: string) => async () => {
      await t.db.privileged.namingRule.create({
        data: {
          routeId,
          scope: 'repository',
          scopeRef: `ref-${override}`,
          pipeline: { steps: [], template: 'x' },
          override,
        },
      });
    };

    for (const offset of [0, 5_000, -5_000]) {
      it(`[LIF-021] markAnalysesStale during an Analysis (worker clock ${offset} ms off) keeps it stale, whatever the start value`, async () => {
        const skewed = () => new Date(Date.now() + offset);
        for (const start of [null, FUTURE, PAST]) {
          const w = await seedWorld();
          const m = await seedMigration(w);
          setReads({ 'deploy-keys': { data: { keys: [] } } });
          if (start !== null) {
            await analyze(m.id);
            await t.db.privileged.migration.update({
              where: { id: m.id },
              data: { analysisStaleAt: start },
            });
          }
          await analyze(m.id, {
            now: skewed,
            hooks: {
              beforePersist: async (id) =>
                void (await markAnalysesStale(t.db.privileged, { ids: [id] })),
            },
          });
          expect(await isStaleNow(m.id)).toBe(true);
        }
      });
    }

    it('[LIF-021] an edit while the Analysis of an already-stale Migration runs is not lost', async () => {
      const w = await seedWorld();
      const m = await seedMigration(w);
      setReads({ 'deploy-keys': { data: { keys: [] } } });
      await analyze(m.id);
      await t.db.privileged.migration.update({
        where: { id: m.id },
        data: { analysisStaleAt: PAST },
      });
      const repo = (await migrationRow(m.id)).sourceRepositoryId as string;
      const rule = (override: string) =>
        t.db.privileged.namingRule.upsert({
          where: {
            routeId_scope_scopeRef: { routeId: w.routeId, scope: 'repository', scopeRef: repo },
          },
          create: {
            routeId: w.routeId,
            scope: 'repository',
            scopeRef: repo,
            pipeline: { steps: [], template: 'x' },
            override,
          },
          update: { override },
        });
      await rule('first-name');
      await analyze(m.id, {
        hooks: { beforePersist: async () => void (await rule('second-name')) },
      });
      // The Analysis used the first name, and it is still stale, so the next one fixes it.
      expect((await migrationRow(m.id)).plannedTargetName).toBe('first-name');
      expect(await isStaleNow(m.id)).toBe(true);
      await analyze(m.id);
      expect((await migrationRow(m.id)).plannedTargetName).toBe('second-name');
    });

    it('[LIF-021] an edit to a Migration that was never analyzed is not lost', async () => {
      const w = await seedWorld();
      const m = await seedMigration(w);
      setReads({ 'deploy-keys': { data: { keys: [] } } });
      await analyze(m.id, { hooks: { beforePersist: viaTrigger(w.routeId, 'late-name') } });
      expect(await isStaleNow(m.id)).toBe(true);
    });

    it('[LIF-021] without a change the Analysis is fresh for the configured time', async () => {
      const w = await seedWorld();
      const m = await seedMigration(w);
      setReads({ 'deploy-keys': { data: { keys: [] } } });
      const at = new Date('2030-01-01T00:00:00Z');
      await analyze(m.id, { now: () => at });
      expect((await migrationRow(m.id)).analysisStaleAt?.getTime()).toBe(
        at.getTime() + 7 * 86_400_000,
      );
    });

    it('[LIF-021] a change in a transaction that is still open when the Analysis is stored is waited for, not lost', async () => {
      const w = await seedWorld();
      const m = await seedMigration(w);
      setReads({ 'deploy-keys': { data: { keys: [] } } });
      await analyze(m.id);
      const admin = new pg.Client({ connectionString: t.connectionString });
      await admin.connect();
      try {
        const adminPid = (await admin.query('SELECT pg_backend_pid() AS pid')).rows[0]
          .pid as number;
        await admin.query('BEGIN');
        await admin.query(
          `INSERT INTO app.webhook_allowlist_entry (id, route_id, pattern, updated_at)
           VALUES ('open-tx-entry', $1, 'https://x.test/**', now())`,
          [w.routeId],
        );
        const running = analyze(m.id);
        // Wait until a session is blocked by the open transaction (the Analysis, on the row lock).
        let blocked = false;
        for (let i = 0; i < 20_000 && !blocked; i++) {
          const waiting = await t.db.pool.query(
            'SELECT 1 FROM pg_stat_activity WHERE $1 = ANY (pg_blocking_pids(pid))',
            [adminPid],
          );
          blocked = (waiting.rowCount ?? 0) > 0;
          if (!blocked) await new Promise((r) => setImmediate(r));
        }
        if (!blocked) throw new Error('the Analysis never blocked on the open transaction');
        await admin.query('COMMIT');
        await running;
      } finally {
        await admin.end();
      }
      expect(await isStaleNow(m.id)).toBe(true);
    });
  });

  it('[FAC-DKY-003] key usage comes from stored Snapshots, and the other holder re-analyzes', async () => {
    const w = await seedWorld();
    const a = await seedMigration(w);
    const b = await seedMigration(w);
    const key = { publicKey: 'ssh-ed25519 AAAA-shared', title: 'ci', readOnly: true };
    setReads({ 'deploy-keys': { data: { keys: [key] } } });
    events = [];
    await analyze(a.id);
    expect((await tasksOf(a.id)).map((x) => x.code)).toEqual([]);
    await analyze(b.id);
    expect((await tasksOf(b.id)).map((x) => x.code)).toEqual(['deploy-keys.key-in-use']);
    // The first holder is now stale and gets its task on the next pass.
    const staleA = await migrationRow(a.id);
    expect(staleA.analysisStaleAt && staleA.analysisStaleAt <= new Date()).toBe(true);
    await analyze(a.id);
    expect((await tasksOf(a.id)).map((x) => x.code)).toEqual(['deploy-keys.key-in-use']);
    // Removing the key from b frees a again.
    setReads({ 'deploy-keys': { data: { keys: [] } } });
    await analyze(b.id);
    expect((await migrationRow(a.id)).analysisStaleAt).not.toBeNull();
    setReads({ 'deploy-keys': { data: { keys: [key] } } });
    await analyze(a.id);
    expect((await tasksOf(a.id))[0]?.status).toBe('dismissed');
  });

  it('[FAC-PIP-002] the pipeline file text reaches translate in memory and is never stored', async () => {
    const w = await seedWorld();
    const m = await seedMigration(w);
    const text =
      'image: node:20\npipelines:\n  default:\n    - step:\n        script:\n          - echo SECRET_MARKER_123\n';
    const sha = sha256Hex(text);
    setReads({
      'git-refs': { data: { defaultBranch: 'main', refs: [], ignoredRefs: [], lfs: {} } },
      pipelines: {
        data: {
          files: [{ path: 'bitbucket-pipelines.yml', sha256: sha }],
          enabled: true,
          translation: { supported: true, unsupported: [] },
        },
        attachments: { [sha]: text },
      },
    });
    await analyze(m.id);
    const codes = (await tasksOf(m.id)).map((x) => x.code);
    expect(codes).toEqual(['pipelines.review-and-merge']);
    const analysis = await t.db.privileged.analysis.findFirstOrThrow({
      where: { migrationId: m.id },
    });
    const everything = JSON.stringify([
      analysis,
      await t.db.privileged.facetSnapshot.findMany({
        where: { id: { in: analysis.sourceSnapshotIds } },
      }),
      await t.db.privileged.planItem.findMany({ where: { analysisId: analysis.id } }),
    ]);
    expect(everything).not.toContain('SECRET_MARKER_123');
    expect((await migrationRow(m.id)).readiness).toBe('ready');
  });

  it('[ADP-014] read-time unreadable paths and capabilities overlay the static capabilities', async () => {
    const w = await seedWorld();
    const m = await seedMigration(w);
    setReads({
      pipelines: {
        data: { files: [], enabled: false, translation: { supported: true, unsupported: [] } },
        unreadable: ['/files'],
      },
    });
    await analyze(m.id);
    const eds = await t.db.privileged.expectedDifference.findMany({
      where: { routeId: w.routeId },
    });
    expect(eds.map((e) => [e.facetKey, e.path, e.reason, e.migrationId])).toEqual([
      ['pipelines', '/files', 'unreadable_defaulted', m.id],
    ]);
    // Repeating the Analysis does not repeat the record.
    await analyze(m.id);
    expect(await t.db.privileged.expectedDifference.count({ where: { routeId: w.routeId } })).toBe(
      1,
    );
  });

  it('[LIF-031] an existing non-empty target blocks, an empty one is adopted, an owned one raises nothing', async () => {
    const w = await seedWorld();
    const m = await seedMigration(w, 'svc');
    setReads({ 'deploy-keys': { data: { keys: [] } } });
    live = { name: 'plat-svc', empty: false };
    await analyze(m.id);
    expect((await migrationRow(m.id)).blockerCodes).toEqual(['target.exists-nonempty']);
    live = { name: 'plat-svc', empty: true };
    await analyze(m.id);
    const items = await t.db.privileged.planItem.findMany({
      where: {
        analysisId: (await migrationRow(m.id)).latestAnalysisId as string,
        code: { startsWith: 'target.' },
        kind: { not: 'step' },
      },
    });
    expect(items.map((i) => [i.code, i.kind])).toEqual([
      ['target.exists-foreign-adopted', 'warning'],
    ]);
    expect((await migrationRow(m.id)).readiness).toBe('ready');

    // Once the Migration owns that repository, nothing is raised (LIF-020 step 3).
    live = { name: 'plat-svc', empty: false };
    const targetNs = await t.db.privileged.namespace.findFirstOrThrow({
      where: { endpointId: w.targetEndpointId },
    });
    const owned = await t.db.privileged.repository.create({
      data: {
        endpointId: w.targetEndpointId,
        namespaceId: targetNs.id,
        providerId: 'live-1',
        slug: 'plat-svc',
        name: 'plat-svc',
        fullPath: 'acme/plat-svc',
        isPrivate: true,
        lastInventoriedAt: new Date(),
      },
    });
    await t.db.privileged.migration.update({
      where: { id: m.id },
      data: { targetRepositoryId: owned.id },
    });
    await analyze(m.id);
    expect((await migrationRow(m.id)).blockerCodes).toEqual([]);
    live = null;
  });

  it('[LIF-031] two Migrations whose names collide are both blocked', async () => {
    const w = await seedWorld();
    const a = await seedMigration(w, 'dup-one');
    const b = await seedMigration(w, 'dup_one');
    setReads({ 'deploy-keys': { data: { keys: [] } } });
    await analyze(a.id);
    await analyze(b.id);
    expect((await migrationRow(a.id)).blockerCodes).toEqual(['naming.collision']);
    expect((await migrationRow(b.id)).blockerCodes).toEqual(['naming.collision']);
  });

  it('[LIF-030] a NamingRule change marks the Route stale and the next Analysis uses it', async () => {
    const w = await seedWorld();
    const m = await seedMigration(w, 'named');
    setReads({ 'deploy-keys': { data: { keys: [] } } });
    await analyze(m.id);
    expect((await migrationRow(m.id)).analysisStaleAt?.getTime()).toBeGreaterThan(Date.now());
    await t.db.privileged.namingRule.create({
      data: {
        routeId: w.routeId,
        scope: 'repository',
        scopeRef: (await migrationRow(m.id)).sourceRepositoryId as string,
        pipeline: { steps: [], template: 'x' },
        override: 'chosen-name',
      },
    });
    expect((await migrationRow(m.id)).analysisStaleAt?.getTime()).toBeLessThanOrEqual(Date.now());
    await analyze(m.id);
    expect((await migrationRow(m.id)).plannedTargetName).toBe('chosen-name');
  });

  it('[JOB-020] adapter read warnings the Facet declares become Plan warnings; the others stay diagnostics', async () => {
    const w = await seedWorld();
    const m = await seedMigration(w);
    setReads({
      webhooks: {
        data: { hooks: [] },
        warnings: [
          {
            code: 'webhooks.duplicate-url',
            paths: [],
            params: { url: 'https://x.test/h', count: 2 },
          },
          { code: 'webhooks.invalid-url', paths: [], params: {} },
        ],
      },
    });
    await analyze(m.id);
    const row = await migrationRow(m.id);
    const warnings = await t.db.privileged.planItem.findMany({
      where: { analysisId: row.latestAnalysisId as string, kind: 'warning' },
    });
    expect(warnings.map((x) => x.code)).toEqual(['webhooks.duplicate-url']);
    const analysis = await t.db.privileged.analysis.findUniqueOrThrow({
      where: { id: row.latestAnalysisId as string },
    });
    expect(JSON.stringify(analysis.translation)).toContain('webhooks.invalid-url');
  });

  it('[JOB-020] the calls of an Analysis update the rolling mean of the Route', async () => {
    const w = await seedWorld();
    const m = await seedMigration(w);
    setReads({ 'deploy-keys': { data: { keys: [] }, calls: 10 } });
    const result = await analyze(m.id);
    expect(result.calls).toBeGreaterThanOrEqual(10);
    const route = await t.db.privileged.route.findUniqueOrThrow({ where: { id: w.routeId } });
    expect(route.avgCallsPerAnalysis).toBeCloseTo(30 + 0.1 * ((result.calls as number) - 30), 5);
  });

  it('[JOB-060] publishes migration.updated and task.updated when an Analysis completes or makes another stale', async () => {
    const w = await seedWorld({ acceptLossy: [] });
    const m = await seedMigration(w);
    setReads({ 'branch-rules': { data: { rules: [ADVISORY_RULE] } } });
    events = [];
    await analyze(m.id);
    await new Promise((r) => setTimeout(r, 200));
    const parsed = events.map(
      (e) => JSON.parse(e) as { type: string; ids: Record<string, string> },
    );
    expect(parsed.some((e) => e.type === 'migration.updated' && e.ids.migration === m.id)).toBe(
      true,
    );
    expect(parsed.some((e) => e.type === 'task.updated' && e.ids.migration === m.id)).toBe(true);
  });

  it('[JOB-020] skips a missing Migration, a missing source and a retired Route; endpoints stay untouched', async () => {
    const w = await seedWorld();
    const m = await seedMigration(w);
    expect(await analyze('does-not-exist')).toEqual({ skipped: 'migration-missing' });
    await t.db.privileged.repository.update({
      where: { id: m.sourceRepositoryId as string },
      data: { presence: 'missing' },
    });
    expect(await analyze(m.id)).toEqual({ skipped: 'source-missing' });
    await t.db.privileged.route.update({
      where: { id: w.routeId },
      data: { retiredAt: new Date() },
    });
    expect(await analyze(m.id)).toEqual({ skipped: 'route-retired' });
    expect((await migrationRow(m.id)).latestAnalysisId).toBeNull();
  });

  it('[JOB-020] stops at shutdown without storing anything', async () => {
    const w = await seedWorld();
    const m = await seedMigration(w);
    setReads({ 'deploy-keys': { data: { keys: [] } } });
    const stop = new AbortController();
    stop.abort();
    await expect(
      runAnalysis(deps, m.id, { shutdown: stop.signal, pool: 'background' }),
    ).rejects.toBeInstanceOf(AnalysisInterruptedError);
    expect(await t.db.privileged.analysis.count({ where: { migrationId: m.id } })).toBe(0);
  });

  it('[JOB-020] the pool follows the queue: interactive analyses connect on the interactive pool', async () => {
    const pools: string[] = [];
    const w = await seedWorld();
    const m = await seedMigration(w);
    setReads({ 'deploy-keys': { data: { keys: [] } } });
    const spy: EndpointConnector = {
      connect: (id, o) => {
        pools.push(o.pool);
        return connector.connect(id, o);
      },
    };
    await runAnalysis({ ...deps, connector: spy }, m.id, {
      shutdown: never.signal,
      pool: 'interactive',
    });
    expect(pools).toEqual(['interactive', 'interactive']);
    expect(connects).toBeGreaterThan(0);
  });
});

describe('robustness (ADR-0310, ADR-0312)', () => {
  const ctxFor = (attemptsMade: number, attempts = 3) =>
    ({
      shutdown: never.signal,
      log,
      queue: 'analysis-background',
      job: { attemptsMade, opts: { attempts } },
    }) as never;

  const handlerOf = (d: AnalysisDeps) =>
    analysisHandlers(d)['analysis.migration'] as (p: unknown, c: unknown) => Promise<unknown>;

  it('[JOB-020] a configuration fault fails with no provider call, without retries, and marks the Migration', async () => {
    const w = await seedWorld();
    const m = await seedMigration(w);
    setReads({ 'deploy-keys': { data: { keys: [] } } });
    const before = connects;
    await t.db.privileged.route.update({
      where: { id: w.routeId },
      data: { targetNamespaceId: null },
    });
    await expect(handlerOf(deps)({ migrationId: m.id }, ctxFor(0))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(connects).toBe(before);
    const row = await migrationRow(m.id);
    expect(row.analysisFailureCount).toBe(1);
    expect(row.analysisFailedAt).not.toBeNull();
    expect((row.analysisRetryAt as Date) > (row.analysisFailedAt as Date)).toBe(true);
  });

  it('[JOB-020] an invalid naming default fails before any provider call', async () => {
    const w = await seedWorld();
    const m = await seedMigration(w);
    await t.db.privileged.route.update({
      where: { id: w.routeId },
      data: { defaults: { naming: { steps: 'x' } } },
    });
    const before = connects;
    await expect(analyze(m.id)).rejects.toBeInstanceOf(AnalysisError);
    expect(connects).toBe(before);
  });

  it('[JOB-020] the attempt is recorded before it runs, so a worker that dies backs off; retries do not add; success clears', async () => {
    const w = await seedWorld();
    const m = await seedMigration(w);
    setReads({ 'deploy-keys': { data: { keys: [] } } });
    let during: { analysisFailureCount: number } | undefined;
    const dies: EndpointConnector = {
      connect: async () => {
        during = await migrationRow(m.id);
        throw new Error('worker died');
      },
    };
    await expect(
      handlerOf({ ...deps, connector: dies })({ migrationId: m.id }, ctxFor(0)),
    ).rejects.toThrow('worker died');
    expect(during?.analysisFailureCount).toBe(1);
    // BullMQ retries of the same job do not count again.
    await expect(
      handlerOf({ ...deps, connector: dies })({ migrationId: m.id }, ctxFor(1)),
    ).rejects.toThrow();
    expect((await migrationRow(m.id)).analysisFailureCount).toBe(1);
    // A second failing job doubles the backoff.
    await expect(
      handlerOf({ ...deps, connector: dies })({ migrationId: m.id }, ctxFor(0)),
    ).rejects.toThrow();
    const twice = await migrationRow(m.id);
    expect(twice.analysisFailureCount).toBe(2);
    const wait =
      (twice.analysisRetryAt as Date).getTime() - (twice.analysisFailedAt as Date).getTime();
    expect(wait).toBe(600_000);
    await handlerOf(deps)({ migrationId: m.id }, ctxFor(0));
    expect(await migrationRow(m.id)).toMatchObject({
      analysisFailureCount: 0,
      analysisFailedAt: null,
      analysisRetryAt: null,
    });
  });

  it('[JOB-020] when the last attempt fails the backoff runs from the failure, not from the start', async () => {
    const w = await seedWorld();
    const m = await seedMigration(w);
    setReads({ 'deploy-keys': { data: { keys: [] } } });
    let provisional: Date | null = null;
    const slow: EndpointConnector = {
      connect: async () => {
        provisional = (await migrationRow(m.id)).analysisFailedAt;
        await t.db.pool.query('SELECT pg_sleep(0.1)');
        throw new Error('slow failure');
      },
    };
    await expect(
      handlerOf({ ...deps, connector: slow })({ migrationId: m.id }, ctxFor(0, 1)),
    ).rejects.toThrow('slow failure');
    const row = await migrationRow(m.id);
    expect(provisional).not.toBeNull();
    expect((row.analysisFailedAt as Date) > (provisional as unknown as Date)).toBe(true);
    expect((row.analysisRetryAt as Date).getTime() - (row.analysisFailedAt as Date).getTime()).toBe(
      300_000,
    );
    expect(row.analysisFailureCount).toBe(1);
  });

  it('[JOB-020] a shutdown takes the recorded attempt back', async () => {
    const w = await seedWorld();
    const m = await seedMigration(w);
    setReads({ 'deploy-keys': { data: { keys: [] } } });
    const stop = new AbortController();
    stop.abort();
    const ctx = { ...(ctxFor(0) as object), shutdown: stop.signal } as never;
    await expect(handlerOf(deps)({ migrationId: m.id }, ctx)).rejects.toBeInstanceOf(
      AnalysisInterruptedError,
    );
    expect(await migrationRow(m.id)).toMatchObject({
      analysisFailureCount: 0,
      analysisFailedAt: null,
      analysisRetryAt: null,
    });
    // With earlier failures the earlier count stays.
    const earlier = new Date();
    await t.db.privileged.migration.update({
      where: { id: m.id },
      data: { analysisFailureCount: 2, analysisFailedAt: earlier, analysisRetryAt: earlier },
    });
    await expect(handlerOf(deps)({ migrationId: m.id }, ctx)).rejects.toBeInstanceOf(
      AnalysisInterruptedError,
    );
    expect((await migrationRow(m.id)).analysisFailureCount).toBe(2);
  });

  it('[JOB-020] a skipped Analysis does not leave the Migration marked as failing', async () => {
    const w = await seedWorld();
    const m = await seedMigration(w);
    await t.db.privileged.repository.update({
      where: { id: m.sourceRepositoryId as string },
      data: { presence: 'missing' },
    });
    await handlerOf(deps)({ migrationId: m.id }, ctxFor(0));
    expect(await migrationRow(m.id)).toMatchObject({
      analysisFailureCount: 0,
      analysisRetryAt: null,
    });
  });

  it('[LIF-021] a change to the Route lifts the retry time at once but keeps the failure count', async () => {
    const w = await seedWorld();
    const m = await seedMigration(w);
    await t.db.privileged.migration.update({
      where: { id: m.id },
      data: {
        analysisFailedAt: new Date(),
        analysisRetryAt: new Date(Date.now() + 3_600_000),
        analysisFailureCount: 4,
      },
    });
    await t.db.privileged.overlay.create({
      data: { routeId: w.routeId, facetKey: 'merge-settings', data: {} },
    });
    expect(await migrationRow(m.id)).toMatchObject({
      analysisFailureCount: 4,
      analysisFailedAt: null,
      analysisRetryAt: null,
    });
  });

  it('[LIF-020] an obsolete dismissal leaves no Actor, so the task reopens however it was completed before', async () => {
    const w = await seedWorld({ acceptLossy: [] });
    const m = await seedMigration(w);
    setReads({ 'branch-rules': { data: { rules: [ADVISORY_RULE] } } });
    await analyze(m.id);
    const [task] = await tasksOf(m.id);
    // An operator completed it, then reopened it through the API (the Actor stays on the row).
    await t.db.privileged.manualTask.update({
      where: { id: task?.id as string },
      data: { status: 'open', completedById: w.actorId },
    });
    setReads({ 'branch-rules': { data: { rules: [] } } });
    await analyze(m.id);
    expect((await tasksOf(m.id))[0]).toMatchObject({
      status: 'dismissed',
      note: 'obsolete',
      completedById: null,
    });
    setReads({ 'branch-rules': { data: { rules: [ADVISORY_RULE] } } });
    await analyze(m.id);
    expect((await tasksOf(m.id))[0]?.status).toBe('open');
  });

  it('[LIF-020] two Analyses of one Migration are serialized; neither fails, the newer-started one wins', async () => {
    const w = await seedWorld({ acceptLossy: [] });
    const m = await seedMigration(w);
    setReads({ 'branch-rules': { data: { rules: [ADVISORY_RULE] } } });
    const results = await Promise.all([analyze(m.id), analyze(m.id), analyze(m.id)]);
    expect(results.every((r) => r.analysisId)).toBe(true);
    expect(await tasksOf(m.id)).toHaveLength(1);
    const row = await migrationRow(m.id);
    const stored = await t.db.privileged.analysis.findMany({ where: { migrationId: m.id } });
    // Start times have millisecond resolution, so equal starts may tie: compare the instants.
    const latest = stored.find((x) => x.id === row.latestAnalysisId);
    const newestStart = Math.max(...stored.map((x) => (x.startedAt as Date).getTime()));
    expect(latest?.startedAt?.getTime()).toBe(newestStart);
    expect(stored.length + results.filter((r) => r.superseded).length).toBe(3);
  });

  it('[FAC-005] concurrent Analyses of two Migrations record a Route-wide lossy_accepted record once', async () => {
    const w = await seedWorld();
    const a = await seedMigration(w);
    const b = await seedMigration(w);
    setReads({ 'branch-rules': { data: { rules: [ADVISORY_RULE] } } });
    await Promise.all([analyze(a.id), analyze(b.id)]);
    const eds = await t.db.privileged.expectedDifference.findMany({
      where: { routeId: w.routeId, reason: 'lossy_accepted' },
    });
    expect(eds).toHaveLength(1);
    expect(eds[0]?.migrationId).toBeNull();
  });

  it('[LIF-020] a task reopens when its note was edited after the Analysis dismissed it', async () => {
    const w = await seedWorld({ acceptLossy: [] });
    const m = await seedMigration(w);
    setReads({ 'branch-rules': { data: { rules: [ADVISORY_RULE] } } });
    await analyze(m.id);
    setReads({ 'branch-rules': { data: { rules: [] } } });
    await analyze(m.id);
    const [task] = await tasksOf(m.id);
    expect(task?.status).toBe('dismissed');
    await t.db.privileged.manualTask.update({
      where: { id: task?.id as string },
      data: { note: 'edited by an operator' },
    });
    setReads({ 'branch-rules': { data: { rules: [ADVISORY_RULE] } } });
    await analyze(m.id);
    expect((await tasksOf(m.id))[0]).toMatchObject({ status: 'open', note: null });
    expect((await migrationRow(m.id)).readiness).toBe('needs_attention');
  });

  const teamRule = {
    ...ADVISORY_RULE,
    enforcement: 'enforced',
    changeRequest: null,
    restrictPushes: [{ principal: { kind: 'group', id: 'Platform-Team' } }],
  };
  const confirmedTeam = async (db: typeof t.db.privileged, w: World) => {
    const source = await db.group.create({
      data: {
        endpointId: w.sourceEndpointId,
        providerId: 'platform-team',
        slug: 'platform-team',
        name: 'P',
        memberIds: [],
      },
    });
    const target = await db.group.create({
      data: {
        endpointId: w.targetEndpointId,
        providerId: '777',
        slug: 'platform-team',
        name: 'P',
        memberIds: [],
      },
    });
    await db.groupMapping.create({
      data: {
        routeId: w.routeId,
        sourceGroupId: source.id,
        targetGroupId: target.id,
        plannedSlug: 'platform-team',
        status: 'confirmed',
      },
    });
  };
  const translationAfter = async (live: { providerId: string; slug: string }[]) => {
    const w = await seedWorld();
    const m = await seedMigration(w);
    const db = t.db.privileged;
    await confirmedTeam(db, w);
    liveTeams = live;
    setReads({ 'branch-rules': { data: { rules: [teamRule] } } });
    try {
      await analyze(m.id);
    } finally {
      liveTeams = [{ providerId: '777', slug: 'platform-team' }];
    }
    const row = await migrationRow(m.id);
    const analysis = await db.analysis.findUniqueOrThrow({
      where: { id: row.latestAnalysisId as string },
    });
    return JSON.stringify(analysis.translation);
  };

  it('[FAC-ACL-004] [LIF-080] a confirmed team renamed on the target still resolves by its provider id', async () => {
    expect(await translationAfter([{ providerId: '777', slug: 'renamed-team' }])).toContain(
      '"777"',
    );
  });

  it('[FAC-ACL-004] [LIF-080] a confirmed team deleted on the target no longer resolves in a repository Analysis', async () => {
    expect(await translationAfter([])).not.toContain('"777"');
  });

  it('[FAC-006] a group mapping is found whatever the case of the group id', async () => {
    const w = await seedWorld();
    const m = await seedMigration(w);
    const db = t.db.privileged;
    const source = await db.group.create({
      data: {
        endpointId: w.sourceEndpointId,
        providerId: 'platform-team',
        slug: 'platform-team',
        name: 'P',
        memberIds: [],
      },
    });
    const target = await db.group.create({
      data: {
        endpointId: w.targetEndpointId,
        providerId: '777',
        slug: 'platform-team',
        name: 'P',
        memberIds: [],
      },
    });
    await db.groupMapping.create({
      data: {
        routeId: w.routeId,
        sourceGroupId: source.id,
        targetGroupId: target.id,
        plannedSlug: 'platform-team',
        status: 'confirmed',
      },
    });
    const rule = {
      ...ADVISORY_RULE,
      enforcement: 'enforced',
      changeRequest: null,
      restrictPushes: [{ principal: { kind: 'group', id: 'Platform-Team' } }],
    };
    setReads({ 'branch-rules': { data: { rules: [rule] } } });
    await analyze(m.id);
    const row = await migrationRow(m.id);
    expect(row.blockerCodes).toEqual([]);
    const analysis = await db.analysis.findUniqueOrThrow({
      where: { id: row.latestAnalysisId as string },
    });
    expect(JSON.stringify(analysis.translation)).toContain('"777"');
  });
});

describe('endpoint Migration (LIF-080)', () => {
  it('[LIF-080] fills the route index from the mappings: org members, planned slugs and invitation candidates', async () => {
    const w = await seedWorld();
    const db = t.db.privileged;
    const endpointMigration = await db.migration.create({
      data: { scope: 'endpoint', routeId: w.routeId },
    });
    const srcIdentity = (providerId: string, email: string | null) =>
      db.identity.create({
        data: {
          endpointId: w.sourceEndpointId,
          providerId,
          login: providerId,
          email,
          kind: 'user',
          isMember: true,
        },
      });
    const alice = await srcIdentity('acct-alice', null);
    const carol = await srcIdentity('acct-carol', 'carol@acme.example');
    const dave = await srcIdentity('acct-dave', 'dave@acme.example');
    const aliceTarget = await db.identity.create({
      data: {
        endpointId: w.targetEndpointId,
        providerId: '4242',
        login: 'alice-gh',
        kind: 'user',
        isMember: true,
      },
    });
    await db.identityMapping.create({
      data: {
        routeId: w.routeId,
        sourceIdentityId: alice.id,
        targetIdentityId: aliceTarget.id,
        status: 'confirmed',
        method: 'manual',
      },
    });
    await db.identityMapping.create({
      data: { routeId: w.routeId, sourceIdentityId: carol.id, status: 'unmapped' },
    });
    void dave;
    const group = await db.group.create({
      data: {
        endpointId: w.sourceEndpointId,
        providerId: 'platform-team',
        slug: 'platform-team',
        name: 'Platform Team',
        memberIds: [],
      },
    });
    await db.groupMapping.create({
      data: {
        routeId: w.routeId,
        sourceGroupId: group.id,
        plannedSlug: 'pt-planned',
        status: 'unmapped',
      },
    });
    await db.namespace.create({
      data: {
        endpointId: w.sourceEndpointId,
        providerId: 'ws',
        kind: 'workspace',
        slug: 'acme',
        name: 'acme',
      },
    });
    setReads({
      members: {
        data: {
          members: [
            { principal: { kind: 'identity', id: 'acct-alice' }, role: 'member' },
            { principal: { kind: 'identity', id: 'acct-carol' }, role: 'member' },
            { principal: { kind: 'identity', id: 'acct-dave' }, role: 'member' },
          ],
        },
      },
      teams: {
        data: {
          teams: [
            {
              slug: 'platform-team',
              name: 'Platform Team',
              members: [{ principal: { kind: 'identity', id: 'acct-alice' } }],
            },
          ],
        },
      },
    });
    const result = await analyze(endpointMigration.id);
    expect(result.analysisId).toBeTruthy();
    const row = await migrationRow(endpointMigration.id);
    const analysis = await db.analysis.findUniqueOrThrow({
      where: { id: row.latestAnalysisId as string },
    });
    const facets = (analysis.translation as { facets: Record<string, { desired: Doc }> }).facets;
    // Alice is mapped and already an org member: she is written; the team uses the planned slug.
    expect(JSON.stringify(facets.members?.desired)).toContain('"4242"');
    expect(JSON.stringify(facets.members?.desired)).not.toContain('acct-carol');
    expect(JSON.stringify(facets.teams?.desired)).toContain('pt-planned');
    const codes = (await tasksOf(endpointMigration.id)).map((x) => x.code);
    expect(codes).toContain('members.approve-invitations');
    const steps = await db.planItem.findMany({
      where: { analysisId: analysis.id, kind: 'step' },
      orderBy: { order: 'asc' },
    });
    expect(steps.map((x) => x.code)).toEqual(['facet.teams.apply', 'verify']);
  });
});

describe('framework-created resources on the source (LIF-045)', () => {
  it('[LIF-045] a resource an active source-side Mutation created is not translated; an undone or adopted one is', async () => {
    const w = await seedWorld();
    const m = await seedMigration(w);
    const db = t.db.privileged;
    const run = await db.run.create({
      data: {
        migrationId: m.id,
        kind: 'source_read_only',
        status: 'succeeded',
        triggeredById: w.actorId,
        options: {},
      },
    });
    const key = (publicKey: string) => ({ publicKey, title: publicKey, readOnly: true });
    setReads({
      'deploy-keys': {
        data: {
          keys: [
            key('ssh-ed25519 KOWN'),
            key('ssh-ed25519 KUNDONE'),
            key('ssh-ed25519 KADOPTED'),
            key('ssh-ed25519 KKEEP'),
          ],
        },
      },
    });
    const mutation = (publicKey: string, over: Record<string, unknown> = {}) =>
      db.mutation.create({
        data: {
          migrationId: m.id,
          runId: run.id,
          side: 'source',
          facetKey: 'deploy-keys',
          resourceRef: {},
          paths: [`/keys[publicKey=${publicKey}]`],
          action: 'create',
          ...over,
        },
      });
    await mutation('ssh-ed25519 KOWN');
    await mutation('ssh-ed25519 KUNDONE', { undoneAt: new Date() });
    await mutation('ssh-ed25519 KADOPTED', { resourceRef: { adopted: true } });
    await analyze(m.id);
    const row = await migrationRow(m.id);
    const analysis = await db.analysis.findUniqueOrThrow({
      where: { id: row.latestAnalysisId as string },
    });
    const desired = (
      analysis.translation as {
        facets: Record<string, { desired: { keys: { publicKey: string }[] } }>;
      }
    ).facets['deploy-keys']?.desired.keys.map((k) => k.publicKey);
    expect(desired).toEqual(['ssh-ed25519 KADOPTED', 'ssh-ed25519 KKEEP', 'ssh-ed25519 KUNDONE']);
    // The Snapshot is the read as it was.
    const snapshot = await db.facetSnapshot.findFirstOrThrow({
      where: { id: { in: analysis.sourceSnapshotIds } },
    });
    expect(JSON.stringify(snapshot.data)).toContain('ssh-ed25519 KOWN');
  });
});

describe('analyzeForRun (LIF-021, LIF-022)', () => {
  it('[LIF-021] a fresh Analysis is reused; a stale or old one is redone', async () => {
    const w = await seedWorld();
    const m = await seedMigration(w);
    setReads({ 'deploy-keys': { data: { keys: [] } } });
    const first = await analyzeForRun(deps, m.id, { shutdown: never.signal });
    expect(first).toMatchObject({
      reanalyzed: true,
      before: null,
      after: 'ready',
      worsened: false,
    });
    const fresh = await analyzeForRun(deps, m.id, { shutdown: never.signal });
    expect(fresh.reanalyzed).toBe(false);
    await t.db.privileged.migration.update({
      where: { id: m.id },
      data: { analysisStaleAt: new Date(Date.now() - 1) },
    });
    expect((await analyzeForRun(deps, m.id, { shutdown: never.signal })).reanalyzed).toBe(true);
    const old = await analyzeForRun(
      { ...deps, now: () => new Date(Date.now() + 2 * 86_400_000) },
      m.id,
      { shutdown: never.signal },
    );
    expect(old.reanalyzed).toBe(true);
  });

  it('[LIF-022] reports a worse readiness so the Run can abort with readiness_changed', async () => {
    const w = await seedWorld({ acceptLossy: [] });
    const m = await seedMigration(w);
    setReads({ 'branch-rules': { data: { rules: [] } } });
    await analyzeForRun(deps, m.id, { shutdown: never.signal });
    setReads({ 'branch-rules': { data: { rules: [ADVISORY_RULE] } } });
    await t.db.privileged.migration.update({
      where: { id: m.id },
      data: { analysisStaleAt: new Date(Date.now() - 1) },
    });
    const out = await analyzeForRun(deps, m.id, { shutdown: never.signal });
    expect(out).toMatchObject({ before: 'ready', after: 'needs_attention', worsened: true });
  });
});
