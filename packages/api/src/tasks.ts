/**
 * Task and Expected Difference endpoints (T-074, API-020, LIF-006, LIF-020 step 6):
 * `POST /migrations/{id}/tasks/{taskId}/{done|reopen|dismiss}`,
 * `POST /migrations/{id}/expected-differences` and `DELETE /expected-differences/{id}`.
 *
 * Every path that closes a task sets `completedById`, so an Analysis never reopens it. Anything
 * that changes an Analysis input (an Expected Difference created or revoked) marks the Migration's
 * Analysis stale in the same transaction; anything that can change parity enqueues a Parity Check
 * after the commit (`enqueueParity`, never inline). Decisions:
 * docs/adr/0415-run-and-task-endpoints.md.
 */

import { randomUUID } from 'node:crypto';
import { parsePathPattern, patternForPath } from '@git-migrator/core';
import {
  type Db,
  markAnalysesStale,
  publishEventIn,
  supersedeParityChecks as supersedeChecks,
} from '@git-migrator/db';
import { MAX_STORED_DIFFS, recomputeReadiness } from '@git-migrator/jobs';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  type Env,
  json,
  problems,
  requireCapability,
  security,
  type ValidationHook,
} from './kit.ts';
import { ProblemError } from './problem.ts';
import { type ApiServices, requireService } from './services.ts';

export interface TasksDeps {
  readonly db: { readonly privileged: Db };
  readonly services: Partial<ApiServices>;
  readonly onFault?: (error: unknown) => void;
  readonly validationHook: ValidationHook;
}

/** Longest task note or Expected Difference note, in characters. */
export const MAX_NOTE = 1000;

const Id = z.string().min(1).max(64);
const TASK_ACTIONS = ['done', 'reopen', 'dismiss'] as const;
type TaskAction = (typeof TASK_ACTIONS)[number];

const TaskSchema = z
  .object({
    id: z.string(),
    migrationId: z.string(),
    facetKey: z.string(),
    code: z.string(),
    phase: z.string(),
    origin: z.string(),
    status: z.enum(['open', 'done', 'dismissed']),
    completedById: z.string().nullable(),
    completedAt: z.string().nullable(),
    note: z.string().nullable(),
  })
  .openapi('ManualTask');

const taskRoute = createRoute({
  method: 'post',
  path: '/migrations/{id}/tasks/{taskId}/{action}',
  summary: 'Mark a task done, reopen it or dismiss it (LIF-006); triggers a Parity Check',
  security,
  request: {
    params: z.object({ id: Id, taskId: Id, action: z.enum(TASK_ACTIONS) }),
    body: {
      required: false,
      content: json(z.strictObject({ note: z.string().trim().max(MAX_NOTE).optional() })),
    },
  },
  responses: {
    200: { description: 'The task', content: json(TaskSchema) },
    ...problems(401, 403, 404, 409, 422, 503),
  },
});

const ExpectedDifferenceSchema = z
  .object({
    id: z.string(),
    routeId: z.string(),
    migrationId: z.string().nullable(),
    facetKey: z.string(),
    path: z.string(),
    reason: z.string(),
    note: z.string().nullable(),
    createdById: z.string().nullable(),
    revokedAt: z.string().nullable(),
  })
  .openapi('ExpectedDifference');

const createEdRoute = createRoute({
  method: 'post',
  path: '/migrations/{id}/expected-differences',
  summary: 'Accept a difference for one Migration (manual_accepted)',
  security,
  request: {
    params: z.object({ id: Id }),
    body: {
      required: true,
      content: json(
        z.strictObject({
          facetKey: z.string().min(1).max(64),
          path: z.string().min(1).max(512),
          note: z.string().trim().min(1).max(MAX_NOTE),
        }),
      ),
    },
  },
  responses: {
    201: { description: 'Created', content: json(ExpectedDifferenceSchema) },
    ...problems(401, 403, 404, 409, 422, 503),
  },
});

const DriftAcceptedSchema = z
  .object({
    migrationId: z.string(),
    /** Expected Differences created, one per differing path of every Facet. */
    accepted: z.number().int(),
    /** Paths an active acceptance already covered. */
    alreadyAccepted: z.number().int(),
    /** Paths that could not be turned into a pattern (none are accepted for them). */
    skipped: z.array(z.object({ facetKey: z.string(), path: z.string() })),
    /** A Facet stored as many differences as a result keeps: a re-check may show more. */
    truncated: z.boolean(),
  })
  .openapi('DriftAccepted');

const acceptDriftRoute = createRoute({
  method: 'post',
  path: '/migrations/{id}/drift/accept',
  summary:
    'Accept all current drift differences as manual_accepted Expected Differences, then re-run parity (LIF-065)',
  security,
  request: {
    params: z.object({ id: Id }),
    body: {
      required: true,
      content: json(z.strictObject({ note: z.string().trim().min(1).max(MAX_NOTE) })),
    },
  },
  responses: {
    200: { description: 'Accepted', content: json(DriftAcceptedSchema) },
    ...problems(401, 403, 404, 409, 503),
  },
});

const revokeEdRoute = createRoute({
  method: 'delete',
  path: '/expected-differences/{id}',
  summary: 'Revoke an Expected Difference (sets revokedAt)',
  security,
  request: { params: z.object({ id: Id }) },
  responses: {
    200: { description: 'Revoked', content: json(ExpectedDifferenceSchema) },
    ...problems(401, 403, 404, 409, 503),
  },
});

type Tx = Pick<
  Db,
  | 'migration'
  | 'manualTask'
  | 'expectedDifference'
  | 'auditEvent'
  | 'parityResult'
  | '$queryRaw'
  | '$executeRaw'
>;

const lockMigration = (tx: Pick<Tx, '$queryRaw'>, id: string) =>
  tx.$queryRaw`SELECT id FROM app.migration WHERE id = ${id} FOR NO KEY UPDATE`;

const iso = (date: Date | null | undefined): string | null => (date ? date.toISOString() : null);

interface EdRow {
  id: string;
  routeId: string;
  migrationId: string | null;
  facetKey: string;
  path: string;
  reason: string;
  note: string | null;
  createdById: string | null;
  revokedAt: Date | null;
}
const edView = (row: EdRow): z.infer<typeof ExpectedDifferenceSchema> => ({
  id: row.id,
  routeId: row.routeId,
  migrationId: row.migrationId,
  facetKey: row.facetKey,
  path: row.path,
  reason: row.reason,
  note: row.note,
  createdById: row.createdById,
  revokedAt: iso(row.revokedAt),
});

interface TaskRow {
  id: string;
  migrationId: string;
  facetKey: string;
  code: string;
  phase: string;
  origin: string;
  status: 'open' | 'done' | 'dismissed';
  completedById: string | null;
  completedAt: Date | null;
  note: string | null;
  params: unknown;
}
const taskView = (row: TaskRow): z.infer<typeof TaskSchema> => ({
  id: row.id,
  migrationId: row.migrationId,
  facetKey: row.facetKey,
  code: row.code,
  phase: row.phase,
  origin: row.origin,
  status: row.status,
  completedById: row.completedById,
  completedAt: iso(row.completedAt),
  note: row.note,
});

/** What an `accept` task records: its policy key and the paths it covers (`<facet>.accept-lossy`). */
function acceptTarget(params: unknown): { policyKey: string; paths: string[] } | undefined {
  if (typeof params !== 'object' || params === null) return undefined;
  const { policyKey, paths } = params as { policyKey?: unknown; paths?: unknown };
  if (typeof policyKey !== 'string' || !Array.isArray(paths)) return undefined;
  if (!paths.every((p): p is string => typeof p === 'string')) return undefined;
  return { policyKey, paths };
}

/** The policy key and paths of the done `accept` tasks of a Migration's Facet (other than `except`). */
async function doneAcceptTargets(
  tx: Pick<Tx, 'manualTask'>,
  migrationId: string,
  facetKey: string,
  except?: string,
): Promise<{ policyKey: string; paths: string[] }[]> {
  const done = await tx.manualTask.findMany({
    where: {
      migrationId,
      facetKey,
      code: `${facetKey}.accept-lossy`,
      status: 'done',
      ...(except === undefined ? {} : { id: { not: except } }),
    },
    select: { params: true },
  });
  return done.flatMap((t) => acceptTarget(t.params) ?? []);
}

const conflict = (detail: string) => new ProblemError('conflict', { detail });
const invalid = (path: string, message: string) =>
  new ProblemError('validation_failed', { detail: message, errors: [{ path, message }] });

export function createTasks(deps: TasksDeps) {
  const { privileged } = deps.db;
  const app = new OpenAPIHono<Env>({ defaultHook: deps.validationHook as never });

  /**
   * A Parity Check after the commit (LIF-062): a failed enqueue never undoes a change that is
   * already stored, and the scheduled drift check covers the gap.
   */
  const triggerParity = async (migrationId: string): Promise<void> => {
    try {
      await deps.services.jobs?.enqueueParity(migrationId);
    } catch (error) {
      deps.onFault?.(error);
    }
  };

  /** A Route-wide record touches every analyzed Migration of the Route; a failed lookup is a fault, not an error. */
  const triggerRouteParity = async (routeId: string): Promise<void> => {
    try {
      const rows = await privileged.migration.findMany({
        where: { routeId, scope: 'repository', latestAnalysisId: { not: null } },
        select: { id: true },
        take: PARITY_FANOUT_LIMIT,
      });
      await Promise.all(rows.map((m) => triggerParity(m.id)));
    } catch (error) {
      deps.onFault?.(error);
    }
  };

  /** The completion mode of a task's finding code (LIF-006); unknown codes are `manual`. */
  const completionOf = (facetKey: string, code: string) => {
    const registry = requireService(deps.services, 'registry');
    if (!registry.facets.has(facetKey as never)) return 'manual' as const;
    return registry.facets.get(facetKey as never).findingCodes[code]?.completion ?? 'manual';
  };

  /** The state a task may leave (conflict otherwise), per action. */
  const FROM: Record<TaskAction, readonly TaskRow['status'][]> = {
    done: ['open', 'dismissed'],
    dismiss: ['open'],
    reopen: ['done', 'dismissed'],
  };
  const TO: Record<TaskAction, TaskRow['status']> = {
    done: 'done',
    dismiss: 'dismissed',
    reopen: 'open',
  };

  return app
    .openapi(taskRoute, async (c) => {
      requireCapability(c, 'manageTasks');
      const { id, taskId, action } = c.req.valid('param');
      const note = c.req.valid('json')?.note;
      const actorId = c.get('principal').actor.id;

      const result = await privileged.$transaction(async (tx) => {
        await lockMigration(tx, id);
        const task = (await tx.manualTask.findFirst({
          where: { id: taskId, migrationId: id },
        })) as TaskRow | null;
        if (!task) throw new ProblemError('not_found');
        if (!FROM[action].includes(task.status)) {
          throw conflict(
            `a ${task.status} task cannot be ${action === 'done' ? 'marked done' : `${action}ed`}`,
          );
        }
        const completion = completionOf(task.facetKey, task.code);
        if (action === 'done' && completion === 'resolution') {
          throw invalid(
            'action',
            'this task is resolved by changing the underlying data; it cannot be marked done',
          );
        }
        if (action === 'dismiss' && completion === 'resolution' && !(note ?? '').trim()) {
          throw invalid('note', 'dismissing this task needs a reason');
        }
        const now = new Date();
        const closing = action !== 'reopen';
        const row = (await tx.manualTask.update({
          where: { id: taskId },
          data: {
            status: TO[action],
            // LIF-020 step 6: every path that closes a task names the Actor, or the next Analysis
            // would reopen a dismissal.
            completedById: closing ? actorId : null,
            completedAt: closing ? now : null,
            ...(note === undefined ? {} : { note }),
          },
        })) as TaskRow;

        let acceptanceChanged = false;
        if (completion === 'accept') {
          const target = acceptTarget(task.params);
          if (action === 'done') {
            if (!target) throw invalid('task', 'the task records no policy key or paths');
            const migration = await tx.migration.findUniqueOrThrow({
              where: { id },
              select: { routeId: true },
            });
            let inserted = 0;
            for (const path of target.paths) {
              inserted += await tx.$executeRaw`
                INSERT INTO app.expected_difference
                  (id, route_id, migration_id, facet_key, path, reason, note, created_by_id, updated_at)
                VALUES
                  (${randomUUID()}, ${migration.routeId}, ${id}, ${task.facetKey}, ${path},
                   'lossy_accepted'::app.expected_difference_reason, ${target.policyKey}, ${actorId}, ${now})
                ON CONFLICT DO NOTHING`;
            }
            // Only rows that were really inserted change an Analysis input.
            acceptanceChanged = inserted > 0;
          } else if (action === 'reopen' && target) {
            // A path another done accept task of the same policy key still covers stays accepted:
            // that task, not this one, owns the row.
            const kept = new Set(
              (await doneAcceptTargets(tx, id, task.facetKey, taskId))
                .filter((other) => other.policyKey === target.policyKey)
                .flatMap((other) => other.paths),
            );
            const revoked = await tx.expectedDifference.updateMany({
              where: {
                migrationId: id,
                facetKey: task.facetKey,
                reason: 'lossy_accepted',
                note: target.policyKey,
                path: { in: target.paths.filter((p) => !kept.has(p)) },
                revokedAt: null,
              },
              data: { revokedAt: now },
            });
            acceptanceChanged = revoked.count > 0;
          }
        }
        // Expected Differences are Analysis inputs (LIF-021).
        if (acceptanceChanged) {
          await markAnalysesStale(tx, { ids: [id] });
          await supersedeChecks(tx, { id });
        }

        await recomputeReadiness(tx, id);
        await tx.auditEvent.create({
          data: {
            actorId,
            action: `task.${action}`,
            subjectType: 'manual_task',
            subjectId: taskId,
            data: {
              migrationId: id,
              facetKey: task.facetKey,
              code: task.code,
              from: task.status,
              to: TO[action],
              note: note ?? null,
            },
          },
        });
        const at = now.toISOString();
        await publishEventIn(tx, {
          type: 'task.updated',
          ids: { migration: id, task: taskId },
          at,
        });
        await publishEventIn(tx, { type: 'migration.updated', ids: { migration: id }, at });
        return row;
      });
      await triggerParity(id);
      return c.json(taskView(result), 200);
    })
    .openapi(createEdRoute, async (c) => {
      requireCapability(c, 'manageTasks');
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const actorId = c.get('principal').actor.id;
      const registry = requireService(deps.services, 'registry');
      if (!registry.facets.has(body.facetKey as never)) {
        throw invalid('facetKey', `unknown Facet ${body.facetKey}`);
      }
      try {
        parsePathPattern(body.path);
      } catch (error) {
        throw invalid('path', (error as Error).message);
      }
      const created = await privileged.$transaction(async (tx) => {
        await lockMigration(tx, id);
        const migration = await tx.migration.findUnique({
          where: { id },
          select: { routeId: true },
        });
        if (!migration) throw new ProblemError('not_found');
        const existing = await tx.expectedDifference.findFirst({
          where: {
            routeId: migration.routeId,
            migrationId: id,
            facetKey: body.facetKey,
            path: body.path,
            reason: 'manual_accepted',
            revokedAt: null,
          },
          select: { id: true },
        });
        if (existing) throw conflict('this difference is already accepted for the Migration');
        const row = (await tx.expectedDifference.create({
          data: {
            routeId: migration.routeId,
            migrationId: id,
            facetKey: body.facetKey,
            path: body.path,
            reason: 'manual_accepted',
            note: body.note,
            createdById: actorId,
          },
        })) as EdRow;
        await markAnalysesStale(tx, { ids: [id] });
        await supersedeChecks(tx, { id });
        await tx.auditEvent.create({
          data: {
            actorId,
            action: 'expected_difference.create',
            subjectType: 'expected_difference',
            subjectId: row.id,
            data: { migrationId: id, facetKey: body.facetKey, path: body.path, note: body.note },
          },
        });
        await publishEventIn(tx, {
          type: 'migration.updated',
          ids: { migration: id },
          at: new Date().toISOString(),
        });
        return row;
      });
      await triggerParity(id);
      return c.json(edView(created), 201);
    })
    .openapi(acceptDriftRoute, async (c) => {
      requireCapability(c, 'manageTasks');
      const { id } = c.req.valid('param');
      const { note } = c.req.valid('json');
      const actorId = c.get('principal').actor.id;
      const result = await privileged.$transaction(async (tx) => {
        await lockMigration(tx, id);
        const migration = await tx.migration.findUnique({
          where: { id },
          select: { routeId: true, status: true },
        });
        if (!migration) throw new ProblemError('not_found');
        // Drift is a status of its own (LIF-065); accepting is its resolution.
        if (migration.status !== 'drifted') {
          throw conflict(`the Migration is ${migration.status}, not drifted`);
        }
        const results = (await tx.parityResult.findMany({
          where: { migrationId: id, status: 'different' },
          select: { facetKey: true, diffs: true },
          orderBy: { facetKey: 'asc' },
        })) as { facetKey: string; diffs: unknown }[];
        const accepted: EdRow[] = [];
        const skipped: { facetKey: string; path: string }[] = [];
        let alreadyAccepted = 0;
        let truncated = false;
        for (const result of results) {
          const diffs = Array.isArray(result.diffs) ? (result.diffs as { path?: unknown }[]) : [];
          if (diffs.length >= MAX_STORED_DIFFS) truncated = true;
          for (const diff of diffs) {
            if (typeof diff.path !== 'string') continue;
            // The stored path is a concrete field path: it becomes a pattern only through
            // `patternForPath`, which escapes it so it masks that path and nothing else.
            let pattern: string;
            try {
              pattern = patternForPath(diff.path);
              parsePathPattern(pattern);
            } catch {
              skipped.push({ facetKey: result.facetKey, path: diff.path });
              continue;
            }
            const existing = await tx.expectedDifference.findFirst({
              where: {
                routeId: migration.routeId,
                migrationId: id,
                facetKey: result.facetKey,
                path: pattern,
                reason: 'manual_accepted',
                revokedAt: null,
              },
              select: { id: true },
            });
            if (existing) {
              alreadyAccepted += 1;
              continue;
            }
            const row = (await tx.expectedDifference.create({
              data: {
                routeId: migration.routeId,
                migrationId: id,
                facetKey: result.facetKey,
                path: pattern,
                reason: 'manual_accepted',
                note,
                createdById: actorId,
              },
            })) as EdRow;
            accepted.push(row);
            await tx.auditEvent.create({
              data: {
                actorId,
                action: 'expected_difference.create',
                subjectType: 'expected_difference',
                subjectId: row.id,
                data: { migrationId: id, facetKey: result.facetKey, path: pattern, note },
              },
            });
          }
        }
        // Expected Differences are Analysis inputs (LIF-021).
        await markAnalysesStale(tx, { ids: [id] });
        await supersedeChecks(tx, { id });
        await tx.auditEvent.create({
          data: {
            actorId,
            action: 'migration.drift_accept',
            subjectType: 'migration',
            subjectId: id,
            data: {
              accepted: accepted.length,
              alreadyAccepted,
              skipped: skipped.length,
              facets: results.map((r) => r.facetKey),
              note,
            },
          },
        });
        await publishEventIn(tx, {
          type: 'migration.updated',
          ids: { migration: id },
          at: new Date().toISOString(),
        });
        return { accepted: accepted.length, alreadyAccepted, skipped, truncated };
      });
      // `parity_equal` returns the Migration to its status before the drift (LIF-065), after the
      // commit and never inline (LIF-062).
      await triggerParity(id);
      return c.json({ migrationId: id, ...result }, 200);
    })
    .openapi(revokeEdRoute, async (c) => {
      requireCapability(c, 'manageTasks');
      const { id } = c.req.valid('param');
      const actorId = c.get('principal').actor.id;
      const probe = await privileged.expectedDifference.findUnique({
        where: { id },
        select: { migrationId: true },
      });
      if (!probe) throw new ProblemError('not_found');
      const revoked = await privileged.$transaction(async (tx) => {
        // Lock order: the Migration row first (a Route-wide record has none to lock).
        if (probe.migrationId) await lockMigration(tx, probe.migrationId);
        const row = (await tx.expectedDifference.findUnique({ where: { id } })) as EdRow | null;
        if (!row) throw new ProblemError('not_found');
        // An exclusion belongs to its Identity Mapping (AUTH-050) and is lifted there.
        if (row.reason === 'identity_excluded' || row.reason === 'framework_mutation') {
          throw conflict(`a ${row.reason} difference is not revoked here`);
        }
        if (row.revokedAt) throw conflict('this difference is already revoked');
        // An acceptance a done `accept` task made is taken back by reopening that task.
        if (row.reason === 'lossy_accepted' && row.migrationId && row.note) {
          const owners = await doneAcceptTargets(tx, row.migrationId, row.facetKey);
          if (owners.some((o) => o.policyKey === row.note && o.paths.includes(row.path))) {
            throw conflict('this acceptance belongs to a done task; reopen the task instead');
          }
        }
        const now = new Date();
        const updated = (await tx.expectedDifference.update({
          where: { id },
          data: { revokedAt: now },
        })) as EdRow;
        // A Route-wide record is an input of every Analysis on the Route (LIF-021).
        await markAnalysesStale(
          tx,
          row.migrationId ? { ids: [row.migrationId] } : { routeId: row.routeId },
        );
        await supersedeChecks(
          tx,
          row.migrationId ? { id: row.migrationId } : { routeId: row.routeId },
        );
        await tx.auditEvent.create({
          data: {
            actorId,
            action: 'expected_difference.revoke',
            subjectType: 'expected_difference',
            subjectId: id,
            data: { migrationId: row.migrationId, facetKey: row.facetKey, path: row.path },
          },
        });
        await publishEventIn(tx, {
          type: 'migration.updated',
          ids: row.migrationId ? { migration: row.migrationId } : {},
          at: now.toISOString(),
        });
        return updated;
      });
      if (revoked.migrationId) await triggerParity(revoked.migrationId);
      else await triggerRouteParity(revoked.routeId);
      return c.json(edView(revoked), 200);
    });
}

/** Most Migrations a Route-wide revoke enqueues a Parity Check for at once (the rest wait for drift checks). */
const PARITY_FANOUT_LIMIT = 500;
