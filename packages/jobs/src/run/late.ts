/**
 * A ledger write that lands after its Run finished (the worker was slow, or kept working after a
 * cancel or a lease takeover). The change is real, so the record is kept (ADR-0342); this restores
 * what LIF-002 says about a Run that "recorded any Mutation", and flags every other case.
 */
import { type MigrationStatus, transition } from '@git-migrator/core';
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
 *   `recordedMutation` true, through `transition()`, which checks the move is legal.
 * - Every other case, whatever the Run's status, an earlier Mutation, later Runs or the
 *   Migration's status (including `rolled_back`): the Migration is not rewritten. A run-origin
 *   blocker `run.late-mutation` (`{runId, mutationId}`, LIF-049) is added, the Analysis is marked
 *   stale, a warning is logged and `migration.updated` is published, so an operator looks before
 *   anything else is done to a target that holds a change nobody expected.
 */
export async function reconcileLateWrite(tx: Tx, input: LateWriteInput): Promise<void> {
  const now = input.now();
  const last = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM app.mutation WHERE run_id = ${input.runId} ORDER BY seq DESC LIMIT 1`;
  const mutationId = last[0]?.id ?? null;
  const migration = await tx.migration.findUniqueOrThrow({ where: { id: input.migrationId } });
  const later = await tx.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM app.run
    WHERE migration_id = ${input.migrationId}
      AND created_at > (SELECT created_at FROM app.run WHERE id = ${input.runId})`;
  const noLaterRun = (later[0]?.n ?? 0) === 0;
  const kind = await tx.run.findUniqueOrThrow({
    where: { id: input.runId },
    select: { kind: true },
  });

  if (
    input.runStatus === 'cancelled' &&
    !input.hadMutations &&
    noLaterRun &&
    migration.status === migration.statusBeforeRun
  ) {
    // The Migration is where the cancel left it: replay the Run's end with the Mutation counted.
    const next = transition(
      {
        status: 'running',
        statusBeforeRun: migration.statusBeforeRun as MigrationStatus | null,
        statusBeforeDrift: migration.statusBeforeDrift as MigrationStatus | null,
        statusBeforeManual: migration.statusBeforeManual as MigrationStatus | null,
        statusBeforeMissing: migration.statusBeforeMissing as MigrationStatus | null,
      },
      { type: 'run_finished', kind: kind.kind, outcome: 'cancelled', recordedMutation: true },
    );
    if (next.ok) {
      await tx.migration.update({
        where: { id: input.migrationId },
        data: { status: next.state.status },
      });
      input.log?.warn(
        { runId: input.runId, migrationId: input.migrationId },
        'a change landed after the Run was cancelled; the Migration is now partial',
      );
      await publishMigration(tx, input.migrationId, input.now);
      return;
    }
  }
  await addRunBlocker(
    tx,
    input.migrationId,
    { code: LATE_MUTATION_CODE, params: { runId: input.runId, mutationId } },
    now,
  );
  await markAnalysesStale(tx, { ids: [input.migrationId] });
  input.log?.warn(
    {
      runId: input.runId,
      migrationId: input.migrationId,
      mutationId,
      runStatus: input.runStatus,
      migrationStatus: migration.status,
    },
    'a change landed after the Run finished; flagged for review',
  );
  await publishMigration(tx, input.migrationId, input.now);
}
