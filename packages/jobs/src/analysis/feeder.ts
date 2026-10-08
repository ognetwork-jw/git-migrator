/**
 * The `analysis.feeder` processor (JOB-020, JOB-022): keeps the background pool of each source
 * Endpoint busy without exceeding it. Per source Endpoint it enqueues
 * `min(free background capacity / avgCallsPerAnalysis, maxBatch)` background analyses, picked in
 * priority order. Decisions: docs/adr/0312-analysis-feeder.md.
 */

import type { Db } from '@git-migrator/db';
import type { Logger } from '@git-migrator/observability';
import type { BucketSnapshot } from '@git-migrator/quota';
import { parseBucketKey } from '@git-migrator/quota';
import { databaseNow } from '../db-clock.ts';
import type { JobHandlers, JobRuntime } from '../runtime.ts';

/** Most analyses one Endpoint receives per tick (the spec's `maxBatch`, ADR-0312). */
export const DEFAULT_MAX_BATCH = 50;

/** How many pending background jobs the backlog count reads at most. */
const BACKLOG_READ_LIMIT = 10_000;

/** A Migration whose Analysis failed is skipped for 5 min, doubling per failure up to 6 h (ADR-0312). */
export const FAILURE_BACKOFF_BASE_MS = 5 * 60_000;
export const FAILURE_BACKOFF_CAP_MS = 6 * 3_600_000;

export function failureBackoffMs(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(FAILURE_BACKOFF_BASE_MS * 2 ** (failures - 1), FAILURE_BACKOFF_CAP_MS);
}

/** The feeder never selects Migrations in these statuses (JOB-022). */
export const FEEDER_EXCLUDED_STATUSES = [
  'running',
  'verified',
  'manually_completed',
  'rolled_back',
  'source_missing',
] as const;

export interface FeederDeps {
  readonly db: Db;
  readonly runtime: Pick<JobRuntime, 'enqueueAnalysis' | 'queue'>;
  /** `QuotaService.snapshot()`. */
  readonly quota: { snapshot(): Promise<BucketSnapshot[]> };
  readonly log: Logger;
  readonly maxBatch?: number;
  /** Test seam. */
  readonly now?: () => Date;
}

export interface FeederResult {
  /** Migration ids enqueued, per source Endpoint. */
  readonly enqueued: Readonly<Record<string, readonly string[]>>;
  readonly total: number;
}

/**
 * Free background calls of an Endpoint: per account the tightest bucket, summed over accounts
 * (credentials of one account share buckets; accounts are independent, JOB-040). A blocked or
 * clamped bucket counts as 0. `null` when nothing is known yet (no bucket was ever used).
 */
export function freeBackgroundCalls(
  endpointId: string,
  buckets: readonly BucketSnapshot[],
): number | null {
  const byAccount = new Map<string, number>();
  for (const b of buckets) {
    const key = parseBucketKey(b.bucketKey);
    if (key?.endpointId !== endpointId) continue;
    const free =
      b.blockedUntil !== null || b.nearLimit ? 0 : Math.max(0, b.backgroundLimit - b.used);
    const known = byAccount.get(key.accountKey);
    byAccount.set(key.accountKey, known === undefined ? free : Math.min(known, free));
  }
  if (byAccount.size === 0) return null;
  return [...byAccount.values()].reduce((a, b) => a + b, 0);
}

interface Candidate {
  readonly id: string;
  readonly routeId: string;
}

export async function runFeeder(
  deps: FeederDeps,
  options: { readonly shutdown: AbortSignal },
): Promise<FeederResult> {
  const { db, log } = deps;
  // One clock for every comparison below: the database's (`analysisStaleAt` marks, Analysis and
  // inventory times are all written with it).
  const now = deps.now ? deps.now() : await databaseNow(db);
  const maxBatch = deps.maxBatch ?? DEFAULT_MAX_BATCH;

  const routes = await db.route.findMany({
    where: {
      retiredAt: null,
      sourceEndpoint: { status: 'active' },
      targetEndpoint: { status: 'active' },
    },
    orderBy: { id: 'asc' },
  });
  if (routes.length === 0) return { enqueued: {}, total: 0 };
  const avgOf = new Map(
    routes.map((r) => [r.id, r.avgCallsPerAnalysis > 0 ? r.avgCallsPerAnalysis : 30]),
  );
  const routesByEndpoint = new Map<string, string[]>();
  for (const r of routes) {
    routesByEndpoint.set(r.sourceEndpointId, [
      ...(routesByEndpoint.get(r.sourceEndpointId) ?? []),
      r.id,
    ]);
  }

  // The backlog: background jobs that are queued have not spent their calls yet. Active ones have
  // started to (their calls are in the ledger), so only queued ones are charged; both are excluded
  // from the candidates (ADR-0312).
  const pending = await pendingBackground(deps);
  const pendingRoute = new Map<string, string>();
  if (pending.queued.size > 0) {
    const rows = await db.migration.findMany({
      where: { id: { in: [...pending.queued] } },
      select: { id: true, routeId: true },
    });
    for (const r of rows) pendingRoute.set(r.id, r.routeId);
  }
  const buckets = await deps.quota.snapshot();

  const enqueued: Record<string, string[]> = {};
  let total = 0;
  for (const [endpointId, routeIds] of routesByEndpoint) {
    if (options.shutdown.aborted) break;
    const free = freeBackgroundCalls(endpointId, buckets);
    const backlogCalls = [...pendingRoute]
      .filter(([, routeId]) => routeIds.includes(routeId))
      .reduce((sum, [, routeId]) => sum + (avgOf.get(routeId) ?? 30), 0);
    // No bucket yet: allow one first batch, which creates the buckets the next tick reads. The
    // backlog counts against it as well, so an empty ledger does not mean an unlimited queue.
    let budget =
      (free === null ? maxBatch * Math.max(...routeIds.map((id) => avgOf.get(id) ?? 30)) : free) -
      backlogCalls;
    const candidates = await candidatesFor(db, routeIds, now, pending.all, maxBatch);
    const picked: string[] = [];
    for (const c of candidates) {
      if (picked.length >= maxBatch) break;
      const cost = avgOf.get(c.routeId) ?? 30;
      if (cost > budget) break;
      budget -= cost;
      picked.push(c.id);
    }
    for (const id of picked) {
      await deps.runtime.enqueueAnalysis(id, 'background');
    }
    if (picked.length > 0) {
      enqueued[endpointId] = picked;
      total += picked.length;
    }
  }
  log.info({ total, endpoints: Object.keys(enqueued).length }, 'analysis feeder tick');
  return { enqueued, total };
}

async function pendingBackground(
  deps: FeederDeps,
): Promise<{ all: Set<string>; queued: Set<string> }> {
  const queue = deps.runtime.queue('analysis-background');
  const jobs = await queue.getJobs(
    ['waiting', 'active', 'delayed', 'prioritized'],
    0,
    BACKLOG_READ_LIMIT - 1,
  );
  const all = new Set<string>();
  const queued = new Set<string>();
  for (const job of jobs) {
    const id = (job?.data as { migrationId?: unknown } | undefined)?.migrationId;
    if (typeof id !== 'string') continue;
    all.add(id);
    if ((await job.getState()) !== 'active') queued.add(id);
  }
  return { all, queued };
}

/**
 * JOB-022 priority order, with endpoint Migrations first (JOB-020: after every completed
 * inventory): wave members never analyzed, wave members stale, never analyzed, stale (oldest
 * `analysisStaleAt` first).
 */
async function candidatesFor(
  db: Db,
  routeIds: readonly string[],
  now: Date,
  pending: ReadonlySet<string>,
  limit: number,
): Promise<Candidate[]> {
  const eligible = {
    routeId: { in: [...routeIds] },
    status: { notIn: [...FEEDER_EXCLUDED_STATUSES] },
    // The failure backoff, in SQL: Migrations that wait never crowd out healthy ones.
    OR: [{ analysisRetryAt: null }, { analysisRetryAt: { lte: now } }],
  };
  const repository = {
    ...eligible,
    scope: 'repository' as const,
    sourceRepository: { presence: 'present' as const },
  };
  const stale = { latestAnalysisId: { not: null }, analysisStaleAt: { lte: now } };
  const never = { latestAnalysisId: null };
  const take = limit + pending.size;
  const pick = (where: object, orderBy: object[]) =>
    db.migration.findMany({
      where: where as never,
      orderBy: orderBy as never,
      take,
      select: { id: true, routeId: true },
    });
  const [endpoint, waveNever, waveStale, plainNever, plainStale] = await Promise.all([
    endpointCandidates(db, routeIds, eligible, now),
    pick({ ...repository, ...never, waveId: { not: null } }, [{ createdAt: 'asc' }, { id: 'asc' }]),
    pick({ ...repository, ...stale, waveId: { not: null } }, [
      { analysisStaleAt: 'asc' },
      { id: 'asc' },
    ]),
    pick({ ...repository, ...never }, [{ createdAt: 'asc' }, { id: 'asc' }]),
    pick({ ...repository, ...stale }, [{ analysisStaleAt: 'asc' }, { id: 'asc' }]),
  ]);
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const c of [...endpoint, ...waveNever, ...waveStale, ...plainNever, ...plainStale]) {
    if (seen.has(c.id) || pending.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

/** Endpoint Migrations that were never analyzed, are stale, or predate the latest inventory. */
async function endpointCandidates(
  db: Db,
  routeIds: readonly string[],
  eligible: object,
  now: Date,
): Promise<Candidate[]> {
  const rows = await db.migration.findMany({
    where: { ...(eligible as object), scope: 'endpoint' } as never,
    select: {
      id: true,
      routeId: true,
      latestAnalysisId: true,
      analysisStaleAt: true,
      latestAnalysis: { select: { createdAt: true } },
      route: { select: { sourceEndpointId: true, targetEndpointId: true } },
    },
    orderBy: { id: 'asc' },
  });
  const out: Candidate[] = [];
  const inventoried = new Map<string, Date | null>();
  const lastInventory = async (endpointId: string): Promise<Date | null> => {
    if (!inventoried.has(endpointId)) {
      const row = await db.repository.findFirst({
        where: { endpointId },
        orderBy: { lastInventoriedAt: 'desc' },
        select: { lastInventoriedAt: true },
      });
      inventoried.set(endpointId, row?.lastInventoriedAt ?? null);
    }
    return inventoried.get(endpointId) ?? null;
  };
  for (const m of rows) {
    if (!routeIds.includes(m.routeId)) continue;
    const analyzedAt = m.latestAnalysis?.createdAt ?? null;
    let due =
      m.latestAnalysisId === null || (m.analysisStaleAt !== null && m.analysisStaleAt <= now);
    if (!due && analyzedAt) {
      for (const endpointId of [m.route.sourceEndpointId, m.route.targetEndpointId]) {
        const seen = await lastInventory(endpointId);
        if (seen !== null && seen > analyzedAt) due = true;
      }
    }
    if (due) out.push({ id: m.id, routeId: m.routeId });
  }
  return out;
}

/** The `analysis.feeder` handler (JOB-020), replacing the placeholder (ADR-0212). */
export function feederHandlers(deps: FeederDeps): JobHandlers {
  return {
    'analysis.feeder': (_payload, ctx) => runFeeder(deps, { shutdown: ctx.shutdown }),
  };
}
