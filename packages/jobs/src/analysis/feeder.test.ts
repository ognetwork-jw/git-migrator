import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import { createLogger } from '@git-migrator/observability';
import type { BucketSnapshot } from '@git-migrator/quota';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrateBullmqSchema } from '../connection.ts';
import { JobRuntime } from '../runtime.ts';
import {
  FAILURE_BACKOFF_CAP_MS,
  failureBackoffMs,
  feederHandlers,
  freeBackgroundCalls,
  runFeeder,
} from './feeder.ts';

const log = createLogger({ level: 'silent' });
const live = new AbortController();
let t: TestDatabase;
let runtime: JobRuntime;
let n = 0;

beforeAll(async () => {
  t = await createTestDatabase('gm_t061f_');
  await migrateBullmqSchema(t.connectionString);
  runtime = new JobRuntime({
    connectionString: t.connectionString,
    log,
    workerCount: 0,
    applicationName: 'gm-t061-feeder',
  });
  await runtime.waitUntilReady();
}, 120_000);

beforeEach(async () => {
  // Each test sees only the Route it seeds.
  await t.db.privileged.route.updateMany({ data: { retiredAt: new Date() } });
});

afterEach(async () => {
  await runtime.queue('analysis-background').drain(true);
});

afterAll(async () => {
  await runtime?.close();
  await t?.drop();
}, 60_000);

function bucket(endpointId: string, over: Partial<BucketSnapshot> = {}): BucketSnapshot {
  return {
    bucketKey: `${endpointId}:acct:repository-data`,
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
    ...over,
  };
}

async function seedRoute(avg = 30) {
  const db = t.db.privileged;
  const k = ++n;
  const endpoint = (id: string) =>
    db.endpoint.create({
      data: {
        id,
        providerType: 'type-a',
        displayName: id,
        baseUrl: `http://${id}.test`,
        status: 'active',
        configHash: 'h',
      },
    });
  const source = await endpoint(`fsrc-${k}`);
  const target = await endpoint(`fdst-${k}`);
  const route = await db.route.create({
    data: {
      id: `froute-${k}`,
      sourceEndpointId: source.id,
      targetEndpointId: target.id,
      targetNamespacePath: 'acme',
      policies: {},
      defaults: {},
      configHash: 'h',
      sourcePostAction: 'read-only',
      avgCallsPerAnalysis: avg,
    },
  });
  const ns = await db.namespace.create({
    data: { endpointId: source.id, providerId: 'ns', kind: 'project', slug: 'p', name: 'p' },
  });
  return { route, source, target, ns };
}

type World = Awaited<ReturnType<typeof seedRoute>>;

async function seedMigration(
  w: World,
  slug: string,
  over: {
    status?: 'discovered' | 'analyzed' | 'running' | 'verified' | 'source_missing' | 'migrated';
    analyzed?: 'fresh' | 'stale';
    staleAt?: Date;
    waveId?: string;
    presence?: 'present' | 'missing';
  } = {},
) {
  const db = t.db.privileged;
  const repo = await db.repository.create({
    data: {
      endpointId: w.source.id,
      namespaceId: w.ns.id,
      providerId: `u-${slug}`,
      slug,
      name: slug,
      fullPath: `p/${slug}`,
      isPrivate: true,
      presence: over.presence ?? 'present',
      lastInventoriedAt: new Date(),
    },
  });
  const m = await db.migration.create({
    data: {
      scope: 'repository',
      routeId: w.route.id,
      sourceRepositoryId: repo.id,
      status: over.status ?? 'discovered',
      ...(over.waveId ? { waveId: over.waveId } : {}),
    },
  });
  if (over.analyzed) {
    const a = await db.analysis.create({
      data: { migrationId: m.id, readiness: 'ready', translation: {} },
    });
    await db.migration.update({
      where: { id: m.id },
      data: {
        latestAnalysisId: a.id,
        analysisStaleAt:
          over.analyzed === 'stale'
            ? (over.staleAt ?? new Date(Date.now() - 1000))
            : new Date(Date.now() + 86_400_000),
      },
    });
  }
  return m;
}

const feed = (
  snapshot: BucketSnapshot[],
  extra: { maxBatch?: number; shutdown?: AbortSignal; now?: Date } = {},
) =>
  runFeeder(
    {
      db: t.db.privileged,
      runtime,
      quota: { snapshot: async () => snapshot },
      log,
      ...(extra.maxBatch ? { maxBatch: extra.maxBatch } : {}),
      ...(extra.now ? { now: () => extra.now as Date } : {}),
    },
    { shutdown: extra.shutdown ?? live.signal },
  );

const pendingIds = async () =>
  (
    await runtime
      .queue('analysis-background')
      .getJobs(['waiting', 'delayed', 'prioritized', 'active'])
  ).map((j) => (j.data as { migrationId: string }).migrationId);

describe('freeBackgroundCalls', () => {
  it('[JOB-020] takes the tightest bucket per account and sums the accounts', () => {
    const buckets = [
      bucket('e1', { bucketKey: 'e1:a:repository-data', used: 100 }),
      bucket('e1', { bucketKey: 'e1:a:webhooks', used: 800 }),
      bucket('e1', { bucketKey: 'e1:b:repository-data', used: 0 }),
      bucket('e2', { bucketKey: 'e2:a:repository-data', used: 0 }),
    ];
    // a: min(755, 55) = 55; b: 855; e2 is another Endpoint.
    expect(freeBackgroundCalls('e1', buckets)).toBe(910);
  });

  it('[JOB-020] a blocked or clamped bucket counts as nothing; no bucket at all is unknown', () => {
    expect(freeBackgroundCalls('e1', [bucket('e1', { blockedUntil: new Date() })])).toBe(0);
    expect(freeBackgroundCalls('e1', [bucket('e1', { nearLimit: true })])).toBe(0);
    expect(freeBackgroundCalls('e1', [bucket('e1', { used: 5000 })])).toBe(0);
    expect(freeBackgroundCalls('e1', [])).toBeNull();
    expect(freeBackgroundCalls('e1', [bucket('e2')])).toBeNull();
  });
});

describe('failure backoff (ADR-0312)', () => {
  it('[JOB-020] backs off 5 minutes, doubling per failure, up to 6 hours', () => {
    expect(failureBackoffMs(0)).toBe(0);
    expect(failureBackoffMs(1)).toBe(300_000);
    expect(failureBackoffMs(2)).toBe(600_000);
    expect(failureBackoffMs(3)).toBe(1_200_000);
    expect(failureBackoffMs(30)).toBe(FAILURE_BACKOFF_CAP_MS);
    expect(FAILURE_BACKOFF_CAP_MS).toBe(6 * 3_600_000);
  });

  it('[JOB-020] a failing Migration is not picked again within its backoff while others are', async () => {
    const w = await seedRoute(30);
    const failing = await seedMigration(w, 'bo-failing');
    const healthy = await seedMigration(w, 'bo-healthy');
    const now = new Date('2030-06-01T12:00:00Z');
    const retryIn = (minutes: number) => new Date(now.getTime() + minutes * 60_000);
    const mark = (retryAt: Date) =>
      t.db.privileged.migration.update({
        where: { id: failing.id },
        data: { analysisFailedAt: now, analysisRetryAt: retryAt, analysisFailureCount: 2 },
      });
    await mark(retryIn(4));
    const first = await feed([bucket(w.source.id)], { now });
    expect(first.enqueued[w.source.id]).toEqual([healthy.id]);
    await runtime.queue('analysis-background').drain(true);
    // The retry time has passed: due again.
    await mark(retryIn(-1));
    const due = (await feed([bucket(w.source.id)], { now })).enqueued[w.source.id] ?? [];
    expect([...due].sort()).toEqual([failing.id, healthy.id].sort());
  });

  it('[JOB-020] many Migrations in a long backoff do not crowd out a healthy one', async () => {
    const w = await seedRoute(30);
    const now = new Date('2030-06-01T12:00:00Z');
    const later = new Date(now.getTime() + 3_600_000);
    // Older than the healthy one, so they sort first: more than any read window would hold.
    for (let i = 0; i < 25; i++) {
      const m = await seedMigration(w, `crowd-${i}`);
      await t.db.privileged.migration.update({
        where: { id: m.id },
        data: { analysisFailedAt: now, analysisRetryAt: later, analysisFailureCount: 5 },
      });
    }
    const healthy = await seedMigration(w, 'crowd-healthy');
    const out = await feed([bucket(w.source.id)], { now, maxBatch: 2 });
    expect(out.enqueued[w.source.id]).toEqual([healthy.id]);
  });

  it('[JOB-020] the backlog counts against an unknown capacity as well', async () => {
    const w = await seedRoute(30);
    for (let i = 0; i < 6; i++) await seedMigration(w, `ub${i}`);
    expect((await feed([], { maxBatch: 2 })).total).toBe(2);
    expect((await feed([], { maxBatch: 2 })).total).toBe(0);
  });
});

describe('runFeeder', () => {
  it('[JOB-020] enqueues min(free / avgCalls, maxBatch) background analyses, deduplicated', async () => {
    const w = await seedRoute(30);
    for (let i = 0; i < 12; i++) await seedMigration(w, `a${i}`);
    // 300 free / 30 per analysis = 10.
    const used = 855 - 300;
    const out = await feed([bucket(w.source.id, { used })]);
    expect(out.enqueued[w.source.id]).toHaveLength(10);
    expect((await pendingIds()).length).toBe(10);
    // The same tick again finds the backlog spending that capacity: nothing more.
    const again = await feed([bucket(w.source.id, { used })]);
    expect(again.total).toBe(0);
    expect((await pendingIds()).length).toBe(10);
  });

  it('[JOB-020] maxBatch caps a tick, and an unknown capacity allows one first batch', async () => {
    const w = await seedRoute(30);
    for (let i = 0; i < 8; i++) await seedMigration(w, `b${i}`);
    const capped = await feed([bucket(w.source.id)], { maxBatch: 3 });
    expect(capped.enqueued[w.source.id]).toHaveLength(3);
    await runtime.queue('analysis-background').drain(true);
    const first = await feed([], { maxBatch: 2 });
    expect(first.enqueued[w.source.id]).toHaveLength(2);
  });

  it('[JOB-020] a blocked, clamped or exhausted bucket enqueues nothing', async () => {
    const w = await seedRoute(30);
    await seedMigration(w, 'c0');
    for (const over of [
      { blockedUntil: new Date(Date.now() + 60_000) },
      { nearLimit: true },
      { used: 855 },
    ]) {
      expect((await feed([bucket(w.source.id, over)])).total).toBe(0);
    }
    expect(await pendingIds()).toEqual([]);
  });

  it('[JOB-020] the cost of an analysis is the Route mean: a dearer Route gets fewer', async () => {
    const w = await seedRoute(100);
    for (let i = 0; i < 6; i++) await seedMigration(w, `d${i}`);
    const out = await feed([bucket(w.source.id, { used: 855 - 250 })]);
    expect(out.enqueued[w.source.id]).toHaveLength(2);
  });

  it('[JOB-022] picks wave members never analyzed, wave members stale, never analyzed, then stale oldest first', async () => {
    const w = await seedRoute(30);
    const wave = await t.db.privileged.wave.create({ data: { name: `wave-${w.route.id}` } });
    const old = new Date(Date.now() - 3 * 86_400_000);
    const newer = new Date(Date.now() - 1_000);
    const staleNew = await seedMigration(w, 'e-stale-new', { analyzed: 'stale', staleAt: newer });
    const staleOld = await seedMigration(w, 'e-stale-old', { analyzed: 'stale', staleAt: old });
    const never = await seedMigration(w, 'e-never');
    const waveStale = await seedMigration(w, 'e-wave-stale', {
      analyzed: 'stale',
      waveId: wave.id,
    });
    const waveNever = await seedMigration(w, 'e-wave-never', { waveId: wave.id });
    const out = await feed([bucket(w.source.id)]);
    expect(out.enqueued[w.source.id]).toEqual([
      waveNever.id,
      waveStale.id,
      never.id,
      staleOld.id,
      staleNew.id,
    ]);
  });

  it('[JOB-022] never selects running, verified, manually completed, rolled back or source-missing Migrations, a fresh Analysis or a missing source', async () => {
    const w = await seedRoute(30);
    for (const status of ['running', 'verified', 'source_missing'] as const) {
      await seedMigration(w, `f-${status}`, { status });
    }
    await t.db.privileged.migration.updateMany({
      where: { routeId: w.route.id },
      data: { status: 'running' },
    });
    await seedMigration(w, 'f-fresh', { analyzed: 'fresh', status: 'analyzed' });
    await seedMigration(w, 'f-missing', { presence: 'missing' });
    for (const status of ['manually_completed', 'rolled_back'] as const) {
      const m = await seedMigration(w, `f-${status}`);
      await t.db.privileged.migration.update({ where: { id: m.id }, data: { status } });
    }
    const ok = await seedMigration(w, 'f-ok', { status: 'discovered' });
    const out = await feed([bucket(w.source.id)]);
    expect(out.enqueued[w.source.id]).toEqual([ok.id]);
  });

  it('[JOB-020] enqueues the endpoint Migration when never analyzed, stale, or older than the latest inventory', async () => {
    const w = await seedRoute(30);
    const db = t.db.privileged;
    const endpointMigration = await db.migration.create({
      data: { scope: 'endpoint', routeId: w.route.id },
    });
    expect((await feed([bucket(w.source.id)])).enqueued[w.source.id]).toEqual([
      endpointMigration.id,
    ]);
    await runtime.queue('analysis-background').drain(true);

    const analysis = await db.analysis.create({
      data: { migrationId: endpointMigration.id, readiness: 'ready', translation: {} },
    });
    await db.migration.update({
      where: { id: endpointMigration.id },
      data: { latestAnalysisId: analysis.id, analysisStaleAt: new Date(Date.now() + 86_400_000) },
    });
    // Analyzed after the last inventory: not due.
    await db.repository.create({
      data: {
        endpointId: w.source.id,
        namespaceId: w.ns.id,
        providerId: 'inv-old',
        slug: 'inv-old',
        name: 'inv-old',
        fullPath: 'p/inv-old',
        isPrivate: true,
        lastInventoriedAt: new Date(Date.now() - 86_400_000),
      },
    });
    expect((await feed([bucket(w.source.id)])).total).toBe(0);
    // A later inventory pass makes it due.
    await db.repository.updateMany({
      where: { endpointId: w.source.id },
      data: { lastInventoriedAt: new Date(Date.now() + 1000) },
    });
    expect((await feed([bucket(w.source.id)])).enqueued[w.source.id]).toEqual([
      endpointMigration.id,
    ]);
  });

  it('[JOB-020] stops when the process shuts down, and retired Routes are ignored', async () => {
    const w = await seedRoute(30);
    await seedMigration(w, 'g0');
    const stop = new AbortController();
    stop.abort();
    expect((await feed([bucket(w.source.id)], { shutdown: stop.signal })).total).toBe(0);
    await t.db.privileged.route.update({
      where: { id: w.route.id },
      data: { retiredAt: new Date() },
    });
    expect((await feed([bucket(w.source.id)])).total).toBe(0);
  });

  it('[JOB-020] the handler replaces the placeholder and feeds the background queue', async () => {
    const w = await seedRoute(30);
    const m = await seedMigration(w, 'h0');
    const handlers = feederHandlers({
      db: t.db.privileged,
      runtime,
      quota: { snapshot: async () => [] },
      log,
    });
    const handler = handlers['analysis.feeder'];
    expect(handler).toBeTypeOf('function');
    await handler?.({}, { shutdown: live.signal, log, queue: 'maintenance', job: {} as never });
    expect(await pendingIds()).toContain(m.id);
  });
});
