/**
 * A ledger write that lands after its Run finished (the worker was slow, or kept working after a
 * cancel or a lease takeover). The change is real, so the record is kept (ADR-0342); this restores
 * what LIF-002 says about a Run that "recorded any Mutation", and flags every other case.
 */
import { type MigrationStatus, type RunKind, transition } from '@git-migrator/core';
import { markAnalysesStale } from '@git-migrator/db';
import type { Logger } from '@git-migrator/observability';
import { addRunBlocker } from './findings.ts';
import { publishMigration } from './store.ts';
import type { Tx } from './types.ts';

/** The run-origin blocker added when a late write cannot be folded into the Migration's status. */
export const LATE_MUTATION_CODE = 'run.late-mutation';

export interface LateWriteInput {
  readonly runId: string;
  readonly migrationId: string;
  /** The Run's status when the write started. */
  readonly runStatus: string;
  /** `has_mutations` before the write. */
  readonly hadMutations: boolean;
  readonly now: () => Date;
  readonly log?: Logger | undefined;
}

/**
 * Called in the ledger transaction after a write that inserted records into a finished Run, with
 * the Migration and Run row locks held (Migration first). One rule:
 * - The narrow case: the Run is `cancelled`, this is its first Mutation, no later Run exists and
 *   the Migration still has the status the cancel gave it. LIF-002 gives `partial` for a cancelled
 *   Run that recorded a Mutation, so the Migration takes `run_finished(cancelled)` again with
 *   `recordedMutation` true, through `transition()`, which checks the move is legal. A Run kind
 *   whose cancelled row ignores Mutations (`verify`, the source lock kinds) would not move, so it
 *   takes the other path.
 * - Every other case, whatever the Run's status, an earlier Mutation, later Runs or the
 *   Migration's status (including `rolled_back`): the Migration is not rewritten. A run-origin
 *   blocker `run.late-mutation` (`{runId, mutationId}`, LIF-049) is added, the Analysis is marked
 *   stale, a warning is logged and `migration.updated` is published, so an operator looks before
 *   anything else is done to a target that holds a change nobody expected.
 */
export async function reconcileLateWrite(tx: Tx, input: LateWriteInput): Promise<void> {
  const last = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM app.mutation WHERE run_id = ${input.runId} ORDER BY seq DESC LIMIT 1`;
  const mutationId = last[0]?.id ?? null;
  const facts = await lateFacts(tx, input);
  if (input.runStatus === 'cancelled' && !input.hadMutations && facts.noLaterRun) {
    const replayed = await replayCancel(tx, input, facts, true);
    if (replayed) {
      input.log?.warn(
        { runId: input.runId, migrationId: input.migrationId },
        'a change landed after the Run was cancelled; the Migration is now partial',
      );
      return;
    }
  }
  await flagLateWrite(tx, input, mutationId, facts.migration.status);
}

/**
 * Called in the ledger transaction when a late `confirm(not_applied)` left a finished Run with no
 * Mutation (`hadMutations` was true), with the Migration and Run row locks held. Only a cancelled
 * Run's outcome depends on that (LIF-002), so other Runs need nothing. The narrow case mirrors
 * `reconcileLateWrite`: no later Run and the Migration still `partial` from the cancel, so it takes
 * `run_finished(cancelled)` again with `recordedMutation` false and returns to its saved status.
 * Otherwise the Migration is not rewritten and `run.late-mutation` names the settled intent.
 */
export async function reconcileLateNotApplied(
  tx: Tx,
  input: LateWriteInput & { readonly mutationId: string | null },
): Promise<void> {
  if (input.runStatus !== 'cancelled') return;
  const facts = await lateFacts(tx, input);
  if (facts.noLaterRun) {
    const replayed = await replayCancel(tx, input, facts, false);
    if (replayed) {
      input.log?.warn(
        { runId: input.runId, migrationId: input.migrationId },
        'the only change of the cancelled Run was not applied; the Migration returns to its saved status',
      );
      return;
    }
  }
  await flagLateWrite(
    tx,
    input,
    input.mutationId,
    facts.migration.status,
    'a change of the cancelled Run was settled as not applied after it finished; flagged for review',
  );
}

interface LateFacts {
  readonly migration: {
    status: string;
    statusBeforeRun: string | null;
    statusBeforeDrift: string | null;
    statusBeforeManual: string | null;
    statusBeforeMissing: string | null;
  };
  readonly noLaterRun: boolean;
  readonly kind: RunKind;
}

async function lateFacts(tx: Tx, input: LateWriteInput): Promise<LateFacts> {
  const migration = await tx.migration.findUniqueOrThrow({ where: { id: input.migrationId } });
  const later = await tx.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM app.run
    WHERE migration_id = ${input.migrationId}
      AND created_at > (SELECT created_at FROM app.run WHERE id = ${input.runId})`;
  const run = await tx.run.findUniqueOrThrow({
    where: { id: input.runId },
    select: { kind: true },
  });
  return { migration, noLaterRun: (later[0]?.n ?? 0) === 0, kind: run.kind as RunKind };
}

/**
 * Replays `run_finished(cancelled)` with the corrected `recordedMutation` when the Migration still
 * has the status the cancel gave it (the replay with the old value lands where it is now) and the
 * corrected replay moves it. Returns whether the Migration was rewritten.
 */
async function replayCancel(
  tx: Tx,
  input: LateWriteInput,
  facts: LateFacts,
  recordedMutation: boolean,
): Promise<boolean> {
  const running = {
    status: 'running' as const,
    statusBeforeRun: facts.migration.statusBeforeRun as MigrationStatus | null,
    statusBeforeDrift: facts.migration.statusBeforeDrift as MigrationStatus | null,
    statusBeforeManual: facts.migration.statusBeforeManual as MigrationStatus | null,
    statusBeforeMissing: facts.migration.statusBeforeMissing as MigrationStatus | null,
  };
  const replay = (recorded: boolean) =>
    transition(running, {
      type: 'run_finished',
      kind: facts.kind,
      outcome: 'cancelled',
      recordedMutation: recorded,
    });
  const asCancelled = replay(!recordedMutation);
  const corrected = replay(recordedMutation);
  if (!asCancelled.ok || !corrected.ok) return false;
  if (asCancelled.state.status !== facts.migration.status) return false; // moved on since
  if (corrected.state.status === facts.migration.status) return false; // nothing to fold in
  await tx.migration.update({
    where: { id: input.migrationId },
    data: { status: corrected.state.status },
  });
  await publishMigration(tx, input.migrationId, input.now);
  return true;
}

async function flagLateWrite(
  tx: Tx,
  input: LateWriteInput,
  mutationId: string | null,
  migrationStatus: string,
  message = 'a change landed after the Run finished; flagged for review',
): Promise<void> {
  await addRunBlocker(
    tx,
    input.migrationId,
    { code: LATE_MUTATION_CODE, params: { runId: input.runId, mutationId } },
    input.now(),
  );
  await markAnalysesStale(tx, { ids: [input.migrationId] });
  input.log?.warn(
    {
      runId: input.runId,
      migrationId: input.migrationId,
      mutationId,
      runStatus: input.runStatus,
      migrationStatus,
    },
    message,
  );
  await publishMigration(tx, input.migrationId, input.now);
}
