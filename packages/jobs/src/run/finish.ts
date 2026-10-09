/**
 * Ending a Run (LIF-002, LIF-040): the Run row, the pending Steps and the Migration's lifecycle
 * transition change in one transaction, under the lease fence. Decisions:
 * docs/adr/0340-run-executor-framework.md.
 */
import {
  type LifecycleEffect,
  type LifecycleEvent,
  type LifecycleState,
  type MigrationStatus,
  type RunKind,
  transition,
} from '@git-migrator/core';
import type { Db } from '@git-migrator/db';
import type { Logger } from '@git-migrator/observability';
import { fenced, lockMigration, publishMigration, publishRun } from './store.ts';
import type { Tx } from './types.ts';

export type FinalRunStatus = 'succeeded' | 'partial' | 'failed' | 'cancelled';

/**
 * Applies `run_finished` to the Migration: the transition, the saved statuses and the effects of
 * the table (LIF-002). The caller holds the Migration row lock. A rejected transition (the table
 * lists every accepted pair, LIF-003) changes nothing and is returned for logging.
 */
export async function applyRunFinished(
  tx: Tx,
  input: {
    migrationId: string;
    kind: RunKind;
    outcome: FinalRunStatus;
    hasMutations: boolean;
  },
): Promise<{ applied: true } | { applied: false; reason: string }> {
  const cur = await tx.migration.findUniqueOrThrow({ where: { id: input.migrationId } });
  const state: LifecycleState = {
    status: cur.status as MigrationStatus,
    statusBeforeRun: cur.statusBeforeRun as MigrationStatus | null,
    statusBeforeDrift: cur.statusBeforeDrift as MigrationStatus | null,
    statusBeforeManual: cur.statusBeforeManual as MigrationStatus | null,
    statusBeforeMissing: cur.statusBeforeMissing as MigrationStatus | null,
  };
  const event: LifecycleEvent =
    input.outcome === 'cancelled'
      ? {
          type: 'run_finished',
          kind: input.kind,
          outcome: 'cancelled',
          recordedMutation: input.hasMutations,
        }
      : { type: 'run_finished', kind: input.kind, outcome: input.outcome };
  const next = transition(state, event);
  if (!next.ok) return { applied: false, reason: next.error.message };
  const effects: readonly LifecycleEffect[] = next.effects;
  let sourceReadOnlyApplied: boolean | undefined;
  let resetFlags = false;
  for (const effect of effects) {
    if (effect.type === 'set_source_read_only_applied') sourceReadOnlyApplied = effect.value;
    if (effect.type === 'reset_flags') resetFlags = true;
  }
  await tx.migration.update({
    where: { id: input.migrationId },
    data: {
      status: next.state.status,
      statusBeforeRun: next.state.statusBeforeRun,
      statusBeforeDrift: next.state.statusBeforeDrift,
      statusBeforeManual: next.state.statusBeforeManual,
      statusBeforeMissing: next.state.statusBeforeMissing,
      ...(sourceReadOnlyApplied !== undefined ? { sourceReadOnlyApplied } : {}),
      ...(resetFlags ? { targetCreatedByFramework: false, sourceReadOnlyApplied: false } : {}),
    },
  });
  return { applied: true };
}

export interface FinishInput {
  readonly runId: string;
  readonly token: string;
  readonly migrationId: string;
  readonly status: FinalRunStatus;
  /** Stored in `Run.error`, for example `{ code: 'readiness_changed' }`. */
  readonly error?: Record<string, unknown> | undefined;
  readonly now: () => Date;
  readonly log?: Logger;
}

/**
 * The writes that end a Run, in a transaction that already holds the Migration and Run row locks:
 * pending Steps to `skipped`, the Run's final status and cleared lease, the `run_finished`
 * transition and the events. Used by the executor (fenced) and by the cancel of a Run with no
 * executor.
 */
export async function endRunIn(
  tx: Tx,
  input: Omit<FinishInput, 'token'>,
  run: { kind: RunKind; hasMutations: boolean },
): Promise<void> {
  await tx.$executeRaw`
    UPDATE app.run_step SET status = 'skipped', updated_at = clock_timestamp()
    WHERE run_id = ${input.runId} AND status IN ('pending', 'running')`;
  await tx.$executeRaw`
    UPDATE app.run
    SET status = ${input.status}::app.run_status, finished_at = clock_timestamp(),
        lease_owner = NULL, lease_expires_at = NULL, updated_at = clock_timestamp(),
        error = ${input.error ? JSON.stringify(input.error) : null}::jsonb
    WHERE id = ${input.runId}`;
  const applied = await applyRunFinished(tx, {
    migrationId: input.migrationId,
    kind: run.kind,
    outcome: input.status,
    hasMutations: run.hasMutations,
  });
  if (!applied.applied) {
    input.log?.error(
      { runId: input.runId, migrationId: input.migrationId, reason: applied.reason },
      'run_finished was rejected by the lifecycle table; the Migration is unchanged',
    );
  }
  await publishRun(tx, { run: input.runId, migration: input.migrationId }, input.now);
  await publishMigration(tx, input.migrationId, input.now);
}

/**
 * Finishes the Run under its lease: one transaction, so a crash leaves either a running Run or a
 * finished one with a settled Migration, never a Migration still `running` behind a finished Run.
 */
export async function finishRun(db: Db, input: FinishInput): Promise<void> {
  await fenced(
    db,
    { runId: input.runId, token: input.token, migrationId: input.migrationId },
    async (tx) => {
      const run = await tx.run.findUniqueOrThrow({
        where: { id: input.runId },
        select: { kind: true, hasMutations: true },
      });
      await endRunIn(tx, input, run);
    },
  );
}

/**
 * A Migration still `running` with no queued or running Run is the leftover of a Run that ended
 * without its executor (the reaper abandoned it, LIF-046: "the Run executor owns that
 * transition"). Applies `run_finished` for the Migration's latest Run. Idempotent and safe to run
 * from any worker: the Migration row lock serializes it against a Run being created or finished.
 * Returns the Migration ids settled.
 */
export async function settleOrphanedMigrations(
  db: Db,
  now: () => Date,
  log: Logger,
): Promise<string[]> {
  const candidates = await db.$queryRaw<{ id: string }[]>`
    SELECT m.id FROM app.migration m
    WHERE m.status = 'running'
      AND NOT EXISTS (
        SELECT 1 FROM app.run r
        WHERE r.migration_id = m.id AND r.status IN ('queued', 'running'))
    ORDER BY m.id`;
  const settled: string[] = [];
  for (const { id } of candidates) {
    const done = await db.$transaction(async (tx) => {
      await lockMigration(tx, id);
      const migration = await tx.migration.findUnique({ where: { id }, select: { status: true } });
      if (migration?.status !== 'running') return false;
      const active = await tx.run.count({
        where: { migrationId: id, status: { in: ['queued', 'running'] } },
      });
      if (active > 0) return false;
      const last = await tx.run.findFirst({
        where: { migrationId: id },
        orderBy: { createdAt: 'desc' },
        select: { kind: true, status: true, hasMutations: true },
      });
      if (!last || last.status === 'queued' || last.status === 'running') return false;
      // The abandoned Run's unfinished Steps will never run (the reaper does not touch them).
      await tx.$executeRaw`
        UPDATE app.run_step SET status = 'skipped', updated_at = clock_timestamp()
        WHERE status IN ('pending', 'running')
          AND run_id IN (SELECT id FROM app.run WHERE migration_id = ${id} AND status NOT IN ('queued', 'running'))`;
      const applied = await applyRunFinished(tx, {
        migrationId: id,
        kind: last.kind,
        outcome: last.status,
        hasMutations: last.hasMutations,
      });
      if (!applied.applied) {
        log.error({ migrationId: id, reason: applied.reason }, 'could not settle a Migration');
        return false;
      }
      await publishMigration(tx, id, now);
      return true;
    });
    if (done) settled.push(id);
  }
  return settled;
}
