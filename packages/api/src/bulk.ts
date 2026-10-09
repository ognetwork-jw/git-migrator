/**
 * `POST /migrations/bulk` (T-088, LIF-090, API-020): Analyze, Migrate ready, Assign to wave and
 * Remove from wave over an explicit selection or a saved filter. The selection is re-validated
 * here, per Migration, against the database (Route, scope, status, readiness, Analysis age): the
 * client's view of readiness is never trusted. Every item the action does not apply to comes back
 * in `skipped` with a reason code. `bulkMigrate` goes through the same `createRun` guard the
 * single-Run endpoint uses. Decisions: ADR-0405, ADR-0406, ADR-0407.
 */
import { type Capability, can } from '@git-migrator/auth';
import type { Db } from '@git-migrator/db';
import { createRun, RunGuardError, requestRunCancel } from '@git-migrator/jobs';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { Principal } from './principal.ts';
import { ProblemError, ProblemSchema } from './problem.ts';
import { type ApiServices, requireService } from './services.ts';

interface Env {
  Variables: { principal: Principal };
}

export interface BulkDeps {
  readonly db: { readonly privileged: Db };
  readonly services: Partial<ApiServices>;
  readonly onFault?: (error: unknown) => void;
  readonly validationHook: (result: { success: boolean; error?: z.ZodError }, c: Context) => void;
}

/** Most Migrations one bulk request acts on (LIF-090: analyze is capped at 200). */
export const BULK_MAX = 200;

/** Upper bound on the `ids` array itself (before de-duplication), so a huge body is a clear 422. */
export const MAX_IDS_BEFORE_DEDUPE = 1000;

export const BULK_ACTIONS = [
  'analyze',
  'migrate-ready',
  'assign-to-wave',
  'remove-from-wave',
] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];

/** Why a selected Migration was not acted on. The web UI has a string for each (`bulk.reason.*`). */
export const BULK_SKIP_REASONS = [
  'not_found',
  'not_repository',
  'source_missing',
  'route_retired',
  'not_ready',
  'not_analyzed',
  'analysis_stale',
  'run_active',
  'not_permitted',
  'already_in_wave',
  'not_in_wave',
  'queue_unavailable',
] as const;
export type BulkSkipReason = (typeof BULK_SKIP_REASONS)[number];

export interface BulkSkip {
  readonly id: string;
  readonly reason: BulkSkipReason;
}
export interface BulkResult {
  readonly accepted: string[];
  readonly skipped: BulkSkip[];
}

const STATUSES = [
  'discovered',
  'analyzed',
  'running',
  'migrated',
  'failed',
  'partial',
  'verified',
  'manually_completed',
  'drifted',
  'rolled_back',
  'source_missing',
] as const;
const DONE_STATUSES = ['verified', 'manually_completed'] as const;

const Id = z.string().min(1).max(64);

/** The saved filter of the repositories list (UI-021); `routeId` scopes it. */
export const BulkFilterSchema = z
  .object({
    routeId: Id,
    namespaceId: Id.optional(),
    status: z.enum(['unmigrated', 'all', ...STATUSES]).optional(),
    readiness: z.enum(['ready', 'needs_attention', 'blocked']).optional(),
    sizeClass: z.enum(['standard', 'large']).optional(),
    waveId: Id.optional(),
    blockerCode: z.string().min(1).max(200).optional(),
    hasOpenTasks: z.boolean().optional(),
    search: z.string().max(200).optional(),
  })
  .strict();
export type BulkFilter = z.infer<typeof BulkFilterSchema>;

const BodySchema = z
  .object({
    ids: z
      .array(Id)
      .min(1)
      .max(MAX_IDS_BEFORE_DEDUPE)
      .optional()
      .openapi({
        description: `1 to ${MAX_IDS_BEFORE_DEDUPE} ids; more than ${BULK_MAX} distinct ids is a 422.`,
      }),
    filter: BulkFilterSchema.optional(),
    action: z.enum(BULK_ACTIONS),
    waveId: Id.optional(),
  })
  .strict();

const ResultSchema = z
  .object({
    accepted: z.array(z.string()),
    skipped: z.array(z.object({ id: z.string(), reason: z.enum(BULK_SKIP_REASONS) })),
  })
  .openapi('BulkResult');

const problemContent = { 'application/problem+json': { schema: ProblemSchema } };
const problems = (...codes: (401 | 403 | 404 | 422 | 503)[]) =>
  Object.fromEntries(
    codes.map((status) => [status, { description: 'Problem', content: problemContent }]),
  );
const security: Record<string, string[]>[] = [{ bearerAuth: [] }, { sessionCookie: [] }];

export const bulkRoute = createRoute({
  method: 'post',
  path: '/migrations/bulk',
  summary: 'Analyze, migrate, or assign to a Wave many Migrations at once (LIF-090)',
  security,
  request: {
    body: { required: true, content: { 'application/json': { schema: BodySchema } } },
  },
  responses: {
    200: {
      description: 'What was accepted and what was skipped, each with a reason',
      content: { 'application/json': { schema: ResultSchema } },
    },
    ...problems(401, 403, 404, 422, 503),
  },
});

/** The capability each action needs (AUTH-020). */
const CAPABILITY: Record<BulkAction, Capability> = {
  analyze: 'operate',
  'migrate-ready': 'operate',
  'assign-to-wave': 'manageWaves',
  'remove-from-wave': 'manageWaves',
};

/** The `where` of a filter (repository scope only). Mirrors the list page's query (UI-021). */
export function filterWhere(filter: BulkFilter): Record<string, unknown> {
  const repository: Record<string, unknown> = {};
  if (filter.namespaceId) repository.namespaceId = filter.namespaceId;
  if (filter.sizeClass) repository.sizeClass = filter.sizeClass;
  const search = filter.search?.trim() ?? '';
  if (search !== '') {
    repository.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { fullPath: { contains: search, mode: 'insensitive' } },
    ];
  }
  const status = filter.status ?? 'unmigrated';
  const blockerCode = filter.blockerCode?.trim();
  return {
    scope: 'repository',
    routeId: filter.routeId,
    ...(status === 'all'
      ? {}
      : status === 'unmigrated'
        ? { status: { notIn: [...DONE_STATUSES] } }
        : { status }),
    ...(filter.readiness ? { readiness: filter.readiness } : {}),
    ...(filter.waveId ? { waveId: filter.waveId } : {}),
    ...(blockerCode ? { blockerCodes: { has: blockerCode } } : {}),
    ...(filter.hasOpenTasks ? { manualTasks: { some: { status: 'open' } } } : {}),
    ...(Object.keys(repository).length > 0 ? { sourceRepository: repository } : {}),
  };
}

interface Row {
  id: string;
  scope: string;
  status: string;
  readiness: string | null;
  waveId: string | null;
  latestAnalysisId: string | null;
  analysisStaleAt: Date | null;
  route: { retiredAt: Date | null };
}

const SELECT = {
  id: true,
  scope: true,
  status: true,
  readiness: true,
  waveId: true,
  latestAnalysisId: true,
  analysisStaleAt: true,
  route: { select: { retiredAt: true } },
} as const;

/** Selection to rows. Unknown ids stay in `missing`; more than `BULK_MAX` is a 422. */
async function resolveSelection(
  db: Db,
  body: z.infer<typeof BodySchema>,
): Promise<{ rows: Row[]; missing: string[] }> {
  if ((body.ids === undefined) === (body.filter === undefined)) {
    throw new ProblemError('validation_failed', {
      errors: [{ path: 'ids', message: 'give exactly one of ids and filter' }],
    });
  }
  if (body.ids !== undefined) {
    const ids = [...new Set(body.ids)];
    if (ids.length > BULK_MAX) {
      throw new ProblemError('validation_failed', {
        errors: [{ path: 'ids', message: `at most ${BULK_MAX} Migrations per request` }],
      });
    }
    const rows = (await db.migration.findMany({
      where: { id: { in: ids } },
      select: SELECT,
    })) as Row[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    return {
      rows: ids.flatMap((id) => byId.get(id) ?? []),
      missing: ids.filter((id) => !byId.has(id)),
    };
  }
  const rows = (await db.migration.findMany({
    where: filterWhere(body.filter as BulkFilter) as never,
    orderBy: { id: 'asc' },
    take: BULK_MAX + 1,
    select: SELECT,
  })) as Row[];
  if (rows.length > BULK_MAX) {
    throw new ProblemError('validation_failed', {
      errors: [
        {
          path: 'filter',
          message: `the filter matches more than ${BULK_MAX} Migrations; narrow it`,
        },
      ],
    });
  }
  return { rows, missing: [] };
}

/** Skip reasons every action shares: only repository Migrations of a live Route take part. */
function commonSkip(row: Row): BulkSkipReason | undefined {
  if (row.scope !== 'repository') return 'not_repository';
  if (row.route.retiredAt !== null) return 'route_retired';
  return undefined;
}

/** `migrate-ready`: the fresh-Analysis and readiness checks (LIF-090), before `createRun` re-checks. */
function migrateSkip(row: Row): BulkSkipReason | undefined {
  const common = commonSkip(row);
  if (common) return common;
  if (row.status === 'source_missing') return 'source_missing';
  if (row.readiness !== 'ready') return 'not_ready';
  if (row.latestAnalysisId === null) return 'not_analyzed';
  if (row.analysisStaleAt !== null) return 'analysis_stale';
  return undefined;
}

const GUARD_REASON: Record<string, BulkSkipReason> = {
  'run.migration_missing': 'not_found',
  'run.active': 'run_active',
  'run.readiness_required': 'not_ready',
  'run.not_permitted': 'not_permitted',
  'run.route_retired': 'route_retired',
};

const audit = (
  db: Db,
  actorId: string,
  action: string,
  subjectType: string,
  subjectId: string,
  data: Record<string, string | boolean | null>,
) => db.auditEvent.create({ data: { actorId, action, subjectType, subjectId, data } });

export interface BulkContext {
  readonly db: Db;
  readonly jobs: ApiServices['jobs'];
  readonly actorId: string;
  readonly onFault?: (error: unknown) => void;
}

/**
 * Creates and enqueues one migrate Run per eligible row; the rest are skipped with a reason.
 * The Run endpoint (T-074) reuses `createRun` the same way.
 */
export async function bulkMigrate(ctx: BulkContext, rows: readonly Row[]): Promise<BulkResult> {
  const out: BulkResult = { accepted: [], skipped: [] };
  // After one enqueue failure the queue is taken to be down: the rest are not tried (no Run is
  // created that no job could start).
  let queueDown = false;
  for (const row of rows) {
    const skip = migrateSkip(row) ?? (queueDown ? 'queue_unavailable' : undefined);
    if (skip) {
      out.skipped.push({ id: row.id, reason: skip });
      continue;
    }
    let created: Awaited<ReturnType<typeof createRun>>;
    try {
      created = await createRun(ctx.db, {
        migrationId: row.id,
        kind: 'migrate',
        triggeredById: ctx.actorId,
      });
    } catch (error) {
      if (error instanceof RunGuardError) {
        out.skipped.push({ id: row.id, reason: GUARD_REASON[error.code] ?? 'not_permitted' });
        continue;
      }
      throw error;
    }
    await audit(ctx.db, ctx.actorId, 'run.create', 'run', created.runId, {
      migrationId: row.id,
      kind: 'migrate',
      bulk: true,
    });
    try {
      await ctx.jobs.enqueueRun(created.runId, created.routing);
    } catch (error) {
      ctx.onFault?.(error);
      queueDown = true;
      // No job will ever start this Run: cancel it so the Migration returns to its saved status.
      await requestRunCancel(ctx.db, created.runId).catch((e) => ctx.onFault?.(e));
      await audit(ctx.db, ctx.actorId, 'run.cancel', 'run', created.runId, {
        migrationId: row.id,
        reason: 'queue_unavailable',
        bulk: true,
      });
      out.skipped.push({ id: row.id, reason: 'queue_unavailable' });
      continue;
    }
    out.accepted.push(row.id);
  }
  return out;
}

async function bulkAnalyze(ctx: BulkContext, rows: readonly Row[]): Promise<BulkResult> {
  const out: BulkResult = { accepted: [], skipped: [] };
  let queueDown = false;
  for (const row of rows) {
    const skip =
      commonSkip(row) ??
      (row.status === 'source_missing' ? 'source_missing' : undefined) ??
      (queueDown ? 'queue_unavailable' : undefined);
    if (skip) {
      out.skipped.push({ id: row.id, reason: skip });
      continue;
    }
    try {
      await ctx.jobs.enqueueAnalysis(row.id, 'interactive');
    } catch (error) {
      ctx.onFault?.(error);
      queueDown = true;
      out.skipped.push({ id: row.id, reason: 'queue_unavailable' });
      continue;
    }
    await audit(ctx.db, ctx.actorId, 'migration.analyze', 'migration', row.id, { bulk: true });
    out.accepted.push(row.id);
  }
  return out;
}

function waveSkip(
  current: string | null,
  waveId: string | null,
  only: string | undefined,
): BulkSkipReason | undefined {
  if (waveId !== null) return current === waveId ? 'already_in_wave' : undefined;
  if (current === null) return 'not_in_wave';
  if (only !== undefined && current !== only) return 'not_in_wave';
  return undefined;
}

/**
 * Wave membership is not an Analysis input, so no Analysis is marked stale (ADR-0407). One
 * transaction: the Wave is locked `FOR SHARE` (a concurrent delete waits, then the assignment is a
 * 404), each Migration is locked and re-read in id order, and the decision, the update and the
 * audit rows all use that locked read.
 */
async function bulkWave(
  ctx: BulkContext,
  rows: readonly Row[],
  waveId: string | null,
  only: string | undefined,
): Promise<BulkResult> {
  return ctx.db.$transaction(async (tx) => {
    if (waveId !== null) {
      const found = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM app.wave WHERE id = ${waveId} FOR SHARE`;
      if (found.length === 0) throw new ProblemError('not_found', { detail: 'unknown Wave' });
    }
    const out: BulkResult = { accepted: [], skipped: [] };
    const previous = new Map<string, string | null>();
    for (const row of [...rows].sort((x, y) => (x.id < y.id ? -1 : 1))) {
      const locked = await tx.$queryRaw<{ wave_id: string | null }[]>`
        SELECT wave_id FROM app.migration WHERE id = ${row.id} FOR NO KEY UPDATE`;
      const current = locked[0];
      const skip =
        commonSkip(row) ??
        (current === undefined ? 'not_found' : waveSkip(current.wave_id, waveId, only));
      if (skip) {
        out.skipped.push({ id: row.id, reason: skip });
        continue;
      }
      previous.set(row.id, current?.wave_id ?? null);
      out.accepted.push(row.id);
    }
    if (out.accepted.length > 0) {
      await tx.migration.updateMany({ where: { id: { in: out.accepted } }, data: { waveId } });
      for (const id of out.accepted) {
        await audit(
          tx as unknown as Db,
          ctx.actorId,
          waveId === null ? 'migration.wave_remove' : 'migration.wave_assign',
          'migration',
          id,
          { bulk: true, waveId, previousWaveId: previous.get(id) ?? null },
        );
      }
    }
    return out;
  });
}

export function createBulk(deps: BulkDeps) {
  const { privileged } = deps.db;
  const app = new OpenAPIHono<Env>({ defaultHook: deps.validationHook as never });
  return app.openapi(bulkRoute, async (c) => {
    const body = c.req.valid('json');
    const principal = c.get('principal');
    const capability = CAPABILITY[body.action];
    if (!can(principal.actor, capability)) {
      throw new ProblemError('forbidden', { detail: `requires the ${capability} capability` });
    }
    if (body.action === 'assign-to-wave') {
      if (body.waveId === undefined) {
        throw new ProblemError('validation_failed', {
          errors: [{ path: 'waveId', message: 'assign-to-wave needs a waveId' }],
        });
      }
      const wave = await privileged.wave.findUnique({
        where: { id: body.waveId },
        select: { id: true },
      });
      if (!wave) throw new ProblemError('not_found', { detail: 'unknown Wave' });
    }
    const jobsNeeded = body.action === 'analyze' || body.action === 'migrate-ready';
    const jobs = jobsNeeded ? requireService(deps.services, 'jobs') : undefined;
    const { rows, missing } = await resolveSelection(privileged, body);
    const ctx: BulkContext = {
      db: privileged,
      jobs: jobs as ApiServices['jobs'],
      actorId: principal.actor.id,
      ...(deps.onFault ? { onFault: deps.onFault } : {}),
    };
    let result: BulkResult;
    switch (body.action) {
      case 'analyze':
        result = await bulkAnalyze(ctx, rows);
        break;
      case 'migrate-ready':
        result = await bulkMigrate(ctx, rows);
        break;
      case 'assign-to-wave':
        result = await bulkWave(ctx, rows, body.waveId as string, undefined);
        break;
      case 'remove-from-wave':
        result = await bulkWave(ctx, rows, null, body.waveId);
        break;
    }
    return c.json(
      {
        accepted: result.accepted,
        skipped: [
          ...missing.map((id) => ({ id, reason: 'not_found' as const })),
          ...result.skipped,
        ],
      },
      200,
    );
  });
}
