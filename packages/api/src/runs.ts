/**
 * Run endpoints (T-074, API-020): `POST /migrations/{id}/runs`, `POST /runs/{id}/cancel`,
 * `POST|DELETE /migrations/{id}/complete`. A Run is created only through the guard (`startRun`);
 * cancel is the executor's cooperative `requestRunCancel`; manual completion goes through the
 * lifecycle table (LIF-002, LIF-075). Decisions: docs/adr/0415-run-and-task-endpoints.md.
 */
import {
  type LastRunStatus,
  type LifecycleState,
  type MigrationStatus,
  RUN_KINDS,
  transition,
} from '@git-migrator/core';
import { type Db, publishEventIn } from '@git-migrator/db';
import { parityVerdict, requestRunCancel } from '@git-migrator/jobs';
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
import { startRun } from './run-start.ts';
import { type ApiServices, requireService } from './services.ts';

export interface RunsDeps {
  readonly db: { readonly privileged: Db };
  readonly services: Partial<ApiServices>;
  readonly onFault?: (error: unknown) => void;
  readonly validationHook: ValidationHook;
}

/** Longest completion reason, in characters. */
export const MAX_COMPLETE_REASON = 500;

const Id = z.string().min(1).max(64);
const IdParam = z.object({ id: Id });

const RunBodySchema = z.strictObject({
  kind: z.enum(RUN_KINDS),
  options: z.record(z.string(), z.unknown()).optional(),
  confirm: z.string().min(1).max(512).optional(),
});

const RunCreatedSchema = z
  .object({
    runId: z.string(),
    migrationId: z.string(),
    kind: z.enum(RUN_KINDS),
    status: z.literal('queued'),
  })
  .openapi('RunCreated');

const createRunRoute = createRoute({
  method: 'post',
  path: '/migrations/{id}/runs',
  summary: 'Create a Run (LIF-005, LIF-043); 409 if one is active, 422 if readiness disallows it',
  security,
  request: {
    params: IdParam,
    body: { required: true, content: json(RunBodySchema) },
  },
  responses: {
    202: { description: 'The Run is queued', content: json(RunCreatedSchema) },
    ...problems(401, 403, 404, 409, 422, 503),
  },
});

const CancelSchema = z
  .object({ runId: z.string(), outcome: z.enum(['cancelled', 'requested']) })
  .openapi('RunCancel');

const cancelRoute = createRoute({
  method: 'post',
  path: '/runs/{id}/cancel',
  summary: 'Cooperative cancel (LIF-040); 409 if the Run already finished',
  security,
  request: { params: IdParam },
  responses: {
    200: {
      description: 'Cancelled now, or requested of the executor',
      content: json(CancelSchema),
    },
    ...problems(401, 403, 404, 409),
  },
});

const CompletionSchema = z
  .object({
    migrationId: z.string(),
    status: z.string(),
    manualCompletion: z
      .object({ actorId: z.string(), reason: z.string(), at: z.string() })
      .nullable(),
  })
  .openapi('ManualCompletion');

const completeRoute = createRoute({
  method: 'post',
  path: '/migrations/{id}/complete',
  summary: 'Mark a Migration manually completed (LIF-075)',
  security,
  request: {
    params: IdParam,
    body: {
      required: true,
      content: json(z.strictObject({ reason: z.string().trim().min(1).max(MAX_COMPLETE_REASON) })),
    },
  },
  responses: {
    200: { description: 'Completed', content: json(CompletionSchema) },
    ...problems(401, 403, 404, 409, 422),
  },
});

const revokeRoute = createRoute({
  method: 'delete',
  path: '/migrations/{id}/complete',
  summary: 'Revoke a manual completion; the computed status returns (LIF-075)',
  security,
  request: { params: IdParam },
  responses: {
    200: { description: 'Revoked', content: json(CompletionSchema) },
    ...problems(401, 403, 404, 409),
  },
});

type Tx = Pick<Db, 'migration' | 'run' | 'manualTask' | 'auditEvent' | '$queryRaw' | '$executeRaw'>;

/** Locks the Migration row, the same lock every Run and lifecycle writer takes first. */
const lockMigration = (tx: Pick<Tx, '$queryRaw'>, id: string) =>
  tx.$queryRaw`SELECT id FROM app.migration WHERE id = ${id} FOR NO KEY UPDATE`;

const stateOf = (m: {
  status: string;
  statusBeforeRun: string | null;
  statusBeforeDrift: string | null;
  statusBeforeManual: string | null;
  statusBeforeMissing: string | null;
}): LifecycleState => ({
  status: m.status as MigrationStatus,
  statusBeforeRun: m.statusBeforeRun as MigrationStatus | null,
  statusBeforeDrift: m.statusBeforeDrift as MigrationStatus | null,
  statusBeforeManual: m.statusBeforeManual as MigrationStatus | null,
  statusBeforeMissing: m.statusBeforeMissing as MigrationStatus | null,
});

/**
 * The status the latest finished Run that changed the status left behind (LIF-075, ADR-0058): a
 * migrate, run-anyway or resync Run leaves `migrated`, `partial` or `failed`; a rollback leaves
 * `rolled_back` (or `partial`); a cancelled Run changed the status only if it recorded a Mutation.
 */
async function lastRunStatus(tx: Tx, migrationId: string): Promise<LastRunStatus> {
  const runs = await tx.run.findMany({
    where: {
      migrationId,
      kind: { in: ['migrate', 'run_anyway', 'resync', 'rollback'] },
      status: { in: ['succeeded', 'partial', 'failed', 'cancelled'] },
    },
    orderBy: [{ finishedAt: 'desc' }, { id: 'desc' }],
    take: 20,
    select: { kind: true, status: true, hasMutations: true },
  });
  for (const run of runs) {
    if (run.status === 'cancelled') {
      if (run.hasMutations) return 'partial';
      continue;
    }
    if (run.kind === 'rollback') return run.status === 'succeeded' ? 'rolled_back' : 'partial';
    return run.status === 'succeeded'
      ? 'migrated'
      : run.status === 'partial'
        ? 'partial'
        : 'failed';
  }
  // A Migration that was verified without any Run of its own: `migrated` is the outcome a
  // verification presupposes.
  return 'migrated';
}

const savedStatuses = (state: LifecycleState) => ({
  status: state.status,
  statusBeforeRun: state.statusBeforeRun,
  statusBeforeDrift: state.statusBeforeDrift,
  statusBeforeManual: state.statusBeforeManual,
  statusBeforeMissing: state.statusBeforeMissing,
});

export function createRuns(deps: RunsDeps) {
  const { privileged } = deps.db;
  const app = new OpenAPIHono<Env>({ defaultHook: deps.validationHook as never });

  return app
    .openapi(createRunRoute, async (c) => {
      requireCapability(c, 'operate');
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const jobs = requireService(deps.services, 'jobs');
      const actorId = c.get('principal').actor.id;
      const created = await startRun(
        { db: privileged, jobs, onFault: deps.onFault },
        {
          migrationId: id,
          kind: body.kind,
          actorId,
          options: body.options,
          confirm: body.confirm,
        },
      );
      return c.json(
        { runId: created.runId, migrationId: id, kind: body.kind, status: 'queued' as const },
        202,
      );
    })
    .openapi(cancelRoute, async (c) => {
      requireCapability(c, 'operate');
      const { id } = c.req.valid('param');
      const actorId = c.get('principal').actor.id;
      const outcome = await requestRunCancel(
        privileged,
        id,
        undefined,
        undefined,
        async (tx, result) => {
          // A Run that already finished changed nothing, so it leaves no audit event.
          if (result === 'finished') return;
          await tx.auditEvent.create({
            data: {
              actorId,
              action: 'run.cancel',
              subjectType: 'run',
              subjectId: id,
              data: { outcome: result },
            },
          });
        },
      );
      if (outcome === 'missing') throw new ProblemError('not_found');
      if (outcome === 'finished') {
        throw new ProblemError('conflict', { detail: 'the Run has already finished' });
      }
      return c.json({ runId: id, outcome }, 200);
    })
    .openapi(completeRoute, async (c) => {
      requireCapability(c, 'markComplete');
      const { id } = c.req.valid('param');
      const { reason } = c.req.valid('json');
      const actorId = c.get('principal').actor.id;
      const view = await privileged.$transaction(async (tx) => {
        await lockMigration(tx, id);
        const m = await tx.migration.findUnique({ where: { id } });
        if (!m) throw new ProblemError('not_found');
        const next = transition(stateOf(m), { type: 'mark_complete' });
        if (!next.ok) throw new ProblemError('conflict', { detail: next.error.message });
        const at = new Date();
        const manualCompletion = { actorId, reason, at: at.toISOString() };
        await tx.migration.update({
          where: { id },
          data: { ...savedStatuses(next.state), manualCompletion },
        });
        await tx.auditEvent.create({
          data: {
            actorId,
            action: 'migration.mark_complete',
            subjectType: 'migration',
            subjectId: id,
            data: { reason, from: m.status },
          },
        });
        await publishEventIn(tx, {
          type: 'migration.updated',
          ids: { migration: id },
          at: at.toISOString(),
        });
        return { migrationId: id, status: next.state.status, manualCompletion };
      });
      return c.json(view, 200);
    })
    .openapi(revokeRoute, async (c) => {
      requireCapability(c, 'markComplete');
      const { id } = c.req.valid('param');
      const actorId = c.get('principal').actor.id;
      const view = await privileged.$transaction(async (tx) => {
        await lockMigration(tx, id);
        const m = await tx.migration.findUnique({ where: { id } });
        if (!m) throw new ProblemError('not_found');
        const verdict = await parityVerdict(tx, id);
        const next = transition(stateOf(m), {
          type: 'revoke_complete',
          parityEqualAndNoOpenTasks: verdict.event === 'parity_equal',
          lastRunStatus: await lastRunStatus(tx, id),
        });
        if (!next.ok) throw new ProblemError('conflict', { detail: next.error.message });
        const at = new Date();
        await tx.migration.update({
          where: { id },
          data: {
            ...savedStatuses(next.state),
            ...(next.state.status === 'verified' ? { verifiedAt: at } : {}),
          },
        });
        // A JSON null needs a distinct value in the ORM; the column is simply cleared.
        await tx.$executeRaw`UPDATE app.migration SET manual_completion = NULL WHERE id = ${id}`;
        await tx.auditEvent.create({
          data: {
            actorId,
            action: 'migration.revoke_complete',
            subjectType: 'migration',
            subjectId: id,
            data: { to: next.state.status },
          },
        });
        await publishEventIn(tx, {
          type: 'migration.updated',
          ids: { migration: id },
          at: at.toISOString(),
        });
        return { migrationId: id, status: next.state.status, manualCompletion: null };
      });
      return c.json(view, 200);
    });
}
