/**
 * LIF-061: what the stored ParityResults and the open ManualTasks say about the Migration, and the
 * lifecycle event that follows. The status always changes through `transition()` (LIF-002,
 * LIF-003), never by assignment. Decisions: docs/adr/0396-parity-engine-and-verified-status.md.
 */
import {
  type LifecycleEvent,
  type LifecycleState,
  type MigrationStatus,
  transition,
} from '@git-migrator/core';
import type { Tx } from '../run/types.ts';

/** Run kinds whose `verify` Step decides the Migration's parity status when the Run ends. */
export const PARITY_RUN_KINDS: ReadonlySet<string> = new Set([
  'migrate',
  'run_anyway',
  'resync',
  'verify',
]);

export interface ParityVerdict {
  /** `parity_equal` or `parity_different`, or `null` when parity says nothing (LIF-061). */
  readonly event: 'parity_equal' | 'parity_different' | null;
  /** Latest status per Facet that writes a ParityResult. */
  readonly facets: Readonly<Record<string, string>>;
  readonly openTasks: number;
}

/**
 * - `parity_equal`: at least one Facet wrote a ParityResult, every Facet's latest one is `equal`, and
 *   no ManualTask is `open` (LIF-061).
 * - `parity_different`: some Facet's latest ParityResult is `different`.
 * - Otherwise nothing: `unverifiable` is not a difference, and open tasks stop `parity_equal` only.
 */
export async function parityVerdict(tx: Tx, migrationId: string): Promise<ParityVerdict> {
  const rows = await tx.$queryRaw<{ facet_key: string; status: string }[]>`
    SELECT DISTINCT ON (facet_key) facet_key, status
    FROM app.parity_result
    WHERE migration_id = ${migrationId}
    ORDER BY facet_key, checked_at DESC, id DESC`;
  const openTasks = await tx.manualTask.count({ where: { migrationId, status: 'open' } });
  const facets = Object.fromEntries(rows.map((r) => [r.facet_key, r.status]));
  const statuses = rows.map((r) => r.status);
  let event: ParityVerdict['event'] = null;
  if (statuses.includes('different')) event = 'parity_different';
  else if (statuses.length > 0 && statuses.every((s) => s === 'equal') && openTasks === 0) {
    event = 'parity_equal';
  }
  return { event, facets, openTasks };
}

export type VerdictApplied =
  | { readonly applied: true; readonly event: ParityVerdict['event']; readonly changed: boolean }
  | { readonly applied: false; readonly reason: string };

/**
 * Applies the verdict to the Migration. The caller holds the Migration row lock. A Migration that is
 * `running` takes no parity event: the Run's own end applies it (LIF-002: "then `parity_*` from the
 * Run's verify step applies").
 */
export async function applyParityVerdict(
  tx: Tx,
  migrationId: string,
  now: Date,
): Promise<VerdictApplied> {
  const verdict = await parityVerdict(tx, migrationId);
  if (verdict.event === null) return { applied: true, event: null, changed: false };
  const cur = await tx.migration.findUniqueOrThrow({ where: { id: migrationId } });
  const state: LifecycleState = {
    status: cur.status as MigrationStatus,
    statusBeforeRun: cur.statusBeforeRun as MigrationStatus | null,
    statusBeforeDrift: cur.statusBeforeDrift as MigrationStatus | null,
    statusBeforeManual: cur.statusBeforeManual as MigrationStatus | null,
    statusBeforeMissing: cur.statusBeforeMissing as MigrationStatus | null,
  };
  const event: LifecycleEvent = { type: verdict.event };
  const next = transition(state, event);
  if (!next.ok) return { applied: false, reason: next.error.message };
  if (!next.changed) return { applied: true, event: verdict.event, changed: false };
  const verified = next.effects.some((e) => e.type === 'set_verified_at');
  await tx.migration.update({
    where: { id: migrationId },
    data: {
      status: next.state.status,
      statusBeforeRun: next.state.statusBeforeRun,
      statusBeforeDrift: next.state.statusBeforeDrift,
      statusBeforeManual: next.state.statusBeforeManual,
      statusBeforeMissing: next.state.statusBeforeMissing,
      ...(verified ? { verifiedAt: now } : {}),
    },
  });
  return { applied: true, event: verdict.event, changed: true };
}
