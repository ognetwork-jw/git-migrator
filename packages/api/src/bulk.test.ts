import { type AuthService, issueApiKey } from '@git-migrator/auth';
import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import { runFeeder } from '@git-migrator/jobs';
import { createLogger } from '@git-migrator/observability';
import type { BucketSnapshot } from '@git-migrator/quota';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApiApp } from './app.ts';
import { BULK_MAX } from './bulk.ts';
import { createEventHub } from './events.ts';
import { PROBLEM_BASE } from './problem.ts';
import type { ApiServices } from './services.ts';

const ORIGIN = 'http://localhost:3000';
type Role = 'viewer' | 'operator' | 'admin';

let t: TestDatabase;
let app: ReturnType<typeof createApiApp>;
const keys = {} as Record<Role, string>;
const actors = {} as Record<Role, string>;
let failQueue = false;
const analysisJobs: string[] = [];
const runJobs: { runId: string; routing: unknown }[] = [];
let enqueueRunCalls = 0;
let enqueueAnalysisCalls = 0;

const services: ApiServices = {
  jobs: {
    enqueue: () => Promise.resolve({} as never),
    enqueueAnalysis: (migrationId: string) => {
      enqueueAnalysisCalls++;
      if (failQueue) return Promise.reject(new Error('queue down'));
      analysisJobs.push(migrationId);
      return Promise.resolve({} as never);
    },
    enqueueRun: (runId: string, routing: unknown) => {
      enqueueRunCalls++;
      if (failQueue) return Promise.reject(new Error('queue down'));
      runJobs.push({ runId, routing });
      return Promise.resolve({} as never);
    },
    queue: () => ({ getJobs: () => Promise.resolve([]) }) as never,
  } as never,
  quota: { snapshot: () => Promise.resolve([]) },
  registry: {} as never,
};

let n = 0;
let routeId = '';
let nsId = '';
let waveId = '';

async function seedWorld() {
  const db = t.db.privileged;
  const mk = (id: string, providerType: string) =>
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
  await mk('src', 'type-a');
  await mk('dst', 'type-b');
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
  routeId = route.id;
  const ns = await db.namespace.create({
    data: { endpointId: 'src', providerId: 'ns', kind: 'project', slug: 'p', name: 'P' },
  });
  nsId = ns.id;
  waveId = (await db.wave.create({ data: { name: 'wave-1' } })).id;
}

interface Over {
  status?: 'discovered' | 'analyzed' | 'running' | 'source_missing';
  readiness?: 'ready' | 'needs_attention' | 'blocked' | null;
  analysis?: 'fresh' | 'stale' | 'none';
  waveId?: string;
  scope?: 'repository' | 'endpoint';
}

/** A Migration, by default `analyzed`, `ready` with a fresh Analysis. */
async function mig(over: Over = {}): Promise<string> {
  const db = t.db.privileged;
  const k = ++n;
  const repo = await db.repository.create({
    data: {
      endpointId: 'src',
      namespaceId: nsId,
      providerId: `r-${k}`,
      slug: `r${k}`,
      name: `r${k}`,
      fullPath: `p/r${k}`,
      isPrivate: true,
      lastInventoriedAt: new Date(),
    },
  });
  const m = await db.migration.create({
    data: {
      scope: 'repository',
      routeId,
      sourceRepositoryId: repo.id,
      plannedTargetName: `r${k}`,
    },
  });
  const status = over.status ?? 'analyzed';
  const analysis = over.analysis ?? 'fresh';
  const data: Record<string, unknown> = {
    status,
    readiness: over.readiness === undefined ? 'ready' : over.readiness,
    ...(over.waveId ? { waveId: over.waveId } : {}),
  };
  if (analysis !== 'none') {
    const a = await db.analysis.create({
      data: { migrationId: m.id, readiness: 'ready', translation: {} },
    });
    data.latestAnalysisId = a.id;
    if (analysis === 'stale') data.analysisStaleAt = new Date(Date.now() - 1000);
  }
  await db.migration.update({ where: { id: m.id }, data: data as never });
  return m.id;
}

beforeAll(async () => {
  t = await createTestDatabase('gm_t088_');
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
  for (const role of ['viewer', 'operator', 'admin'] as const) {
    const actor = await t.db.privileged.actor.create({
      data: { kind: 'service', displayName: `svc ${role}`, role },
    });
    const issued = await issueApiKey(t.db.privileged, {
      actorId: actor.id,
      name: 'k',
      issuedBy: actor.id,
    });
    keys[role] = issued.key;
    actors[role] = actor.id;
  }
  await seedWorld();
}, 120_000);

beforeEach(() => {
  failQueue = false;
  enqueueRunCalls = 0;
  enqueueAnalysisCalls = 0;
  analysisJobs.length = 0;
  runJobs.length = 0;
});

afterAll(async () => {
  await t?.drop();
});

const bulk = (body: unknown, role: Role = 'operator') =>
  app.request(`${ORIGIN}/api/v1/migrations/bulk`, {
    method: 'POST',
    headers: { authorization: `Bearer ${keys[role]}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

interface Result {
  accepted: string[];
  skipped: { id: string; reason: string }[];
}
const ok = async (res: Response): Promise<Result> => {
  expect(res.status).toBe(200);
  return (await res.json()) as Result;
};
const reasons = (r: Result) => Object.fromEntries(r.skipped.map((s) => [s.id, s.reason]));

describe('POST /migrations/bulk', () => {
  it('[LIF-090] migrate-ready creates Runs only for ready Migrations with a fresh Analysis and skips the rest with reasons', async () => {
    const good1 = await mig();
    const good2 = await mig();
    const attention = await mig({ readiness: 'needs_attention' });
    const blocked = await mig({ readiness: 'blocked' });
    const stale = await mig({ analysis: 'stale' });
    const never = await mig({ analysis: 'none', status: 'discovered', readiness: null });
    const running = await mig({ status: 'running' });
    const missing = await mig({ status: 'source_missing' });
    const ids = [good1, good2, attention, blocked, stale, never, running, missing, 'nope'];
    const out = await ok(await bulk({ ids, action: 'migrate-ready' }));
    expect(out.accepted.sort()).toEqual([good1, good2].sort());
    expect(reasons(out)).toEqual({
      [attention]: 'not_ready',
      [blocked]: 'not_ready',
      [stale]: 'analysis_stale',
      [never]: 'not_ready',
      [running]: 'not_permitted',
      [missing]: 'source_missing',
      nope: 'not_found',
    });
    const runs = await t.db.privileged.run.findMany({ where: { migrationId: { in: ids } } });
    expect(runs.map((r) => r.migrationId).sort()).toEqual([good1, good2].sort());
    expect(runs.every((r) => r.kind === 'migrate' && r.triggeredById === actors.operator)).toBe(
      true,
    );
    expect(runJobs.map((j) => j.runId).sort()).toEqual(runs.map((r) => r.id).sort());
    const after = await t.db.privileged.migration.findUnique({ where: { id: good1 } });
    expect(after?.status).toBe('running');
    const unchanged = await t.db.privileged.migration.findUnique({ where: { id: attention } });
    expect(unchanged?.status).toBe('analyzed');
  });

  it('[LIF-090] never trusts the client: a Migration that became stale or got an active Run is skipped', async () => {
    const m = await mig();
    const first = await ok(await bulk({ ids: [m], action: 'migrate-ready' }));
    expect(first.accepted).toEqual([m]);
    const again = await ok(await bulk({ ids: [m], action: 'migrate-ready' }));
    expect(again.accepted).toEqual([]);
    expect(reasons(again)[m]).toBe('run_active');
    // A queued Run on a Migration that still looks ready is the concurrency guard's `run.active`.
    const other = await mig();
    await t.db.privileged.run.create({
      data: {
        migrationId: other,
        kind: 'verify',
        triggeredById: actors.operator,
        options: {},
        status: 'queued',
      },
    });
    const guarded = await ok(await bulk({ ids: [other], action: 'migrate-ready' }));
    expect(reasons(guarded)[other]).toBe('run_active');
  });

  it('[LIF-090] a queue fault cancels the created Run and reports queue_unavailable', async () => {
    const m = await mig();
    failQueue = true;
    const out = await ok(await bulk({ ids: [m], action: 'migrate-ready' }));
    expect(out.accepted).toEqual([]);
    expect(reasons(out)[m]).toBe('queue_unavailable');
    const after = await t.db.privileged.migration.findUnique({ where: { id: m } });
    expect(after?.status).toBe('analyzed');
    const runs = await t.db.privileged.run.findMany({ where: { migrationId: m } });
    expect(runs.map((r) => r.status)).toEqual(['cancelled']);
  });

  it('[LIF-090] a dead queue is tried once: the rest are skipped without creating Runs, and the cancelled Run is audited', async () => {
    const a = await mig();
    const b = await mig();
    const c = await mig();
    failQueue = true;
    const out = await ok(await bulk({ ids: [a, b, c], action: 'migrate-ready' }));
    expect(out.accepted).toEqual([]);
    expect(out.skipped.map((s) => s.reason)).toEqual(Array(3).fill('queue_unavailable'));
    expect(enqueueRunCalls).toBe(1);
    const runs = await t.db.privileged.run.findMany({ where: { migrationId: { in: [a, b, c] } } });
    expect(runs).toHaveLength(1);
    const events = await t.db.privileged.auditEvent.findMany({
      where: { subjectType: 'run', subjectId: runs[0]?.id as string },
    });
    expect(events.map((e) => e.action).sort()).toEqual(['run.cancel', 'run.create']);
    const again = await ok(await bulk({ ids: [a, b], action: 'analyze' }));
    expect(again.accepted).toEqual([]);
    expect(enqueueAnalysisCalls).toBe(1);
  });

  it('[LIF-090] audits the previous Wave read under the lock and answers 404 for a Wave deleted since', async () => {
    const other = (await t.db.privileged.wave.create({ data: { name: 'wave-other' } })).id;
    const m = await mig({ waveId: other });
    const out = await ok(await bulk({ ids: [m], action: 'assign-to-wave', waveId }));
    expect(out.accepted).toEqual([m]);
    const event = await t.db.privileged.auditEvent.findFirst({
      where: { subjectId: m, action: 'migration.wave_assign' },
    });
    expect(event?.data).toMatchObject({ waveId, previousWaveId: other });
    await t.db.privileged.wave.delete({ where: { id: other } });
    const gone = await bulk({ ids: [m], action: 'assign-to-wave', waveId: other });
    expect(gone.status).toBe(404);
  });

  it('[LIF-090] refuses an ids array longer than 1000 before de-duplicating', async () => {
    const res = await bulk({ ids: Array(1001).fill('same'), action: 'analyze' });
    expect(res.status).toBe(422);
  });

  it('[LIF-090] analyze enqueues interactive analyses and skips missing sources and endpoint Migrations', async () => {
    const a = await mig();
    const b = await mig({ status: 'discovered', readiness: null, analysis: 'none' });
    const gone = await mig({ status: 'source_missing' });
    const endpointMigration = await t.db.privileged.migration.create({
      data: { scope: 'endpoint', routeId: 'route-1' },
    });
    const out = await ok(
      await bulk({ ids: [a, b, gone, endpointMigration.id], action: 'analyze' }),
    );
    expect(out.accepted).toEqual([a, b]);
    expect(reasons(out)).toEqual({
      [gone]: 'source_missing',
      [endpointMigration.id]: 'not_repository',
    });
    expect(analysisJobs).toEqual([a, b]);
    const audit = await t.db.privileged.auditEvent.findMany({
      where: { action: 'migration.analyze', subjectId: { in: [a, b] } },
    });
    expect(audit).toHaveLength(2);
    expect(audit.every((e) => e.actorId === actors.operator)).toBe(true);
  });

  it('[LIF-090] assign-to-wave and remove-from-wave report who was already in or out, and audit each change', async () => {
    const a = await mig();
    const b = await mig({ waveId });
    const out = await ok(await bulk({ ids: [a, b], action: 'assign-to-wave', waveId }));
    expect(out.accepted).toEqual([a]);
    expect(reasons(out)).toEqual({ [b]: 'already_in_wave' });
    expect((await t.db.privileged.migration.findUnique({ where: { id: a } }))?.waveId).toBe(waveId);
    const c = await mig();
    const removed = await ok(await bulk({ ids: [a, b, c], action: 'remove-from-wave' }));
    expect(removed.accepted.sort()).toEqual([a, b].sort());
    expect(reasons(removed)).toEqual({ [c]: 'not_in_wave' });
    expect((await t.db.privileged.migration.findUnique({ where: { id: b } }))?.waveId).toBeNull();
    const events = await t.db.privileged.auditEvent.findMany({
      where: { subjectId: a, action: { in: ['migration.wave_assign', 'migration.wave_remove'] } },
      orderBy: { at: 'asc' },
    });
    expect(events.map((e) => e.action)).toEqual(['migration.wave_assign', 'migration.wave_remove']);
  });

  it('[LIF-090] resolves a saved filter server-side and refuses one that matches more than the cap', async () => {
    const ns = await t.db.privileged.namespace.create({
      data: { endpointId: 'src', providerId: 'ns-f', kind: 'project', slug: 'f', name: 'F' },
    });
    const repo = await t.db.privileged.repository.create({
      data: {
        endpointId: 'src',
        namespaceId: ns.id,
        providerId: 'rf',
        slug: 'rf',
        name: 'rf',
        fullPath: 'f/rf',
        isPrivate: true,
        lastInventoriedAt: new Date(),
      },
    });
    const m = await t.db.privileged.migration.create({
      data: { scope: 'repository', routeId, sourceRepositoryId: repo.id },
    });
    const out = await ok(
      await bulk({
        filter: { routeId, namespaceId: ns.id },
        action: 'assign-to-wave',
        waveId,
      }),
    );
    expect(out.accepted).toEqual([m.id]);
    const fillers = Array.from({ length: BULK_MAX + 1 }, (_, i) => i);
    const repos = await t.db.privileged.repository.createManyAndReturn({
      data: fillers.map((i) => ({
        endpointId: 'src',
        namespaceId: ns.id,
        providerId: `bulk-${i}`,
        slug: `bulk-${i}`,
        name: `bulk-${i}`,
        fullPath: `f/bulk-${i}`,
        isPrivate: true,
        lastInventoriedAt: new Date(),
      })),
    });
    await t.db.privileged.migration.createMany({
      data: repos.map((r) => ({ scope: 'repository', routeId, sourceRepositoryId: r.id })),
    });
    const tooMany = await bulk({
      filter: { routeId, namespaceId: ns.id },
      action: 'assign-to-wave',
      waveId,
    });
    expect(tooMany.status).toBe(422);
    expect(((await tooMany.json()) as { type: string }).type).toBe(
      `${PROBLEM_BASE}validation_failed`,
    );
    const tooManyIds = await bulk({
      ids: Array.from({ length: BULK_MAX + 1 }, (_, i) => `id-${i}`),
      action: 'analyze',
    });
    expect(tooManyIds.status).toBe(422);
  });

  it('[LIF-090] validates the request: exactly one of ids and filter, a waveId to assign, a known Wave', async () => {
    const m = await mig();
    expect((await bulk({ action: 'analyze' })).status).toBe(422);
    expect((await bulk({ ids: [m], filter: { routeId }, action: 'analyze' })).status).toBe(422);
    expect((await bulk({ ids: [m], action: 'assign-to-wave' })).status).toBe(422);
    expect((await bulk({ ids: [m], action: 'assign-to-wave', waveId: 'nope' })).status).toBe(404);
    expect((await bulk({ ids: [m], action: 'explode' })).status).toBe(422);
    expect((await bulk({ ids: [], action: 'analyze' })).status).toBe(422);
  });

  it('[LIF-090] requires the operator role for every action', async () => {
    const m = await mig();
    for (const action of ['analyze', 'migrate-ready', 'assign-to-wave', 'remove-from-wave']) {
      const res = await bulk({ ids: [m], action, waveId }, 'viewer');
      expect(res.status).toBe(403);
    }
    expect((await bulk({ ids: [m], action: 'remove-from-wave' }, 'admin')).status).toBe(200);
  });

  it('[LIF-090] wave priority reaches the feeder: Migrations bulk-assigned to a Wave are picked first', async () => {
    const db = t.db.privileged;
    await db.route.updateMany({
      where: { id: { not: 'feeder-route' } },
      data: { retiredAt: new Date() },
    });
    for (const id of ['fsrc', 'fdst']) {
      await db.endpoint.create({
        data: {
          id,
          providerType: 'type-a',
          displayName: id,
          baseUrl: `http://${id}.test`,
          status: 'active',
          configHash: 'h',
        },
      });
    }
    await db.route.create({
      data: {
        id: 'feeder-route',
        sourceEndpointId: 'fsrc',
        targetEndpointId: 'fdst',
        targetNamespacePath: 'acme',
        policies: {},
        defaults: {},
        configHash: 'h',
        sourcePostAction: 'read-only',
        avgCallsPerAnalysis: 30,
      },
    });
    const fns = await db.namespace.create({
      data: { endpointId: 'fsrc', providerId: 'fns', kind: 'project', slug: 'fp', name: 'FP' },
    });
    const made: string[] = [];
    for (let i = 0; i < 4; i++) {
      const repo = await db.repository.create({
        data: {
          endpointId: 'fsrc',
          namespaceId: fns.id,
          providerId: `fr-${i}`,
          slug: `fr${i}`,
          name: `fr${i}`,
          fullPath: `fp/fr${i}`,
          isPrivate: true,
          lastInventoriedAt: new Date(),
        },
      });
      const m = await db.migration.create({
        data: {
          scope: 'repository',
          routeId: 'feeder-route',
          sourceRepositoryId: repo.id,
          // Older rows come first among the unprioritized ones.
          createdAt: new Date(Date.now() - (10 - i) * 1000),
        },
      });
      made.push(m.id);
    }
    const [first, second, third, fourth] = made as [string, string, string, string];
    const out = await ok(await bulk({ ids: [fourth, third], action: 'assign-to-wave', waveId }));
    expect(out.accepted.sort()).toEqual([third, fourth].sort());
    const bucket: BucketSnapshot = {
      bucketKey: 'fsrc:acct:repository-data',
      limit: 1000,
      effectiveLimit: 950,
      backgroundLimit: 855,
      windowSeconds: 3600,
      used: 0,
      usedBackground: 0,
      usedInteractive: 0,
      remaining: null,
      resetAt: null,
      blockedUntil: null,
      nearLimit: false,
      backgroundClampedUntil: null,
      backgroundRatePerSecond: 0.2375,
    };
    const fed = await runFeeder(
      {
        db,
        runtime: {
          enqueueAnalysis: (id: string) => {
            analysisJobs.push(id);
            return Promise.resolve({} as never);
          },
          queue: () => ({ getJobs: () => Promise.resolve([]) }) as never,
        },
        quota: { snapshot: () => Promise.resolve([bucket]) },
        log: createLogger({ level: 'silent' }),
      },
      { shutdown: new AbortController().signal },
    );
    // The two Wave members (assigned in reverse order) lead, then the rest in creation order.
    expect(fed.enqueued.fsrc).toEqual([third, fourth, first, second]);
  });
});
