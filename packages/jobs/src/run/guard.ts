/**
 * The concurrency guard and the cancel request (DOM-010, LIF-005, LIF-002, LIF-040). `createRun`
 * is what the Run endpoints (T-074) and bulk actions call: it admits a Run only if the Migration
 * has none active, the readiness allows its kind, and the lifecycle accepts `run_started`, all in
 * one transaction under the Migration row lock. Decisions: docs/adr/0343-run-guard-and-findings.md.
 */
import {
  type LifecycleState,
  type MigrationStatus,
  type Readiness,
  type RunKind,
  transition,
} from '@git-migrator/core';
import type { Db } from '@git-migrator/db';
import type { Logger } from '@git-migrator/observability';
import { hasOpenLockIntent } from '../analysis/framework-resources.ts';
import type { RunRouting } from '../queues.ts';
import { hasUndoableMutations } from '../rollback/ledger.ts';
import { parsePendingMarker } from '../run-leases.ts';
import { endRunIn } from './finish.ts';
import { checkRunOptions } from './options.ts';
import { lockMigration, lockRun, publishMigration, publishRun, toJson } from './store.ts';
import type { Tx } from './types.ts';

export type RunGuardCode =
  | 'run.migration_missing'
  | 'run.active' // DOM-010
  | 'run.readiness_required' // LIF-005
  | 'run.not_permitted' // LIF-002/LIF-003: the table does not list run_started here
  | 'run.route_retired'
  | 'run.options_invalid' // LIF-043
  | 'run.confirmation_required'; // LIF-043

/** The HTTP status the API (T-074) answers with. */
const STATUS: Record<RunGuardCode, 404 | 409 | 422> = {
  'run.migration_missing': 404,
  'run.active': 409,
  'run.readiness_required': 422,
  'run.not_permitted': 409,
  'run.route_retired': 409,
  'run.options_invalid': 422,
  'run.confirmation_required': 422,
};

export class RunGuardError extends Error {
  readonly code: RunGuardCode;
  readonly httpStatus: 404 | 409 | 422;
  constructor(code: RunGuardCode, message: string) {
    super(message);
    this.name = 'RunGuardError';
    this.code = code;
    this.httpStatus = STATUS[code];
  }
}

/** Readiness a Run kind needs (LIF-005). `undefined`: not gated. */
export function allowedReadiness(kind: RunKind): readonly (Readiness | null)[] | undefined {
  switch (kind) {
    case 'migrate':
      return ['ready'];
    case 'run_anyway':
      return ['ready', 'needs_attention'];
    case 'resync':
      // "anything except blocked"; a Migration never analyzed is re-analyzed inline (LIF-022).
      return ['ready', 'needs_attention', null];
    default:
      return undefined;
  }
}

/**
 * Blockers the force-adopt option overrides (LIF-031, LIF-043): a non-empty target that was not
 * created by this Migration. The typed confirmation of its name is what makes the Run safe to start.
 */
export const ADOPTABLE_BLOCKERS: readonly string[] = ['target.exists-nonempty'];

/**
 * The readiness LIF-005 judges a Run by. With `adoptNonEmpty`, a Migration whose only blockers are
 * adoptable (`ADOPTABLE_BLOCKERS`) is judged by its open pre tasks alone, so a confirmed force-adopt
 * is not refused by the very blocker it overrides (ADR-0380). Every other blocker still blocks.
 */
export function effectiveReadiness(input: {
  readonly readiness: Readiness | null;
  readonly blockerCodes: readonly string[];
  readonly readinessCounts: unknown;
  readonly options: { readonly adoptNonEmpty?: boolean | undefined };
}): Readiness | null {
  if (input.readiness !== 'blocked' || input.options.adoptNonEmpty !== true) return input.readiness;
  if (
    input.blockerCodes.length === 0 ||
    !input.blockerCodes.every((c) => ADOPTABLE_BLOCKERS.includes(c))
  ) {
    return input.readiness;
  }
  const counts = input.readinessCounts as { preTasks?: unknown } | null;
  return typeof counts?.preTasks === 'number' && counts.preTasks > 0 ? 'needs_attention' : 'ready';
}

/**
 * Why a rollback cannot start (LIF-077), or `undefined`. It is available for every status except
 * `running` and `source_missing` (the lifecycle table refuses those), `discovered` and
 * `rolled_back`, when the Migration has a target or Mutations to undo. The source lock is undone
 * first, by its own Run: a rollback is refused while `sourceReadOnlyApplied` is set or a write of
 * the lock is unsettled (the source may be locked and the ledger does not say how), so it never
 * leaves a source that points at a target that is gone (ADR-0465).
 */
async function rollbackRefusal(
  tx: Pick<Db, '$queryRaw'>,
  migration: {
    readonly id: string;
    readonly status: string;
    readonly targetRepositoryId: string | null;
    readonly sourceReadOnlyApplied: boolean;
    readonly scope: string;
    readonly routeId: string;
  },
): Promise<string | undefined> {
  if (migration.status === 'discovered' || migration.status === 'rolled_back') {
    return `A Migration that is ${migration.status} has nothing to roll back`;
  }
  if (migration.sourceReadOnlyApplied || (await hasOpenLockIntent(tx, migration.id))) {
    return 'The source is read-only, or a write of its lock is unsettled: run undo_source_read_only first, then roll back';
  }
  if (migration.targetRepositoryId === null && !(await hasUndoableMutations(tx, migration.id))) {
    return 'The Migration has no target and no Mutations to undo';
  }
  if (migration.scope === 'endpoint' && (await teamsInUse(tx, migration))) {
    return 'Repository Migrations of this Route still hold access grants for teams this Run created: roll them back first, or remove the grants, so the teams are not deleted from under them';
  }
  return undefined;
}

/**
 * True when a live repository Migration of the Route (not `rolled_back` or `discovered`) still has an
 * active access-control write for a team the endpoint Migration created: rolling the endpoint back
 * would delete the team under that grant (ADR-0465 round 2). Branch-rule push restrictions and CODEOWNERS references are not counted
 * (ADR-0465 round 3).
 */
export async function teamsInUse(
  tx: Pick<Db, '$queryRaw'>,
  migration: { readonly id: string; readonly routeId: string },
  /** Only this team (its provider id), when given. */
  teamId?: string,
): Promise<boolean> {
  const only = teamId ?? null;
  const rows = await tx.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n
    FROM app.mutation g
    JOIN app.migration rm ON rm.id = g.migration_id
    WHERE rm.route_id = ${migration.routeId} AND rm.scope = 'repository'
      AND rm.status NOT IN ('rolled_back', 'discovered')
      AND g.facet_key = 'access-control' AND g.side = 'target'
      AND g.undone_at IS NULL AND g.state <> 'not_applied'
      AND g.resource_ref->>'principal' IN (
        SELECT 'group:' || (t.resource_ref->>'id') FROM app.mutation t
        WHERE t.migration_id = ${migration.id} AND t.facet_key = 'teams'
          AND t.resource_ref->>'kind' = 'team' AND t.undone_at IS NULL
          AND t.state <> 'not_applied' AND t.resource_ref->>'id' IS NOT NULL
          AND (${only}::text IS NULL OR t.resource_ref->>'id' = ${only}::text))`;
  return (rows[0]?.n ?? 0) > 0;
}

export interface CreateRunInput {
  readonly migrationId: string;
  readonly kind: RunKind;
  readonly triggeredById: string;
  /** The request body `options` (LIF-043). */
  readonly options?: Record<string, unknown>;
  /** The request body `confirm`: the exact target full name (LIF-043). */
  readonly confirm?: string;
  readonly now?: () => Date;
  /**
   * Runs inside the creating transaction, after the Run row exists: a caller writes its AuditEvent
   * here so the Run and its audit commit or roll back together (AUTH-022).
   */
  readonly inTransaction?: (tx: Pick<Db, 'auditEvent'>, created: CreatedRun) => Promise<void>;
}

export interface CreatedRun {
  readonly runId: string;
  /** Enqueue `run.execute` with this (after the transaction commits). */
  readonly routing: RunRouting;
}

const isActiveRunIndexViolation = (error: unknown): boolean => {
  const text = `${(error as { message?: string })?.message ?? ''} ${JSON.stringify(
    (error as { cause?: unknown })?.cause ?? '',
  )}`;
  return text.includes('run_one_active_per_migration_key');
};

/**
 * Admits and creates a `queued` Run and moves the Migration to `running` (LIF-002 `run_started`).
 * At most one Run per Migration is queued or running (DOM-010): checked under the Migration row
 * lock, with the partial unique index behind it for writers that bypass this function.
 */
export async function createRun(db: Db, input: CreateRunInput): Promise<CreatedRun> {
  const now = input.now ?? (() => new Date());
  try {
    return await db.$transaction(async (tx) => {
      await lockMigration(tx, input.migrationId);
      const migration = await tx.migration.findUnique({
        where: { id: input.migrationId },
        include: {
          route: true,
          sourceRepository: { select: { sizeClass: true } },
          targetRepository: { select: { fullPath: true } },
        },
      });
      if (!migration) throw new RunGuardError('run.migration_missing', 'No such Migration');
      if (migration.route.retiredAt) {
        throw new RunGuardError('run.route_retired', 'The Route of this Migration is retired');
      }
      const active = await tx.run.count({
        where: { migrationId: input.migrationId, status: { in: ['queued', 'running'] } },
      });
      if (active > 0) {
        throw new RunGuardError('run.active', 'This Migration already has a queued or running Run');
      }
      if (input.kind === 'rollback') {
        const why = await rollbackRefusal(tx, migration);
        if (why !== undefined) throw new RunGuardError('run.not_permitted', why);
      }
      const targetFullName =
        migration.targetRepository?.fullPath ??
        (migration.plannedTargetName
          ? `${migration.route.targetNamespacePath}/${migration.plannedTargetName}`
          : null);
      const checked = checkRunOptions({
        kind: input.kind,
        options: input.options,
        confirm: input.confirm,
        targetFullName,
      });
      if (!checked.ok) throw new RunGuardError(checked.code, checked.message);
      const allowed = allowedReadiness(input.kind);
      const readiness = effectiveReadiness({
        readiness: (migration.readiness ?? null) as Readiness | null,
        blockerCodes: migration.blockerCodes,
        readinessCounts: migration.readinessCounts,
        options: checked.options,
      });
      if (allowed && !allowed.includes(readiness)) {
        throw new RunGuardError(
          'run.readiness_required',
          `A ${input.kind} Run needs readiness ${allowed.map((r) => r ?? 'unset').join(' or ')}, not ${readiness ?? 'unset'}`,
        );
      }
      // LIF-045, ADR-0425: while a write of the source lock is unsettled, the source may hold a lock
      // the ledger does not name, and a Run that writes the target could copy it there. Checked
      // here as well as through the run-origin blocker, which an operator could dismiss.
      if (allowed && (await hasOpenLockIntent(tx, input.migrationId))) {
        throw new RunGuardError(
          'run.readiness_required',
          `A ${input.kind} Run cannot start while a write of the source lock is unsettled: run source_read_only or undo_source_read_only first`,
        );
      }
      const state: LifecycleState = {
        status: migration.status as MigrationStatus,
        statusBeforeRun: migration.statusBeforeRun as MigrationStatus | null,
        statusBeforeDrift: migration.statusBeforeDrift as MigrationStatus | null,
        statusBeforeManual: migration.statusBeforeManual as MigrationStatus | null,
        statusBeforeMissing: migration.statusBeforeMissing as MigrationStatus | null,
      };
      const next = transition(state, { type: 'run_started', kind: input.kind });
      if (!next.ok) throw new RunGuardError('run.not_permitted', next.error.message);
      await tx.migration.update({
        where: { id: input.migrationId },
        data: {
          status: next.state.status,
          statusBeforeRun: next.state.statusBeforeRun,
        },
      });
      const run = await tx.run.create({
        data: {
          migrationId: input.migrationId,
          kind: input.kind,
          triggeredById: input.triggeredById,
          options: toJson(checked.options),
          status: 'queued',
        },
        select: { id: true },
      });
      await publishRun(tx, { run: run.id, migration: input.migrationId }, now);
      await publishMigration(tx, input.migrationId, now);
      const created: CreatedRun = {
        runId: run.id,
        routing: {
          kind: input.kind,
          scope: migration.scope,
          sizeClass: (migration.sourceRepository?.sizeClass ?? 'standard') as 'standard' | 'large',
        },
      };
      await input.inTransaction?.(tx, created);
      return created;
    });
  } catch (error) {
    if (isActiveRunIndexViolation(error)) {
      throw new RunGuardError('run.active', 'This Migration already has a queued or running Run');
    }
    throw error;
  }
}

export type CancelOutcome =
  /** The Run had not started: it is cancelled now. */
  | 'cancelled'
  /** The Run is running: the executor stops at the next checkpoint. */
  | 'requested'
  /** The Run already finished, or does not exist. */
  | 'finished'
  | 'missing';

/**
 * Cooperative cancel (LIF-040). Locks the Migration, then the Run, and decides on the locked state:
 * - `queued`: cancelled at once (nothing ran, so the Migration returns to its saved status). A
 *   worker that is starting the Run holds the Run row, so it either won (the Run is `running` here
 *   and takes the next case) or lost (its start finds a cancelled Run).
 * - `running` with a hand-off marker (a delay or SIGTERM hand-off: the old worker has stopped
 *   writing): finished directly, so the Run does not wait for the delayed job. A reaper `resume`
 *   marker is not that: the old worker may still be alive and about to record a change, so the
 *   cancel is only requested and the resumed executor finishes the Run (ADR-0342).
 * - `running` with an executor: `cancelRequestedAt` is set; the executor checks it between Steps
 *   and while a Step runs, aborts the Step's signal and ends the Run `cancelled`.
 */
export async function requestRunCancel(
  db: Db,
  runId: string,
  now: () => Date = () => new Date(),
  log?: Logger,
  /** Runs inside the cancel's transaction with its outcome (not for a missing Run), for the audit. */
  inTransaction?: (tx: Pick<Db, 'auditEvent'>, outcome: CancelOutcome) => Promise<void>,
): Promise<CancelOutcome> {
  const probe = await db.run.findUnique({ where: { id: runId }, select: { migrationId: true } });
  if (!probe) return 'missing';
  return db.$transaction(async (tx) => {
    await lockMigration(tx, probe.migrationId);
    const run = await lockRun(tx, runId);
    if (!run) return 'missing' as const;
    const outcome = await cancelLocked(tx, run, probe.migrationId);
    await inTransaction?.(tx, outcome);
    return outcome;
  });

  async function cancelLocked(
    tx: Tx,
    run: NonNullable<Awaited<ReturnType<typeof lockRun>>>,
    migrationId: string,
  ): Promise<CancelOutcome> {
    const base = { runId, migrationId: migrationId, now, ...(log ? { log } : {}) };
    if (run.status === 'queued') {
      await tx.$executeRaw`
        UPDATE app.run SET cancel_requested_at = clock_timestamp() WHERE id = ${runId}`;
      await endRunIn(
        tx,
        { ...base, status: 'cancelled' },
        { kind: run.kind as RunKind, hasMutations: false },
      );
      return 'cancelled' as const;
    }
    if (run.status !== 'running') return 'finished' as const;
    if (parsePendingMarker(run.leaseOwner)?.kind === 'handoff') {
      await tx.$executeRaw`
        UPDATE app.run SET cancel_requested_at = clock_timestamp() WHERE id = ${runId}`;
      await endRunIn(
        tx,
        { ...base, status: 'cancelled', error: { code: 'run.cancelled' } },
        { kind: run.kind as RunKind, hasMutations: run.hasMutations },
      );
      return 'cancelled' as const;
    }
    if (run.cancelRequestedAt === null) {
      await tx.$executeRaw`
        UPDATE app.run SET cancel_requested_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE id = ${runId}`;
      await publishRun(tx, { run: runId, migration: migrationId }, now);
    }
    return 'requested' as const;
  }
}
