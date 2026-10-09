/**
 * Starting a Run from the API (LIF-005, LIF-043, DOM-010): the one path a single-item caller uses.
 * It creates the Run only through the guard (`createRun`: concurrency, readiness, options, the
 * lifecycle) and then enqueues it; a Run that cannot be enqueued is cancelled at once, so it never
 * sits `queued` with no job. Decisions: docs/adr/0415-run-and-task-endpoints.md.
 */
import type { RunKind } from '@git-migrator/core';
import type { Db } from '@git-migrator/db';
import {
  type CreatedRun,
  createRun,
  type RunGuardCode,
  RunGuardError,
  requestRunCancel,
} from '@git-migrator/jobs';
import { ProblemError } from './problem.ts';
import type { ApiServices } from './services.ts';

export interface StartRunInput {
  readonly migrationId: string;
  readonly kind: RunKind;
  readonly actorId: string;
  readonly options?: Record<string, unknown> | undefined;
  readonly confirm?: string | undefined;
}

export interface StartRunContext {
  readonly db: Db;
  readonly jobs: Pick<ApiServices['jobs'], 'enqueueRun'>;
  /** Told about a queue or database fault before it becomes a 503 (log safe fields only). */
  readonly onFault?: ((error: unknown) => void) | undefined;
}

/** The problem a guard refusal becomes: 404, 409 or 422 (LIF-005, DOM-010, LIF-043). */
export function problemForGuard(error: RunGuardError): ProblemError {
  const detail = error.message;
  const code: RunGuardCode = error.code;
  switch (code) {
    case 'run.migration_missing':
      return new ProblemError('not_found', { detail });
    case 'run.active':
      return new ProblemError('run_active', { detail });
    case 'run.readiness_required':
      return new ProblemError('readiness_required', { detail });
    case 'run.confirmation_required':
      return new ProblemError('confirmation_required', { detail });
    case 'run.options_invalid':
      return new ProblemError('validation_failed', {
        detail,
        errors: [{ path: 'options', message: detail }],
      });
    case 'run.not_permitted':
      return new ProblemError('run_not_permitted', { detail });
    case 'run.route_retired':
      return new ProblemError('conflict', { detail });
  }
}

/**
 * Creates a `queued` Run and enqueues `run.execute`. The Run and its `run.create` AuditEvent
 * commit together. Throws a `ProblemError`: the guard's 404, 409 or 422, or 503 `not_ready` when
 * the queue is down and the Run could be cancelled (the Migration then returns to its saved
 * status). If the cancel finds the Run already started by a worker, the Run is real and is
 * returned as accepted.
 */
export async function startRun(ctx: StartRunContext, input: StartRunInput): Promise<CreatedRun> {
  let created: CreatedRun;
  try {
    created = await createRun(ctx.db, {
      migrationId: input.migrationId,
      kind: input.kind,
      triggeredById: input.actorId,
      ...(input.options === undefined ? {} : { options: input.options }),
      ...(input.confirm === undefined ? {} : { confirm: input.confirm }),
      inTransaction: async (tx, run) => {
        await tx.auditEvent.create({
          data: {
            actorId: input.actorId,
            action: 'run.create',
            subjectType: 'run',
            subjectId: run.runId,
            // The typed confirmation is never recorded; only the options it unlocked are.
            data: {
              migrationId: input.migrationId,
              kind: input.kind,
              options: JSON.parse(JSON.stringify(input.options ?? {})),
            },
          },
        });
      },
    });
  } catch (error) {
    if (error instanceof RunGuardError) throw problemForGuard(error);
    throw error;
  }
  try {
    await ctx.jobs.enqueueRun(created.runId, created.routing);
  } catch (error) {
    ctx.onFault?.(error);
    const outcome = await requestRunCancel(
      ctx.db,
      created.runId,
      undefined,
      undefined,
      async (tx, result) => {
        await tx.auditEvent.create({
          data: {
            actorId: input.actorId,
            action: 'run.cancel',
            subjectType: 'run',
            subjectId: created.runId,
            data: { outcome: result, reason: 'enqueue_failed' },
          },
        });
      },
    ).catch((e) => {
      ctx.onFault?.(e);
      return 'failed' as const;
    });
    // Only a Run that ended `cancelled` is a failed request. Any other outcome means a worker (or
    // the orphan sweep) owns the Run, so it is accepted.
    if (outcome === 'cancelled' || outcome === 'failed') {
      throw new ProblemError('not_ready', {
        detail: 'the job queue is unavailable',
        headers: { 'retry-after': '5' },
      });
    }
  }
  return created;
}
