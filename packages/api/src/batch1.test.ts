import { type AuthService, issueApiKey } from '@git-migrator/auth';
import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import type { BucketSnapshot } from '@git-migrator/quota';
import { createBuiltinRegistry } from '@git-migrator/registry';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from './app.ts';
import { createEventHub } from './events.ts';
import { PROBLEM_BASE, PROBLEM_CONTENT_TYPE } from './problem.ts';
import type { ApiServices } from './services.ts';

const ORIGIN = 'http://localhost:3000';
const ROLES = ['viewer', 'operator', 'admin'] as const;
type Role = (typeof ROLES)[number];

interface Enqueued {
  queue: string;
  name: string;
  payload: unknown;
  dedupeId?: string;
}
const enqueued: Enqueued[] = [];
let backgroundQueue: { migrationId: string }[] = [];
let buckets: BucketSnapshot[] = [];
let extraQueued = 0;
let failEnqueue = false;
let failGetJobs = false;

const services: ApiServices = {
  jobs: {
    enqueue: (queue: string, name: string, payload: unknown, options?: { dedupeId?: string }) => {
      if (failEnqueue) return Promise.reject(new Error('queue down: secret-detail'));
      enqueued.push({
        queue,
        name,
        payload,
        ...(options?.dedupeId ? { dedupeId: options.dedupeId } : {}),
      });
      return Promise.resolve({} as never);
    },
    enqueueAnalysis: (migrationId: string, priority: string) => {
      if (failEnqueue) return Promise.reject(new Error('queue down: secret-detail'));
      enqueued.push({
        queue: `analysis-${priority}`,
        name: 'analysis.migration',
        payload: { migrationId },
        dedupeId: `analysis-${migrationId}`,
      });
      return Promise.resolve({} as never);
    },
    enqueueRun: () => Promise.resolve({} as never),
    enqueueParity: () => Promise.resolve({} as never),
    queue: () =>
      ({
        getJobs: () =>
          failGetJobs
            ? Promise.reject(new Error('queue down: secret-detail'))
            : Promise.resolve(backgroundQueue.map((data) => ({ data }))),
        getJobCounts: () =>
          failGetJobs
            ? Promise.reject(new Error('queue down: secret-detail'))
            : Promise.resolve({ waiting: backgroundQueue.length + extraQueued }),
      }) as never,
  } as never,
  quota: { snapshot: () => Promise.resolve(buckets) },
  registry: createBuiltinRegistry(),
};

let t: TestDatabase;
let app: ReturnType<typeof createApiApp>;
let bare: ReturnType<typeof createApiApp>;
const keys = {} as Record<Role, string>;
let actorIds = {} as Record<Role, string>;

interface Seed {
  routeId: string;
  ns1: string;
  ns2: string;
  repoApi: string;
  repoWeb: string;
  repoOpsApi: string;
  mApi: string;
  mWeb: string;
  mOpsApi: string;
  mEndpoint: string;
  mRunning: string;
  mNever: string;
}
let seed: Seed;

const at = new Date('2026-01-01T00:00:00.000Z');

async function seedWorld(): Promise<Seed> {
  const db = t.db.privileged;
  const mkEndpoint = (id: string, providerType: string, status: 'active' | 'retired' = 'active') =>
    db.endpoint.create({
      data: {
        id,
        providerType,
        displayName: id,
        baseUrl: `http://${id}.test`,
        status,
        configHash: 'h',
      },
    });
  await mkEndpoint('src', 'bitbucket-cloud');
  await mkEndpoint('dst', 'github');
  await mkEndpoint('old', 'github', 'retired');
  const route = await db.route.create({
    data: {
      id: 'route-1',
      sourceEndpointId: 'src',
      targetEndpointId: 'dst',
      targetNamespacePath: 'acme',
      policies: {},
      defaults: {},
      configHash: 'h',
      sourcePostAction: 'read-only',
      avgCallsPerAnalysis: 20,
    },
  });
  const mkNs = (providerId: string, key: string) =>
    db.namespace.create({
      data: {
        endpointId: 'src',
        providerId,
        kind: 'project',
        slug: key.toLowerCase(),
        key,
        name: key,
      },
    });
  const ns1 = await mkNs('ns-1', 'PLAT');
  const ns2 = await mkNs('ns-2', 'OPS');
  const mkRepo = (nsId: string, providerId: string, slug: string, path: string) =>
    db.repository.create({
      data: {
        endpointId: 'src',
        namespaceId: nsId,
        providerId,
        slug,
        name: slug,
        fullPath: path,
        isPrivate: true,
        lastInventoriedAt: at,
      },
    });
  const repoApi = await mkRepo(ns1.id, 'r-1', 'api', 'plat/api');
  const repoWeb = await mkRepo(ns1.id, 'r-2', 'web', 'plat/web');
  const repoOpsApi = await mkRepo(ns2.id, 'r-3', 'api', 'ops/api');
  const mkMigration = (repoId: string | null, extra: Record<string, unknown> = {}) =>
    db.migration.create({
      data: {
        scope: repoId ? 'repository' : 'endpoint',
        routeId: route.id,
        ...(repoId ? { sourceRepositoryId: repoId } : {}),
        ...extra,
      },
    });
  const mApi = await mkMigration(repoApi.id, { plannedTargetName: 'plat-api' });
  const mWeb = await mkMigration(repoWeb.id, { plannedTargetName: 'plat-web' });
  const mOpsApi = await mkMigration(repoOpsApi.id, { plannedTargetName: 'ops-api' });
  const mEndpoint = await mkMigration(null, { status: 'analyzed', readiness: 'ready' });
  const repoRun = await mkRepo(ns2.id, 'r-4', 'busy', 'ops/busy');
  const mRunning = await mkMigration(repoRun.id, { status: 'running' });
  const repoNever = await mkRepo(ns2.id, 'r-5', 'fresh', 'ops/fresh');
  const mNever = await mkMigration(repoNever.id);
  await db.migration.update({
    where: { id: mWeb.id },
    data: { status: 'analyzed', readiness: 'needs_attention' },
  });
  await db.migration.update({
    where: { id: mApi.id },
    data: { status: 'analyzed', readiness: 'ready' },
  });
  const wave = await db.wave.create({ data: { name: 'wave-1' } });
  await db.migration.update({ where: { id: mApi.id }, data: { waveId: wave.id } });

  // An Analysis with Snapshots on both sides, one ParityResult history and an Expected Difference.
  const snap = (side: string, facetKey: string, data: unknown, unreadable: string[] = []) =>
    db.facetSnapshot.create({
      data: {
        side,
        endpointId: side === 'source' ? 'src' : 'dst',
        repositoryId: repoApi.id,
        facetKey,
        schemaVersion: 1,
        data: data as never,
        unreadable,
        hash: 'x',
        fetchedAt: at,
        rawResponseIds: [],
      },
    });
  const hook = {
    key: 'https://hooks.example#abc',
    url: 'https://hooks.example/path/PATHSECRET?x=1',
    events: [],
    active: true,
    hasSecret: true,
    verifyTls: true,
  };
  const sHooks = await snap('source', 'webhooks', { hooks: [hook] });
  const tHooks = await snap('target', 'webhooks', { hooks: [] });
  const sVars = await snap('source', 'variables', {
    variables: [{ key: 'repo/A', scope: 'repo', name: 'A', value: '1' }],
    password: 'hunter2-fake',
    note: 'clone https://someone:pw-fake@git.example/x.git',
  });
  const sSecrets = await snap('source', 'secrets', {
    secrets: [{ key: 'repo/TOKEN_NAME', scope: 'repo', name: 'TOKEN_NAME' }],
  });
  const analysis = await db.analysis.create({
    data: {
      migrationId: mApi.id,
      sourceSnapshotIds: [sHooks.id, sVars.id, sSecrets.id],
      targetSnapshotIds: [tHooks.id],
      readiness: 'ready',
      translation: {
        facets: {
          webhooks: {
            desired: { hooks: [{ ...hook, active: false }] },
            decisions: [],
            overridden: false,
          },
          variables: { desired: { variables: [], password: 'desired-fake-pw' }, decisions: [] },
        },
      },
    },
  });
  await db.migration.update({ where: { id: mApi.id }, data: { latestAnalysisId: analysis.id } });
  await db.parityResult.create({
    data: {
      migrationId: mApi.id,
      facetKey: 'webhooks',
      status: 'unverifiable',
      diffs: [],
      excluded: [],
      checkedAt: new Date('2026-01-01T00:00:00.000Z'),
    },
  });
  await db.parityResult.create({
    data: {
      migrationId: mApi.id,
      facetKey: 'webhooks',
      status: 'different',
      diffs: [
        { path: '/hooks[key=abc]/url', source: hook.url, target: 'https://other.example/q' },
        { path: '/variables/password', source: 'hunter2-fake', target: 'also-fake' },
      ],
      excluded: [{ path: '/hooks[key=abc]/active', expectedDifferenceId: 'ed-1' }],
      checkedAt: new Date('2026-02-01T00:00:00.000Z'),
    },
  });
  await db.expectedDifference.create({
    data: {
      routeId: route.id,
      migrationId: mApi.id,
      facetKey: 'webhooks',
      path: '/hooks/active',
      reason: 'manual_accepted',
      note: 'see https://ops:note-pw-fake@h.example/x',
    },
  });
  await db.expectedDifference.create({
    data: {
      routeId: route.id,
      migrationId: mApi.id,
      facetKey: 'webhooks',
      path: '/hooks/gone',
      reason: 'manual_accepted',
      revokedAt: at,
    },
  });
  return {
    routeId: route.id,
    ns1: ns1.id,
    ns2: ns2.id,
    repoApi: repoApi.id,
    repoWeb: repoWeb.id,
    repoOpsApi: repoOpsApi.id,
    mApi: mApi.id,
    mWeb: mWeb.id,
    mOpsApi: mOpsApi.id,
    mEndpoint: mEndpoint.id,
    mRunning: mRunning.id,
    mNever: mNever.id,
  };
}

async function keyFor(role: Role): Promise<{ key: string; actorId: string }> {
  const actor = await t.db.privileged.actor.create({
    data: { kind: 'service', displayName: `svc ${role}`, role },
  });
  const issued = await issueApiKey(t.db.privileged, {
    actorId: actor.id,
    name: 'k',
    issuedBy: actor.id,
  });
  return { key: issued.key, actorId: actor.id };
}

beforeAll(async () => {
  t = await createTestDatabase('gm_t062_');
  const hub = createEventHub({
    listener: { start: () => undefined, subscribe: () => () => undefined, connected: false },
  });
  app = createApiApp({
    db: t.db,
    auth: {} as AuthService,
    publicUrl: ORIGIN,
    events: hub,
    services,
  });
  bare = createApiApp({ db: t.db, auth: {} as AuthService, publicUrl: ORIGIN, events: hub });
  actorIds = {} as Record<Role, string>;
  for (const role of ROLES) {
    const made = await keyFor(role);
    keys[role] = made.key;
    actorIds[role] = made.actorId;
  }
  seed = await seedWorld();
}, 120_000);

afterAll(async () => {
  await t?.drop();
});

const call = (
  path: string,
  init: { method?: string; role?: Role; body?: unknown; raw?: string; target?: typeof app } = {},
) => {
  const headers: Record<string, string> = {};
  if (init.role) headers.authorization = `Bearer ${keys[init.role]}`;
  const body = init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body));
  if (body !== undefined) headers['content-type'] = 'application/json';
  return (init.target ?? app).request(`${ORIGIN}/api/v1${path}`, {
    method: init.method ?? 'GET',
    headers,
    ...(body === undefined ? {} : { body }),
  });
};

async function expectProblem(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get('content-type')).toContain(PROBLEM_CONTENT_TYPE);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.type).toBe(`${PROBLEM_BASE}${code}`);
  return body;
}

interface Endpoint {
  name: string;
  method: string;
  path: string;
  body?: unknown;
  /** Lowest role that may call it. */
  min: Role;
}
const ENDPOINTS: Endpoint[] = [
  {
    name: 'POST /inventory/refresh',
    method: 'POST',
    path: '/inventory/refresh',
    body: {},
    min: 'operator',
  },
  {
    name: 'POST /migrations/{id}/analyze',
    method: 'POST',
    path: '/migrations/ID/analyze',
    min: 'operator',
  },
  { name: 'GET /dashboard', method: 'GET', path: '/dashboard', min: 'viewer' },
  { name: 'GET /quota', method: 'GET', path: '/quota', min: 'viewer' },
  { name: 'GET /capability-matrix', method: 'GET', path: '/capability-matrix', min: 'viewer' },
  { name: 'GET /migrations/{id}/diff', method: 'GET', path: '/migrations/ID/diff', min: 'viewer' },
  {
    name: 'POST /routes/{id}/naming/preview',
    method: 'POST',
    path: '/routes/ROUTE/naming/preview',
    body: {
      rule: {
        scope: 'namespace',
        scopeRef: 'NS',
        pipeline: { steps: [{ var: 'repository', op: 'slug' }], template: '{repository}' },
      },
    },
    min: 'operator',
  },
];
const RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };
const resolve = (e: Endpoint) => ({
  path: e.path.replace('ID', seed.mApi).replace('ROUTE', seed.routeId),
  body: JSON.parse(
    JSON.stringify(e.body ?? null).replace('"NS"', JSON.stringify(seed.ns1)),
  ) as unknown,
});

describe('[API-021] [AUTH-021] every batch 1 endpoint enforces its role', () => {
  for (const endpoint of ENDPOINTS) {
    it(`[API-021] ${endpoint.name} answers 401 without a credential, 403 below ${endpoint.min}, 2xx from ${endpoint.min}`, async () => {
      const { path, body } = resolve(endpoint);
      const send = (role?: Role) =>
        call(path, {
          method: endpoint.method,
          ...(role ? { role } : {}),
          ...(endpoint.body === undefined ? {} : { body }),
        });
      await expectProblem(await send(), 401, 'unauthenticated');
      for (const role of ROLES) {
        const res = await send(role);
        if (RANK[role] < RANK[endpoint.min]) {
          await expectProblem(res, 403, 'forbidden');
        } else {
          expect(res.status, `${endpoint.name} as ${role}`).toBeLessThan(300);
        }
      }
    });
  }

  it('[API-021] [API-011] a missing service is a 503 not_ready problem, never a 500', async () => {
    for (const endpoint of ENDPOINTS) {
      const { path, body } = resolve(endpoint);
      if (endpoint.name.includes('diff') || endpoint.name.includes('dashboard')) continue;
      const res = await call(path, {
        method: endpoint.method,
        role: 'admin',
        target: bare,
        ...(endpoint.body === undefined ? {} : { body }),
      });
      await expectProblem(res, 503, 'not_ready');
    }
  });

  it('[API-020] the endpoints are in the OpenAPI document', async () => {
    const res = await call('/openapi.json', { role: 'viewer' });
    const doc = (await res.json()) as { paths: Record<string, unknown> };
    for (const path of [
      '/inventory/refresh',
      '/migrations/{id}/analyze',
      '/dashboard',
      '/quota',
      '/capability-matrix',
      '/migrations/{id}/diff',
      '/routes/{id}/naming/preview',
      '/me',
    ]) {
      expect(doc.paths[path], path).toBeDefined();
    }
  });
});

describe('[API-020] [JOB-030] POST /inventory/refresh', () => {
  it('[JOB-030] enqueues one deduplicated inventory pass per active Endpoint and audits it', async () => {
    enqueued.length = 0;
    const auditCount = () =>
      t.db.privileged.auditEvent.count({ where: { action: 'inventory.refresh' } });
    const before = await auditCount();
    const res = await call('/inventory/refresh', { method: 'POST', role: 'operator' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ endpoints: ['dst', 'src'] });
    expect(enqueued).toEqual([
      {
        queue: 'inventory',
        name: 'inventory.endpoint',
        payload: { endpointId: 'dst' },
        dedupeId: 'inventory-dst',
      },
      {
        queue: 'inventory',
        name: 'inventory.endpoint',
        payload: { endpointId: 'src' },
        dedupeId: 'inventory-src',
      },
    ]);
    expect((await auditCount()) - before).toBe(2);
  });

  it('[JOB-030] {endpointId} refreshes that Endpoint only; unknown is 404 and retired is 409', async () => {
    enqueued.length = 0;
    const one = await call('/inventory/refresh', {
      method: 'POST',
      role: 'operator',
      body: { endpointId: 'src' },
    });
    expect(await one.json()).toEqual({ endpoints: ['src'] });
    expect(enqueued).toHaveLength(1);
    await expectProblem(
      await call('/inventory/refresh', {
        method: 'POST',
        role: 'operator',
        body: { endpointId: 'nope' },
      }),
      404,
      'not_found',
    );
    await expectProblem(
      await call('/inventory/refresh', {
        method: 'POST',
        role: 'operator',
        body: { endpointId: 'old' },
      }),
      409,
      'conflict',
    );
    expect(enqueued).toHaveLength(1);
  });

  it('[API-011] a malformed body is a 422 problem and enqueues nothing', async () => {
    enqueued.length = 0;
    await expectProblem(
      await call('/inventory/refresh', {
        method: 'POST',
        role: 'operator',
        body: { endpointId: 7 },
      }),
      422,
      'validation_failed',
    );
    expect(enqueued).toHaveLength(0);
  });
});

describe('[API-020] [LIF-020] POST /migrations/{id}/analyze', () => {
  it('[JOB-011] enqueues on the interactive queue under the analysis-<id> dedupe id and audits', async () => {
    enqueued.length = 0;
    const res = await call(`/migrations/${seed.mWeb}/analyze`, {
      method: 'POST',
      role: 'operator',
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ migrationId: seed.mWeb, queue: 'analysis-interactive' });
    expect(enqueued).toEqual([
      {
        queue: 'analysis-interactive',
        name: 'analysis.migration',
        payload: { migrationId: seed.mWeb },
        dedupeId: `analysis-${seed.mWeb}`,
      },
    ]);
    const audit = await t.db.privileged.auditEvent.findMany({
      where: { action: 'migration.analyze', subjectId: seed.mWeb },
    });
    expect(audit).toHaveLength(1);
  });

  it('[LIF-020] an unknown Migration is 404 and one whose source is missing is 409; nothing is enqueued', async () => {
    enqueued.length = 0;
    await expectProblem(
      await call('/migrations/missing/analyze', { method: 'POST', role: 'operator' }),
      404,
      'not_found',
    );
    const gone = await t.db.privileged.repository.create({
      data: {
        endpointId: 'src',
        namespaceId: seed.ns2,
        providerId: 'r-gone',
        slug: 'gone',
        name: 'gone',
        fullPath: 'ops/gone',
        isPrivate: true,
        lastInventoriedAt: at,
      },
    });
    const missing = await t.db.privileged.migration.create({
      data: {
        scope: 'repository',
        routeId: seed.routeId,
        sourceRepositoryId: gone.id,
        status: 'source_missing',
      },
    });
    await expectProblem(
      await call(`/migrations/${missing.id}/analyze`, { method: 'POST', role: 'operator' }),
      409,
      'conflict',
    );
    expect(enqueued).toHaveLength(0);
  });

  it('[LIF-002] a running Migration may be analyzed: the processor leaves running unchanged', async () => {
    enqueued.length = 0;
    const res = await call(`/migrations/${seed.mRunning}/analyze`, {
      method: 'POST',
      role: 'operator',
    });
    expect(res.status).toBe(202);
    expect(enqueued).toHaveLength(1);
  });

  it('[API-011] a queue outage is a 503 not_ready with Retry-After, no detail leaks, and no audit row is written', async () => {
    const before = await t.db.privileged.auditEvent.count();
    failEnqueue = true;
    try {
      const analyze = await call(`/migrations/${seed.mWeb}/analyze`, {
        method: 'POST',
        role: 'operator',
      });
      const refresh = await call('/inventory/refresh', {
        method: 'POST',
        role: 'operator',
        body: {},
      });
      for (const res of [analyze, refresh]) {
        expect(res.headers.get('retry-after')).toBe('5');
        const problem = await expectProblem(res, 503, 'not_ready');
        expect(JSON.stringify(problem)).not.toContain('secret-detail');
      }
    } finally {
      failEnqueue = false;
    }
    expect(await t.db.privileged.auditEvent.count()).toBe(before);
  });

  it('[API-011] an unreachable database is a 503 not_ready, not a 500', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const failing = new Proxy({}, { get: () => () => Promise.reject(refused) });
    const down = createApiApp({
      db: {
        ...t.db,
        privileged: new Proxy(t.db.privileged, {
          get: (target, prop) =>
            prop === 'route' ? (failing as never) : Reflect.get(target, prop, target),
        }),
      } as never,
      auth: {} as AuthService,
      publicUrl: ORIGIN,
      events: createEventHub({
        listener: { start: () => undefined, subscribe: () => () => undefined, connected: false },
      }),
      services,
    });
    const res = await call('/dashboard', { role: 'viewer', target: down });
    expect(res.headers.get('retry-after')).toBe('5');
    await expectProblem(res, 503, 'not_ready');
  });
});

describe('[API-020] [UI-020] GET /dashboard', () => {
  it('[UI-020] counts repository Migrations per Route by status and readiness, per Wave, and lists Runs', async () => {
    const operator = await t.db.privileged.actor.findUniqueOrThrow({
      where: { id: actorIds.operator },
    });
    await t.db.privileged.run.create({
      data: { migrationId: seed.mApi, kind: 'migrate', triggeredById: operator.id, options: {} },
    });
    const res = await call('/dashboard', { role: 'viewer' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      routes: {
        routeId: string;
        total: number;
        byStatus: Record<string, number>;
        byReadiness: Record<string, number>;
        endpointMigration: { migrationId: string; status: string } | null;
      }[];
      waves: { name: string; total: number; byStatus: Record<string, number> }[];
      recentRuns: { migrationId: string; kind: string }[];
    };
    const route = body.routes.find((r) => r.routeId === seed.routeId);
    expect(route?.total).toBe(6);
    expect(route?.byStatus).toEqual({ analyzed: 2, discovered: 2, running: 1, source_missing: 1 });
    expect(route?.byReadiness).toEqual({ ready: 1, needs_attention: 1, unanalyzed: 4 });
    expect(route?.endpointMigration).toMatchObject({
      migrationId: seed.mEndpoint,
      status: 'analyzed',
    });
    expect(body.waves).toMatchObject([{ name: 'wave-1', total: 1, byStatus: { analyzed: 1 } }]);
    expect(body.recentRuns[0]).toMatchObject({ migrationId: seed.mApi, kind: 'migrate' });
    expect(body.recentRuns.length).toBeLessThanOrEqual(20);
  });
});

describe('[API-020] [JOB-047] GET /quota', () => {
  const bucket = (key: string, over: Partial<BucketSnapshot> = {}): BucketSnapshot => ({
    bucketKey: key,
    limit: 1000,
    effectiveLimit: 800,
    backgroundLimit: 400,
    windowSeconds: 3600,
    used: 100,
    usedBackground: 60,
    usedInteractive: 40,
    remaining: 900,
    resetAt: new Date('2026-01-01T01:00:00.000Z'),
    blockedUntil: null,
    nearLimit: false,
    backgroundClampedUntil: null,
    backgroundRatePerSecond: 400 / 3600,
    ...over,
  });

  it('[JOB-047] reports each bucket with its background backlog and ETA (backlog x calls / rate)', async () => {
    buckets = [
      bucket('src:acct:core'),
      bucket('dst:acct:core', { blockedUntil: new Date('2026-01-01T00:30:00.000Z') }),
    ];
    backgroundQueue = [{ migrationId: seed.mApi }, { migrationId: seed.mWeb }];
    const res = await call('/quota', { role: 'viewer' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      buckets: Record<string, unknown>[];
    };
    const src = body.buckets.find((b) => b.bucketKey === 'src:acct:core');
    expect(src).toMatchObject({
      endpointId: 'src',
      accountKey: 'acct',
      resourceGroup: 'core',
      limit: 1000,
      used: 100,
      pools: { backgroundLimit: 400, usedBackground: 60, usedInteractive: 40 },
      backlog: 2,
      resetAt: '2026-01-01T01:00:00.000Z',
    });
    // 2 analyses x 20 calls (the Route mean) / (400 / 3600 per second) = 360 s.
    expect(src?.backgroundEtaSeconds).toBeCloseTo(360, 5);
    const dst = body.buckets.find((b) => b.bucketKey === 'dst:acct:core');
    expect(dst).toMatchObject({
      backlog: 0,
      backgroundEtaSeconds: 0,
      blockedUntil: '2026-01-01T00:30:00.000Z',
    });
  });

  it('[API-011] a queue read failure is a 503 not_ready', async () => {
    failGetJobs = true;
    try {
      const res = await call('/quota', { role: 'viewer' });
      expect(res.headers.get('retry-after')).toBe('5');
      await expectProblem(res, 503, 'not_ready');
    } finally {
      failGetJobs = false;
    }
  });

  it('[JOB-047] totals come from the queue counts and a partial per-Endpoint split is flagged', async () => {
    buckets = [bucket('src:acct:core')];
    backgroundQueue = [{ migrationId: seed.mApi }];
    extraQueued = 41;
    try {
      const body = (await (await call('/quota', { role: 'viewer' })).json()) as {
        backlogTotal: number;
        backlogTruncated: boolean;
      };
      expect(body).toMatchObject({ backlogTotal: 42, backlogTruncated: true });
    } finally {
      extraQueued = 0;
    }
    const whole = (await (await call('/quota', { role: 'viewer' })).json()) as {
      backlogTotal: number;
      backlogTruncated: boolean;
    };
    expect(whole).toMatchObject({ backlogTotal: 1, backlogTruncated: false });
  });

  it('[JOB-047] the ETA is null when the bucket has no background capacity', async () => {
    buckets = [bucket('src:acct:core', { backgroundRatePerSecond: 0, backgroundLimit: 0 })];
    backgroundQueue = [{ migrationId: seed.mApi }];
    const body = (await (await call('/quota', { role: 'viewer' })).json()) as {
      buckets: { backgroundEtaSeconds: number | null }[];
    };
    expect(body.buckets[0]?.backgroundEtaSeconds).toBeNull();
  });
});

describe('[API-020] [ADP-014] GET /capability-matrix', () => {
  it('[ADP-014] returns the registry matrix: adapters, one row per Facet, a static ceiling', async () => {
    const res = await call('/capability-matrix', { role: 'viewer' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ceiling: string;
      adapters: string[];
      rows: {
        facet: string;
        cells: {
          source: string;
          target: string;
          fidelity: string;
          read: boolean;
          write: boolean;
          override: boolean;
        }[];
      }[];
    };
    expect(body.ceiling).toBe('static');
    expect(body.adapters).toEqual(['bitbucket-cloud', 'github']);
    expect(body.rows.map((r) => r.facet)).toEqual(
      services.registry.capabilityMatrix().rows.map((r) => r.facet),
    );
    const cell = body.rows[0]?.cells[0];
    expect(cell).toBeDefined();
    expect(['bitbucket-cloud', 'github']).toContain(cell?.source);
    expect(cell?.source).not.toBe(cell?.target);
    expect(typeof cell?.read).toBe('boolean');
  });
});

describe('[API-020] [LIF-063] GET /migrations/{id}/diff', () => {
  type DiffFacet = {
    facetKey: string;
    source: unknown;
    desired: unknown;
    target: unknown;
    parity: {
      status: string;
      diffs: { path: string; source: unknown; target: unknown }[];
      excluded: unknown[];
    } | null;
    expectedDifferences: { path: string }[];
  };
  const facet = (facets: DiffFacet[], key: string) =>
    facets.find((f) => f.facetKey === key) as DiffFacet;
  const diff = async (query = '') => {
    const res = await call(`/migrations/${seed.mApi}/diff${query}`, { role: 'viewer' });
    expect(res.status).toBe(200);
    return (await res.json()) as { analysisId: string | null; facets: DiffFacet[] };
  };

  it('[LIF-063] returns Snapshots, the desired state, the latest ParityResult and active Expected Differences per Facet', async () => {
    const body = await diff();
    expect(body.analysisId).not.toBeNull();
    expect(body.facets.map((f) => f.facetKey)).toEqual(['secrets', 'variables', 'webhooks']);
    const hooks = facet(body.facets, 'webhooks');
    expect(hooks.target).toEqual({ hooks: [] });
    expect(hooks.parity?.status).toBe('different');
    expect(hooks.parity?.excluded).toHaveLength(1);
    // The revoked Expected Difference is not listed.
    expect(hooks.expectedDifferences.map((d) => d.path)).toEqual(['/hooks/active']);
    const secrets = facet(body.facets, 'secrets');
    expect(secrets.source).toEqual({
      secrets: [{ key: 'repo/TOKEN_NAME', scope: 'repo', name: 'TOKEN_NAME' }],
    });
  });

  it('[AUTH-022] no secret value, credential URL or webhook path leaks into the response', async () => {
    const res = await call(`/migrations/${seed.mApi}/diff`, { role: 'viewer' });
    const text = await res.text();
    for (const leak of [
      'hunter2-fake',
      'desired-fake-pw',
      'pw-fake',
      'PATHSECRET',
      'also-fake',
      'note-pw-fake',
    ]) {
      expect(text, leak).not.toContain(leak);
    }
    const body = JSON.parse(text) as { facets: DiffFacet[] };
    const hooks = facet(body.facets, 'webhooks');
    expect(hooks.source).toMatchObject({
      hooks: [{ url: 'https://hooks.example/…', hasSecret: true, active: true }],
    });
    expect(hooks.parity?.diffs[0]?.source).toBe('https://hooks.example/…');
    const vars = facet(body.facets, 'variables');
    expect(vars.source).toMatchObject({
      password: '[REDACTED]',
      variables: [{ name: 'A', value: '1' }],
    });
    expect(JSON.stringify(vars.source)).toContain('git.example');
  });

  it('[FAC-WEB-002] a viewer reads no webhook URL through RPC; the redacted diff is the way (ADR-0503)', async () => {
    const rpc = async (role: Role, model: string, args: unknown) => {
      const q = encodeURIComponent(JSON.stringify(args));
      const res = await app.request(`${ORIGIN}/api/model/${model}/findMany?q=${q}`, {
        headers: { authorization: `Bearer ${keys[role]}` },
      });
      expect(res.status).toBe(200);
      return res.text();
    };
    const snapshots = { where: { facetKey: 'webhooks' } };
    const analyses = { where: { migrationId: seed.mApi } };
    expect(await rpc('viewer', 'facetSnapshot', snapshots)).not.toContain('PATHSECRET');
    expect(await rpc('viewer', 'analysis', analyses)).not.toContain('PATHSECRET');
    // The operator still reads it, so the viewer's answer is the policy and not an empty query.
    expect(await rpc('operator', 'facetSnapshot', snapshots)).toContain('PATHSECRET');
    expect(await rpc('operator', 'analysis', analyses)).toContain('PATHSECRET');

    // The recreate task and its PlanItem keep the full URL in secretParams only (ADR-0503).
    const db = t.db.privileged;
    const { latestAnalysisId } = await db.migration.findUniqueOrThrow({
      where: { id: seed.mApi },
    });
    const split = { key: 'k', targetUrlDisplay: 'https://hooks.example/…' };
    const secret = { targetUrl: 'https://hooks.example/path/PATHSECRET?x=1' };
    const item = await db.planItem.create({
      data: {
        analysisId: latestAnalysisId as string,
        facetKey: 'webhooks',
        kind: 'post_task',
        code: 'webhooks.recreate-manually',
        fieldPaths: [],
        params: split,
        secretParams: secret,
        order: 99,
      },
    });
    await db.manualTask.create({
      data: {
        migrationId: seed.mApi,
        facetKey: 'webhooks',
        code: 'webhooks.recreate-manually',
        phase: 'post',
        origin: 'analysis',
        params: split,
        secretParams: secret,
        verifiable: true,
        paramsHash: 'h-recreate',
        sourcePlanItemId: item.id,
      },
    });
    const tasks = { where: { migrationId: seed.mApi } };
    const items = { where: { id: item.id } };
    for (const [model, args] of [
      ['manualTask', tasks],
      ['planItem', items],
    ] as const) {
      const viewer = await rpc('viewer', model, args);
      expect(viewer, model).not.toContain('PATHSECRET');
      expect(viewer, model).toContain('hooks.example/…');
      expect(await rpc('operator', model, args), model).toContain('PATHSECRET');
    }
  });

  it('[LIF-063] ?facetKey narrows to one Facet; an unknown Facet is a 422 problem', async () => {
    const one = await diff('?facetKey=variables');
    expect(one.facets.map((f) => f.facetKey)).toEqual(['variables']);
    await expectProblem(
      await call(`/migrations/${seed.mApi}/diff?facetKey=nope`, { role: 'viewer' }),
      422,
      'validation_failed',
    );
  });

  it('[LIF-063] a Migration without an Analysis has an empty diff; an unknown one is 404', async () => {
    const empty = (await (
      await call(`/migrations/${seed.mNever}/diff`, { role: 'viewer' })
    ).json()) as {
      analysisId: string | null;
      facets: unknown[];
    };
    expect(empty).toMatchObject({ analysisId: null, facets: [] });
    await expectProblem(
      await call('/migrations/missing/diff', { role: 'viewer' }),
      404,
      'not_found',
    );
  });
});

describe('[API-020] [LIF-030] POST /routes/{id}/naming/preview', () => {
  type Preview = {
    summary: { affected: number; changed: number; invalid: number; colliding: number };
    collisions: { key: string; members: string[] }[];
    items: {
      migrationId: string;
      inScope: boolean;
      currentName: string | null;
      plannedName: string | null;
      changed: boolean;
      ruleSource: string;
      findings: { code: string; severity: string }[];
    }[];
    nextCursor: string | null;
  };
  const preview = (rule: unknown, query = '') =>
    call(`/routes/${seed.routeId}/naming/preview${query}`, {
      method: 'POST',
      role: 'operator',
      body: { rule },
    });
  const slugOnly = { steps: [{ var: 'repository', op: 'slug' }], template: '{repository}' };

  it('[LIF-030] evaluates a namespace rule over its repositories and shows current against planned names', async () => {
    const res = await preview({ scope: 'namespace', scopeRef: seed.ns1, pipeline: slugOnly });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Preview;
    expect(
      body.items.map((i) => [i.plannedName, i.currentName, i.changed, i.ruleSource, i.inScope]),
    ).toEqual(
      [seed.mApi, seed.mWeb]
        .sort()
        .map((id) =>
          id === seed.mApi
            ? ['api', 'plat-api', true, 'namespace', true]
            : ['web', 'plat-web', true, 'namespace', true],
        ),
    );
    expect(body.summary).toEqual({ affected: 2, changed: 2, invalid: 0, colliding: 0 });
  });

  it('[LIF-031] reports collisions with every member, also across namespaces', async () => {
    // Both repositories of ns1 get the constant name; ns2 keeps its default.
    const fixed = { steps: [{ var: 'repository', op: 'slug' }], template: 'fixed' };
    const body = (await (
      await preview({ scope: 'namespace', scopeRef: seed.ns1, pipeline: fixed })
    ).json()) as Preview;
    expect(body.collisions).toHaveLength(1);
    expect(body.collisions[0]?.members.sort()).toEqual([seed.mApi, seed.mWeb].sort());
    expect(body.summary.colliding).toBe(2);
    for (const item of body.items) {
      expect(item.findings.map((f) => f.code)).toContain('naming.collision');
    }
    // A repository-scope override that equals another repository's default name collides with it.
    const clash = (await (
      await preview({ scope: 'repository', scopeRef: seed.repoApi, override: 'ops-api' })
    ).json()) as Preview;
    expect(clash.collisions[0]?.members.sort()).toEqual([seed.mApi, seed.mOpsApi].sort());
    expect(clash.items.map((i) => i.migrationId).sort()).toEqual([seed.mApi, seed.mOpsApi].sort());
  });

  it('[LIF-031] an invalid name is a naming.invalid finding, not a request error', async () => {
    const body = (await (
      await preview({ scope: 'repository', scopeRef: seed.repoApi, override: 'bad name!' })
    ).json()) as Preview;
    expect(body.items[0]?.plannedName).toBeNull();
    expect(body.items[0]?.findings.map((f) => f.code)).toEqual(['naming.invalid']);
    expect(body.summary.invalid).toBe(1);
  });

  it('[LIF-030] saves nothing: no NamingRule row is written and no job is enqueued', async () => {
    enqueued.length = 0;
    await preview({ scope: 'namespace', scopeRef: seed.ns1, pipeline: slugOnly });
    expect(await t.db.privileged.namingRule.count()).toBe(0);
    expect(enqueued).toHaveLength(0);
  });

  it('[LIF-030] the candidate replaces the saved rule of its scope and a saved rule of another scope keeps its precedence', async () => {
    await t.db.privileged.namingRule.create({
      data: {
        routeId: seed.routeId,
        scope: 'repository',
        scopeRef: seed.repoWeb,
        pipeline: {},
        override: 'pinned-web',
      },
    });
    try {
      const body = (await (
        await preview({ scope: 'namespace', scopeRef: seed.ns1, pipeline: slugOnly })
      ).json()) as Preview;
      const web = body.items.find((i) => i.migrationId === seed.mWeb);
      expect(web).toMatchObject({ plannedName: 'pinned-web', ruleSource: 'override' });
      const api = body.items.find((i) => i.migrationId === seed.mApi);
      expect(api).toMatchObject({ plannedName: 'api', ruleSource: 'namespace' });
    } finally {
      await t.db.privileged.namingRule.deleteMany({});
    }
  });

  it('[API-011] items are cursor paginated', async () => {
    const first = (await (
      await preview({ scope: 'namespace', scopeRef: seed.ns1, pipeline: slugOnly }, '?limit=1')
    ).json()) as Preview;
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBe(first.items[0]?.migrationId);
    const second = (await (
      await preview(
        { scope: 'namespace', scopeRef: seed.ns1, pipeline: slugOnly },
        `?limit=1&cursor=${first.nextCursor}`,
      )
    ).json()) as Preview;
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.migrationId).not.toBe(first.items[0]?.migrationId);
    expect(second.nextCursor).toBeNull();
  });

  it('[API-011] bad input: both pipeline and override, an override at namespace scope, an unknown route or scope', async () => {
    await expectProblem(
      await preview({
        scope: 'repository',
        scopeRef: seed.repoApi,
        override: 'x',
        pipeline: slugOnly,
      }),
      422,
      'validation_failed',
    );
    await expectProblem(
      await preview({ scope: 'namespace', scopeRef: seed.ns1, override: 'x' }),
      422,
      'validation_failed',
    );
    await expectProblem(
      await preview({ scope: 'namespace', scopeRef: 'missing', pipeline: slugOnly }),
      404,
      'not_found',
    );
    await expectProblem(
      await call('/routes/missing/naming/preview', {
        method: 'POST',
        role: 'operator',
        body: { rule: { scope: 'namespace', scopeRef: seed.ns1, pipeline: slugOnly } },
      }),
      404,
      'not_found',
    );
  });
});
