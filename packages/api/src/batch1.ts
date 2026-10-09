/**
 * Read and command endpoints, batch 1 (T-062, API-020): inventory refresh, analyze, dashboard,
 * quota, capability matrix, diff and naming preview. Decisions: ADR-0330, ADR-0331, ADR-0332.
 */
import { type Capability, can } from '@git-migrator/auth';
import {
  type ExistingTarget,
  type NamingPipeline,
  type NamingRules,
  planRouteNaming,
} from '@git-migrator/core';
import type { Db } from '@git-migrator/db';
import { routeNaming } from '@git-migrator/jobs';
import { estimateBackgroundEtaSeconds, parseBucketKey } from '@git-migrator/quota';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { type PageQuery, PageQuerySchema } from './pagination.ts';
import type { Principal } from './principal.ts';
import { ProblemError, ProblemSchema } from './problem.ts';
import { redactAtPath, redactFacetValue, redactText } from './redact.ts';
import { type ApiServices, requireService } from './services.ts';

interface Env {
  Variables: { principal: Principal };
}

export interface Batch1Deps {
  readonly db: { readonly privileged: Db };
  readonly services: Partial<ApiServices>;
  /** Told about a queue or database fault before it becomes a 503 (log safe fields only). */
  readonly onFault?: (error: unknown) => void;
  /** The validation hook of `createV1` (problem+json 422). */
  readonly validationHook: (result: { success: boolean; error?: z.ZodError }, c: Context) => void;
}

/** Queued background analyses the quota view reads from the queue at most. */
const BACKLOG_READ_LIMIT = 10_000;
/** Calls per Analysis assumed for a Route that has no mean yet (JOB-020). */
const DEFAULT_AVG_CALLS = 30;
/** Waves the dashboard lists; a Route has a handful, so more is a data problem, flagged not paged. */
const MAX_WAVES = 200;
/** Most Migrations a naming preview plans at once (collisions need the whole Route). */
const MAX_PREVIEW_MIGRATIONS = 20_000;
/** Runs the dashboard lists (UI-020). */
const RECENT_RUNS = 20;

const problemContent = { 'application/problem+json': { schema: ProblemSchema } };
const problems = (...codes: (401 | 403 | 404 | 409 | 422 | 503)[]) =>
  Object.fromEntries(
    codes.map((status) => [status, { description: 'Problem', content: problemContent }]),
  );
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });
const security: Record<string, string[]>[] = [{ bearerAuth: [] }, { sessionCookie: [] }];
const IdParam = z.object({ id: z.string().min(1).max(64) });

function requireCapability(c: Context<Env>, capability: Capability): void {
  if (!can(c.get('principal').actor, capability)) {
    throw new ProblemError('forbidden', { detail: `requires the ${capability} capability` });
  }
}

const iso = (date: Date | null | undefined): string | null => (date ? date.toISOString() : null);

// -- POST /inventory/refresh -------------------------------------------------------------------

const refreshRoute = createRoute({
  method: 'post',
  path: '/inventory/refresh',
  summary: 'Enqueue an inventory pass for one Endpoint, or for every active Endpoint',
  security,
  request: {
    body: {
      required: false,
      content: json(z.object({ endpointId: z.string().min(1).max(64).optional() })),
    },
  },
  responses: {
    202: {
      description: 'Enqueued (a pass already queued for an Endpoint counts as enqueued)',
      content: json(z.object({ endpoints: z.array(z.string()) })),
    },
    ...problems(401, 403, 404, 409, 422, 503),
  },
});

// -- POST /migrations/{id}/analyze --------------------------------------------------------------

const analyzeRoute = createRoute({
  method: 'post',
  path: '/migrations/{id}/analyze',
  summary: 'Enqueue an interactive analysis of a Migration',
  security,
  request: { params: IdParam },
  responses: {
    202: {
      description: 'Enqueued',
      content: json(
        z.object({ migrationId: z.string(), queue: z.literal('analysis-interactive') }),
      ),
    },
    ...problems(401, 403, 404, 409, 503),
  },
});

// -- GET /dashboard ------------------------------------------------------------------------------

const CountsSchema = z.record(z.string(), z.number().int());
const DashboardSchema = z
  .object({
    generatedAt: z.string(),
    routes: z.array(
      z.object({
        routeId: z.string(),
        sourceEndpointId: z.string(),
        targetEndpointId: z.string(),
        total: z.number().int(),
        byStatus: CountsSchema,
        byReadiness: CountsSchema,
        endpointMigration: z
          .object({
            migrationId: z.string(),
            status: z.string(),
            readiness: z.string().nullable(),
          })
          .nullable(),
      }),
    ),
    /** True when more Waves exist than the dashboard lists (the first MAX_WAVES by name). */
    wavesTruncated: z.boolean(),
    waves: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        targetDate: z.string().nullable(),
        total: z.number().int(),
        byStatus: CountsSchema,
      }),
    ),
    recentRuns: z.array(
      z.object({
        id: z.string(),
        migrationId: z.string(),
        kind: z.string(),
        status: z.string(),
        createdAt: z.string(),
        startedAt: z.string().nullable(),
        finishedAt: z.string().nullable(),
      }),
    ),
  })
  .openapi('Dashboard');

const dashboardRoute = createRoute({
  method: 'get',
  path: '/dashboard',
  summary: 'Aggregated counts for the dashboard (UI-020)',
  security,
  responses: {
    200: { description: 'Counts', content: json(DashboardSchema) },
    ...problems(401, 403),
  },
});

// -- GET /quota ----------------------------------------------------------------------------------

const QuotaBucketSchema = z.object({
  bucketKey: z.string(),
  endpointId: z.string().nullable(),
  accountKey: z.string().nullable(),
  resourceGroup: z.string().nullable(),
  limit: z.number(),
  effectiveLimit: z.number(),
  windowSeconds: z.number(),
  used: z.number(),
  pools: z.object({
    backgroundLimit: z.number(),
    usedBackground: z.number(),
    usedInteractive: z.number(),
  }),
  remaining: z.number().nullable(),
  resetAt: z.string().nullable(),
  blockedUntil: z.string().nullable(),
  nearLimit: z.boolean(),
  backgroundRatePerSecond: z.number(),
  /** Queued background analyses of the Endpoint this bucket belongs to. */
  backlog: z.number().int(),
  /** `backlog x avgCallsPerAnalysis / backgroundRatePerSecond` in seconds; `null` without background capacity. */
  backgroundEtaSeconds: z.number().nullable(),
});
const QuotaSchema = z
  .object({
    generatedAt: z.string(),
    /** Background analyses queued in all (waiting, delayed, prioritized). */
    backlogTotal: z.number().int(),
    /** True when the queue is longer than what is read to split it per Endpoint: bucket backlogs are then partial. */
    backlogTruncated: z.boolean(),
    buckets: z.array(QuotaBucketSchema),
  })
  .openapi('Quota');

const quotaRoute = createRoute({
  method: 'get',
  path: '/quota',
  summary: 'Quota usage per bucket, the background backlog and its ETA (JOB-047)',
  security,
  responses: {
    200: { description: 'Buckets', content: json(QuotaSchema) },
    ...problems(401, 403, 503),
  },
});

// -- GET /capability-matrix ---------------------------------------------------------------------

const FieldSupportSchema = z.looseObject({ kind: z.string() });
const MatrixSchema = z
  .object({
    ceiling: z.literal('static'),
    adapters: z.array(z.string()),
    rows: z.array(
      z.object({
        facet: z.string(),
        scope: z.enum(['repository', 'endpoint']),
        inScope: z.boolean(),
        cells: z.array(
          z.object({
            source: z.string(),
            target: z.string(),
            fidelity: z.string(),
            read: z.boolean(),
            write: z.boolean(),
            override: z.boolean(),
            fields: z.array(
              z.object({
                path: z.string(),
                source: FieldSupportSchema,
                target: FieldSupportSchema,
                fidelity: z.string(),
              }),
            ),
          }),
        ),
      }),
    ),
  })
  .openapi('CapabilityMatrix');

const matrixRoute = createRoute({
  method: 'get',
  path: '/capability-matrix',
  summary: 'Facet x source x target fidelity from the registered capabilities (static ceiling)',
  security,
  responses: {
    200: { description: 'The matrix', content: json(MatrixSchema) },
    ...problems(401, 403, 503),
  },
});

// -- GET /migrations/{id}/diff ------------------------------------------------------------------

const DiffFacetSchema = z.object({
  facetKey: z.string(),
  source: z.unknown().nullable(),
  desired: z.unknown().nullable(),
  target: z.unknown().nullable(),
  sourceUnreadable: z.array(z.string()),
  targetUnreadable: z.array(z.string()),
  sourceFetchedAt: z.string().nullable(),
  targetFetchedAt: z.string().nullable(),
  /** Per-field decisions of the translation (fidelity markers), as the Analysis stored them. */
  decisions: z.unknown().nullable(),
  overridden: z.boolean().nullable(),
  parity: z
    .object({
      status: z.string(),
      checkedAt: z.string(),
      diffs: z.array(z.object({ path: z.string(), source: z.unknown(), target: z.unknown() })),
      excluded: z.array(z.object({ path: z.string(), expectedDifferenceId: z.string() })),
    })
    .nullable(),
  expectedDifferences: z.array(
    z.object({
      id: z.string(),
      path: z.string(),
      reason: z.string(),
      note: z.string().nullable(),
      migrationId: z.string().nullable(),
    }),
  ),
});
const DiffSchema = z
  .object({
    migrationId: z.string(),
    analysisId: z.string().nullable(),
    analyzedAt: z.string().nullable(),
    facets: z.array(DiffFacetSchema),
  })
  .openapi('MigrationDiff');

const diffRoute = createRoute({
  method: 'get',
  path: '/migrations/{id}/diff',
  summary:
    'Latest Plan and Expected-Difference view: Snapshots, desired state and ParityResult side by side',
  security,
  request: { params: IdParam, query: z.object({ facetKey: z.string().min(1).max(64).optional() }) },
  responses: {
    200: { description: 'The diff', content: json(DiffSchema) },
    ...problems(401, 403, 404, 422),
  },
});

// -- POST /routes/{id}/naming/preview -----------------------------------------------------------

const NamingStepSchema = z.strictObject({
  var: z.string().min(1).max(64),
  op: z.string().min(1).max(32),
  arg: z.number().int().optional(),
  pattern: z.string().max(400).optional(),
  with: z.string().max(400).optional(),
});
const NamingPipelineSchema = z.strictObject({
  steps: z.array(NamingStepSchema).min(1).max(50),
  template: z.string().min(1).max(256),
});
const NamingRuleBodySchema = z
  .strictObject({
    scope: z.enum(['namespace', 'repository']),
    scopeRef: z.string().min(1).max(64),
    pipeline: NamingPipelineSchema.optional(),
    override: z.string().min(1).max(256).optional(),
  })
  .refine((rule) => (rule.pipeline === undefined) !== (rule.override === undefined), {
    message: 'give exactly one of pipeline and override',
  })
  .refine((rule) => rule.override === undefined || rule.scope === 'repository', {
    message: 'override is only allowed at repository scope',
  });

const NamingFindingSchema = z.object({
  code: z.string(),
  severity: z.enum(['blocker', 'info']),
  params: z.record(z.string(), z.unknown()),
});
const NamingPreviewSchema = z
  .object({
    summary: z.object({
      affected: z.number().int(),
      changed: z.number().int(),
      invalid: z.number().int(),
      colliding: z.number().int(),
    }),
    collisions: z.array(z.object({ key: z.string(), members: z.array(z.string()) })),
    items: z.array(
      z.object({
        migrationId: z.string(),
        sourcePath: z.string(),
        inScope: z.boolean(),
        currentName: z.string().nullable(),
        plannedName: z.string().nullable(),
        changed: z.boolean(),
        ruleSource: z.string(),
        findings: z.array(NamingFindingSchema),
      }),
    ),
    nextCursor: z.string().nullable(),
  })
  .openapi('NamingPreview');

const namingPreviewRoute = createRoute({
  method: 'post',
  path: '/routes/{id}/naming/preview',
  summary: 'Planned names and collisions for a candidate NamingRule, without saving it (LIF-030)',
  security,
  request: {
    params: IdParam,
    query: PageQuerySchema,
    body: { required: true, content: json(z.object({ rule: NamingRuleBodySchema })) },
  },
  responses: {
    200: { description: 'Names and collisions', content: json(NamingPreviewSchema) },
    ...problems(401, 403, 404, 409, 422, 503),
  },
});

// -- helpers -------------------------------------------------------------------------------------

type Counts = Record<string, number>;
const bump = (counts: Counts, key: string, by: number) => {
  counts[key] = (counts[key] ?? 0) + by;
};
const sumOf = (counts: Counts | undefined) =>
  Object.values(counts ?? {}).reduce((sum, n) => sum + n, 0);
const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

interface Backlog {
  count: number;
  calls: number;
}

/** Retry hint for a queue or database that is down (seconds). */
const RETRY_AFTER = '5';

/**
 * Runs a call to the queue or the database and turns a failure that is not already a problem into
 * a 503 `not_ready` with `Retry-After` (ADR-0330). The fault is reported through `onFault`, which
 * logs safe fields only; the response carries no detail of it.
 */
async function guarded<T>(
  onFault: ((error: unknown) => void) | undefined,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ProblemError) throw error;
    onFault?.(error);
    throw new ProblemError('not_ready', {
      detail: 'the job queue is unavailable',
      headers: { 'retry-after': RETRY_AFTER },
    });
  }
}

/**
 * Queued (not yet active) background analyses per source Endpoint, with the calls they are
 * expected to spend (the Route's `avgCallsPerAnalysis`), as the feeder counts them (ADR-0312).
 * `total` counts the whole queue; the per-Endpoint split reads at most `BACKLOG_READ_LIMIT` jobs,
 * and `truncated` says the split is partial.
 */
async function backgroundBacklog(
  jobs: ApiServices['jobs'],
  db: Db,
): Promise<{ byEndpoint: Map<string, Backlog>; total: number; truncated: boolean }> {
  const queue = jobs.queue('analysis-background');
  const counts = await queue.getJobCounts('waiting', 'delayed', 'prioritized');
  const total = (counts.waiting ?? 0) + (counts.delayed ?? 0) + (counts.prioritized ?? 0);
  const queued = await queue.getJobs(
    ['waiting', 'delayed', 'prioritized'],
    0,
    BACKLOG_READ_LIMIT - 1,
  );
  const ids = new Set<string>();
  for (const job of queued) {
    const id = (job?.data as { migrationId?: unknown } | undefined)?.migrationId;
    if (typeof id === 'string') ids.add(id);
  }
  const out = new Map<string, Backlog>();
  const truncated = total > queued.length;
  if (ids.size === 0) return { byEndpoint: out, total, truncated };
  const rows = await db.migration.findMany({
    where: { id: { in: [...ids] } },
    select: { route: { select: { sourceEndpointId: true, avgCallsPerAnalysis: true } } },
  });
  for (const row of rows) {
    const entry = out.get(row.route.sourceEndpointId) ?? { count: 0, calls: 0 };
    entry.count += 1;
    entry.calls +=
      row.route.avgCallsPerAnalysis > 0 ? row.route.avgCallsPerAnalysis : DEFAULT_AVG_CALLS;
    out.set(row.route.sourceEndpointId, entry);
  }
  return { byEndpoint: out, total, truncated };
}

/** The Batch 1 endpoints. `createV1` mounts them with `.route('/', ...)`. */
export function createBatch1(deps: Batch1Deps) {
  const { privileged } = deps.db;
  const app = new OpenAPIHono<Env>({ defaultHook: deps.validationHook as never });

  return app
    .openapi(refreshRoute, async (c) => {
      requireCapability(c, 'operate');
      const jobs = requireService(deps.services, 'jobs');
      const body = c.req.valid('json') as { endpointId?: string } | undefined;
      const endpointId = body?.endpointId;
      const endpoints = await privileged.endpoint.findMany({
        where: endpointId === undefined ? { status: 'active' } : { id: endpointId },
        orderBy: { id: 'asc' },
        select: { id: true, status: true },
      });
      if (endpointId !== undefined) {
        const found = endpoints[0];
        if (!found) throw new ProblemError('not_found', { detail: 'unknown endpoint' });
        if (found.status !== 'active') {
          throw new ProblemError('conflict', { detail: 'the endpoint is retired' });
        }
      }
      const by = c.get('principal').actor.id;
      for (const endpoint of endpoints) {
        // One pass per Endpoint at a time: the dedupe id collapses repeated requests, and the
        // processor's advisory lock keeps a scheduled pass and a manual one apart (ADR-0280).
        await guarded(deps.onFault, () =>
          jobs.enqueue(
            'inventory',
            'inventory.endpoint',
            { endpointId: endpoint.id },
            { dedupeId: `inventory-${endpoint.id}` },
          ),
        );
        await privileged.auditEvent.create({
          data: {
            actorId: by,
            action: 'inventory.refresh',
            subjectType: 'endpoint',
            subjectId: endpoint.id,
          },
        });
      }
      return c.json({ endpoints: endpoints.map((e) => e.id) }, 202);
    })
    .openapi(analyzeRoute, async (c) => {
      requireCapability(c, 'operate');
      const { id } = c.req.valid('param');
      const jobs = requireService(deps.services, 'jobs');
      const migration = await privileged.migration.findUnique({
        where: { id },
        select: { id: true, status: true },
      });
      if (!migration) throw new ProblemError('not_found');
      // A running Migration may be analyzed: the processor leaves `running` unchanged (LIF-002).
      if (migration.status === 'source_missing') {
        throw new ProblemError('conflict', {
          detail: 'a Migration whose source is missing cannot be analyzed',
        });
      }
      // `analysis-<migrationId>` is the dedupe id the feeder uses too (JOB-011, ADR-0310).
      await guarded(deps.onFault, () => jobs.enqueueAnalysis(id, 'interactive'));
      await privileged.auditEvent.create({
        data: {
          actorId: c.get('principal').actor.id,
          action: 'migration.analyze',
          subjectType: 'migration',
          subjectId: id,
        },
      });
      return c.json({ migrationId: id, queue: 'analysis-interactive' as const }, 202);
    })
    .openapi(dashboardRoute, async (c) => {
      requireCapability(c, 'read');
      const [routes, byStatus, byReadiness, waves, byWave, endpointMigrations, runs] =
        await Promise.all([
          privileged.route.findMany({
            where: { retiredAt: null },
            orderBy: { id: 'asc' },
            select: { id: true, sourceEndpointId: true, targetEndpointId: true },
          }),
          privileged.migration.groupBy({
            by: ['routeId', 'status'],
            where: { scope: 'repository' },
            _count: { _all: true },
          }),
          privileged.migration.groupBy({
            by: ['routeId', 'readiness'],
            where: { scope: 'repository' },
            _count: { _all: true },
          }),
          privileged.wave.findMany({ orderBy: { name: 'asc' }, take: MAX_WAVES + 1 }),
          privileged.migration.groupBy({
            by: ['waveId', 'status'],
            where: { scope: 'repository', waveId: { not: null } },
            _count: { _all: true },
          }),
          privileged.migration.findMany({
            where: { scope: 'endpoint' },
            select: { id: true, routeId: true, status: true, readiness: true },
          }),
          privileged.run.findMany({
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: RECENT_RUNS,
          }),
        ]);
      const statusOf = new Map<string, Counts>();
      for (const row of byStatus) {
        const counts = statusOf.get(row.routeId) ?? {};
        bump(counts, row.status, row._count._all);
        statusOf.set(row.routeId, counts);
      }
      const readinessOf = new Map<string, Counts>();
      for (const row of byReadiness) {
        const counts = readinessOf.get(row.routeId) ?? {};
        bump(counts, row.readiness ?? 'unanalyzed', row._count._all);
        readinessOf.set(row.routeId, counts);
      }
      const waveStatus = new Map<string, Counts>();
      for (const row of byWave) {
        if (row.waveId === null) continue;
        const counts = waveStatus.get(row.waveId) ?? {};
        bump(counts, row.status, row._count._all);
        waveStatus.set(row.waveId, counts);
      }
      return c.json(
        {
          generatedAt: new Date().toISOString(),
          routes: routes.map((r) => {
            const em = endpointMigrations.find((m) => m.routeId === r.id);
            return {
              routeId: r.id,
              sourceEndpointId: r.sourceEndpointId,
              targetEndpointId: r.targetEndpointId,
              total: sumOf(statusOf.get(r.id)),
              byStatus: statusOf.get(r.id) ?? {},
              byReadiness: readinessOf.get(r.id) ?? {},
              endpointMigration: em
                ? { migrationId: em.id, status: em.status, readiness: em.readiness }
                : null,
            };
          }),
          wavesTruncated: waves.length > MAX_WAVES,
          waves: waves.slice(0, MAX_WAVES).map((w) => ({
            id: w.id,
            name: w.name,
            targetDate: iso(w.targetDate),
            total: sumOf(waveStatus.get(w.id)),
            byStatus: waveStatus.get(w.id) ?? {},
          })),
          recentRuns: runs.map((r) => ({
            id: r.id,
            migrationId: r.migrationId,
            kind: r.kind,
            status: r.status,
            createdAt: r.createdAt.toISOString(),
            startedAt: iso(r.startedAt),
            finishedAt: iso(r.finishedAt),
          })),
        },
        200,
      );
    })
    .openapi(quotaRoute, async (c) => {
      requireCapability(c, 'read');
      const quota = requireService(deps.services, 'quota');
      const jobs = requireService(deps.services, 'jobs');
      const [snapshot, queued] = await Promise.all([
        guarded(deps.onFault, () => quota.snapshot()),
        guarded(deps.onFault, () => backgroundBacklog(jobs, privileged)),
      ]);
      const backlog = queued.byEndpoint;
      const buckets = snapshot.map((b) => {
        const parts = parseBucketKey(b.bucketKey);
        const queued = parts ? backlog.get(parts.endpointId) : undefined;
        const count = queued?.count ?? 0;
        return {
          bucketKey: b.bucketKey,
          endpointId: parts?.endpointId ?? null,
          accountKey: parts?.accountKey ?? null,
          resourceGroup: parts?.resourceGroup ?? null,
          limit: b.limit,
          effectiveLimit: b.effectiveLimit,
          windowSeconds: b.windowSeconds,
          used: b.used,
          pools: {
            backgroundLimit: b.backgroundLimit,
            usedBackground: b.usedBackground,
            usedInteractive: b.usedInteractive,
          },
          remaining: b.remaining,
          resetAt: iso(b.resetAt),
          blockedUntil: iso(b.blockedUntil),
          nearLimit: b.nearLimit,
          backgroundRatePerSecond: b.backgroundRatePerSecond,
          backlog: count,
          backgroundEtaSeconds:
            count === 0
              ? 0
              : estimateBackgroundEtaSeconds({
                  backlog: count,
                  avgCallsPerAnalysis: (queued?.calls ?? 0) / count,
                  backgroundRatePerSecond: b.backgroundRatePerSecond,
                }),
        };
      });
      return c.json(
        {
          generatedAt: new Date().toISOString(),
          backlogTotal: queued.total,
          backlogTruncated: queued.truncated,
          buckets,
        },
        200,
      );
    })
    .openapi(matrixRoute, (c) => {
      requireCapability(c, 'read');
      const registry = requireService(deps.services, 'registry');
      return c.json(registry.capabilityMatrix() as z.infer<typeof MatrixSchema>, 200);
    })
    .openapi(diffRoute, async (c) => {
      requireCapability(c, 'read');
      const { id } = c.req.valid('param');
      const { facetKey } = c.req.valid('query');
      const registry = deps.services.registry;
      if (facetKey !== undefined && registry && !registry.facets.has(facetKey as never)) {
        throw new ProblemError('validation_failed', {
          errors: [{ path: 'facetKey', message: 'unknown Facet' }],
        });
      }
      const migration = await privileged.migration.findUnique({
        where: { id },
        select: { id: true, routeId: true, latestAnalysis: true },
      });
      if (!migration) throw new ProblemError('not_found');
      const analysis = migration.latestAnalysis;
      if (!analysis) {
        return c.json({ migrationId: id, analysisId: null, analyzedAt: null, facets: [] }, 200);
      }
      const facetFilter = facetKey === undefined ? {} : { facetKey };
      const [snapshots, parityRows, differences] = await Promise.all([
        privileged.facetSnapshot.findMany({
          where: {
            id: { in: [...analysis.sourceSnapshotIds, ...analysis.targetSnapshotIds] },
            ...facetFilter,
          },
          select: {
            id: true,
            side: true,
            facetKey: true,
            data: true,
            unreadable: true,
            fetchedAt: true,
          },
        }),
        privileged.parityResult.findMany({
          where: { migrationId: id, ...facetFilter },
          // The newest row per Facet only.
          distinct: ['facetKey'],
          orderBy: [{ facetKey: 'asc' }, { checkedAt: 'desc' }, { id: 'desc' }],
        }),
        privileged.expectedDifference.findMany({
          where: {
            routeId: migration.routeId,
            revokedAt: null,
            OR: [{ migrationId: id }, { migrationId: null }],
            ...facetFilter,
          },
          orderBy: { id: 'asc' },
        }),
      ]);
      const translation = (analysis.translation ?? {}) as {
        facets?: Record<string, { desired?: unknown; decisions?: unknown; overridden?: unknown }>;
      };
      const keys = new Set<string>();
      for (const s of snapshots) keys.add(s.facetKey);
      for (const key of Object.keys(translation.facets ?? {})) {
        if (facetKey === undefined || key === facetKey) keys.add(key);
      }
      for (const p of parityRows) keys.add(p.facetKey);
      const order = registry ? registry.facets.ordered().map((d) => d.key as string) : [];
      const rank = (key: string) => {
        const at = order.indexOf(key);
        return at === -1 ? order.length : at;
      };
      const sorted = [...keys].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
      const facets = sorted.map((key) => {
        const snapshotOf = (side: 'source' | 'target', ids: readonly string[]) =>
          snapshots.find((s) => s.facetKey === key && s.side === side && ids.includes(s.id));
        const source = snapshotOf('source', analysis.sourceSnapshotIds);
        const target = snapshotOf('target', analysis.targetSnapshotIds);
        const translated = translation.facets?.[key];
        // The latest ParityResult of the Facet: rows are newest first.
        const parity = parityRows.find((p) => p.facetKey === key);
        const diffs = (Array.isArray(parity?.diffs) ? parity.diffs : []) as {
          path?: unknown;
          source?: unknown;
          target?: unknown;
        }[];
        const excluded = (Array.isArray(parity?.excluded) ? parity.excluded : []) as {
          path?: unknown;
          expectedDifferenceId?: unknown;
        }[];
        return {
          facetKey: key,
          source: source ? redactFacetValue(key, source.data) : null,
          desired:
            translated?.desired === undefined ? null : redactFacetValue(key, translated.desired),
          target: target ? redactFacetValue(key, target.data) : null,
          sourceUnreadable: (source?.unreadable ?? []).map(redactText),
          targetUnreadable: (target?.unreadable ?? []).map(redactText),
          sourceFetchedAt: iso(source?.fetchedAt),
          targetFetchedAt: iso(target?.fetchedAt),
          decisions:
            translated?.decisions === undefined
              ? null
              : redactFacetValue(key, translated.decisions),
          overridden: typeof translated?.overridden === 'boolean' ? translated.overridden : null,
          parity: parity
            ? {
                status: parity.status,
                checkedAt: parity.checkedAt.toISOString(),
                diffs: diffs.map((d) => {
                  const path = String(d.path ?? '');
                  return {
                    path,
                    source: redactAtPath(key, path, d.source),
                    target: redactAtPath(key, path, d.target),
                  };
                }),
                excluded: excluded.map((e) => ({
                  path: String(e.path ?? ''),
                  expectedDifferenceId: String(e.expectedDifferenceId ?? ''),
                })),
              }
            : null,
          expectedDifferences: differences
            .filter((d) => d.facetKey === key)
            .map((d) => ({
              id: d.id,
              path: redactText(d.path),
              reason: d.reason,
              note: d.note === null ? null : redactText(d.note),
              migrationId: d.migrationId,
            })),
        };
      });
      return c.json(
        { migrationId: id, analysisId: analysis.id, analyzedAt: iso(analysis.createdAt), facets },
        200,
      );
    })
    .openapi(namingPreviewRoute, async (c) => {
      requireCapability(c, 'operate');
      const { id } = c.req.valid('param');
      const page = c.req.valid('query') as PageQuery;
      const { rule } = c.req.valid('json');
      const registry = requireService(deps.services, 'registry');
      const route = await privileged.route.findUnique({
        where: { id },
        include: { targetEndpoint: { select: { providerType: true } } },
      });
      if (!route) throw new ProblemError('not_found');
      const limits = registry.repositoryNameLimits(route.targetEndpoint.providerType);
      if (!limits) {
        throw new ProblemError('conflict', {
          detail: 'no repository name limits are registered for the target provider',
        });
      }
      let routeDefault: NamingPipeline;
      try {
        routeDefault = routeNaming(route.defaults);
      } catch {
        throw new ProblemError('conflict', {
          detail: 'the Route default naming pipeline is malformed',
        });
      }
      const scopeFilter = { id: rule.scopeRef, endpointId: route.sourceEndpointId };
      const scopeExists =
        rule.scope === 'namespace'
          ? await privileged.namespace.findFirst({ where: scopeFilter, select: { id: true } })
          : await privileged.repository.findFirst({ where: scopeFilter, select: { id: true } });
      if (!scopeExists) {
        throw new ProblemError('not_found', { detail: 'scopeRef matches nothing on the source' });
      }
      const planned = await privileged.migration.count({
        where: { routeId: id, scope: 'repository', sourceRepository: { presence: 'present' } },
      });
      if (planned > MAX_PREVIEW_MIGRATIONS) {
        throw new ProblemError('validation_failed', {
          errors: [
            {
              path: 'rule',
              message: `the Route has ${planned} repositories; a preview plans at most ${MAX_PREVIEW_MIGRATIONS}`,
            },
          ],
        });
      }
      const [peers, saved] = await Promise.all([
        privileged.migration.findMany({
          where: { routeId: id, scope: 'repository', sourceRepository: { presence: 'present' } },
          orderBy: { id: 'asc' },
          select: {
            id: true,
            plannedTargetName: true,
            targetRepositoryId: true,
            sourceRepository: {
              select: {
                id: true,
                slug: true,
                name: true,
                fullPath: true,
                namespaceId: true,
                namespace: { select: { key: true, slug: true, name: true } },
              },
            },
          },
        }),
        privileged.namingRule.findMany({ where: { routeId: id } }),
      ]);
      // The candidate takes the place of the saved rule of its scope (LIF-030 precedence).
      const pipelineOf = (value: unknown) => (value as NamingPipeline | undefined) ?? null;
      const rulesFor = (repoId: string, namespaceId: string): NamingRules => {
        const repoRule = rule.scope === 'repository' && rule.scopeRef === repoId ? rule : undefined;
        const nsRule =
          rule.scope === 'namespace' && rule.scopeRef === namespaceId ? rule : undefined;
        const savedRepo = saved.find((r) => r.scope === 'repository' && r.scopeRef === repoId);
        const savedNs = saved.find((r) => r.scope === 'namespace' && r.scopeRef === namespaceId);
        return {
          override: repoRule ? (repoRule.override ?? null) : (savedRepo?.override ?? null),
          repositoryPipeline: pipelineOf(repoRule ? repoRule.pipeline : savedRepo?.pipeline),
          namespacePipeline: pipelineOf(nsRule ? nsRule.pipeline : savedNs?.pipeline),
          routeDefault,
        };
      };
      const inputs = peers.flatMap((p) => {
        const r = p.sourceRepository;
        if (!r) return [];
        return [
          {
            id: p.id,
            source: {
              namespace: { key: r.namespace.key, slug: r.namespace.slug, name: r.namespace.name },
              repository: { slug: r.slug, name: r.name },
            },
            rules: rulesFor(r.id, r.namespaceId),
            targetRepositoryId: p.targetRepositoryId,
          },
        ];
      });
      // Targets already claimed by a Migration of the Route; no provider is contacted, so a
      // repository that exists on the target but belongs to none is not seen (ADR-0331).
      const claimedIds = peers.flatMap((p) => (p.targetRepositoryId ? [p.targetRepositoryId] : []));
      const claimed =
        claimedIds.length === 0
          ? []
          : await privileged.repository.findMany({
              where: { id: { in: claimedIds } },
              select: { id: true, name: true },
            });
      const existing: ExistingTarget[] = claimed.map((r) => ({
        id: r.id,
        name: r.name,
        hasRefs: true,
      }));
      let plan: ReturnType<typeof planRouteNaming>;
      try {
        plan = planRouteNaming(inputs, limits, existing);
      } catch {
        throw new ProblemError('validation_failed', {
          errors: [{ path: 'rule', message: 'the rule cannot be evaluated' }],
        });
      }
      const scopeIds = new Set(
        peers
          .filter((p) =>
            rule.scope === 'namespace'
              ? p.sourceRepository?.namespaceId === rule.scopeRef
              : p.sourceRepository?.id === rule.scopeRef,
          )
          .map((p) => p.id),
      );
      const collisions = plan.collisions.filter((g) => g.members.some((m) => scopeIds.has(m.id)));
      const affected = new Set(scopeIds);
      for (const g of collisions) for (const m of g.members) affected.add(m.id);
      const peerOf = new Map(peers.map((p) => [p.id, p]));
      const all = plan.entries
        .filter((e) => affected.has(e.id))
        .sort(byId)
        .map((e) => {
          const peer = peerOf.get(e.id);
          return {
            migrationId: e.id,
            sourcePath: peer?.sourceRepository?.fullPath ?? '',
            inScope: scopeIds.has(e.id),
            currentName: peer?.plannedTargetName ?? null,
            plannedName: e.plannedName,
            changed: e.plannedName !== (peer?.plannedTargetName ?? null),
            ruleSource: e.ruleSource,
            findings: e.findings.map((f) => ({
              code: f.code,
              severity: f.severity,
              params: f.params as Record<string, unknown>,
            })),
          };
        });
      const after = page.cursor;
      const from = after === undefined ? 0 : all.filter((i) => i.migrationId <= after).length;
      const slice = all.slice(from, from + page.limit);
      const last = slice[slice.length - 1];
      return c.json(
        {
          summary: {
            affected: all.length,
            changed: all.filter((i) => i.changed).length,
            invalid: all.filter((i) => i.findings.some((f) => f.code === 'naming.invalid')).length,
            colliding: all.filter((i) => i.findings.some((f) => f.code === 'naming.collision'))
              .length,
          },
          collisions: collisions.map((g) => ({ key: g.key, members: g.members.map((m) => m.id) })),
          items: slice,
          nextCursor: from + page.limit < all.length && last ? last.migrationId : null,
        },
        200,
      );
    });
}
