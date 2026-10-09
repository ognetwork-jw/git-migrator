/**
 * Parity outside a Run (LIF-062): after task updates, after Invitation status changes, on demand,
 * and on a schedule (`parity.migration`). Inside a Run the same pieces run as the `verify` Step
 * (`step.ts`). Decisions: docs/adr/0396-parity-engine-and-verified-status.md.
 */
import { publishEventIn } from '@git-migrator/db';
import { lockMigration } from '../run/store.ts';
import type { JobHandlers } from '../runtime.ts';
import { computeParity, type ParityDeps, type ParityOptions, type ParitySkip } from './compute.ts';
import { storeParity } from './store.ts';
import { applyParityVerdict, type VerdictApplied } from './verdict.ts';

/** Statuses with a target to compare (LIF-002): a Run has migrated, or the Migration was completed. */
export const PARITY_STATUSES: readonly string[] = [
  'migrated',
  'partial',
  'verified',
  'manually_completed',
  'drifted',
];

export type ParityRunResult =
  | { readonly skipped: ParitySkip | 'status' | 'running' | 'superseded' | 'no-facets' }
  | {
      readonly skipped?: undefined;
      readonly facets: Readonly<Record<string, string>>;
      readonly completedTasks: readonly string[];
      readonly verdict: VerdictApplied;
    };

/**
 * One on-demand Parity Check: reads, stores the ParityResults, completes verifiable tasks, and
 * applies `parity_equal` or `parity_different` to the Migration through the lifecycle table. A
 * Migration with a queued or running Run is left alone (its `verify` Step covers it), and so is one
 * with no target yet. Safe to repeat.
 */
export async function runParity(
  deps: ParityDeps,
  migrationId: string,
  options: ParityOptions,
): Promise<ParityRunResult> {
  const now = deps.now ?? (() => new Date());
  const before = await deps.db.migration.findUnique({
    where: { id: migrationId },
    select: { status: true },
  });
  if (!before) return { skipped: 'migration-missing' };
  if (before.status === 'running') return { skipped: 'running' };
  if (!PARITY_STATUSES.includes(before.status)) return { skipped: 'status' };

  const computation = await computeParity(deps, migrationId, options);
  if (computation.skipped) return { skipped: computation.skipped };
  if (computation.facets.length === 0) return { skipped: 'no-facets' };

  return deps.db.$transaction(async (tx) => {
    await lockMigration(tx, migrationId);
    const cur = await tx.migration.findUniqueOrThrow({
      where: { id: migrationId },
      select: { status: true },
    });
    // A Run started while the check was reading: its own verify Step reports, not this one.
    if (cur.status === 'running') return { skipped: 'running' as const };
    if (!PARITY_STATUSES.includes(cur.status)) return { skipped: 'status' as const };
    const stored = await storeParity(tx, {
      computation,
      registry: deps.registry.facets,
      now: now(),
      log: deps.log,
    });
    // Another check was stored while this one read: its result is older, so it changes nothing.
    if (stored.superseded) return { skipped: 'superseded' as const };
    const verdict = await applyParityVerdict(tx, migrationId, now());
    if (!verdict.applied) {
      deps.log.error({ migrationId, reason: verdict.reason }, 'parity verdict was rejected');
    } else if (verdict.changed) {
      await publishEventIn(tx, {
        type: 'migration.updated',
        ids: { migration: migrationId },
        at: now().toISOString(),
      });
    }
    return {
      facets: Object.fromEntries(computation.facets.map((f) => [f.facetKey, f.status])),
      completedTasks: stored.completed,
      verdict,
    };
  });
}

/** The `parity.migration` handler (JOB-050: endpoint Migrations on `schedules.endpointParity`). */
export function parityHandlers(deps: ParityDeps): JobHandlers {
  return {
    'parity.migration': async ({ migrationId }, ctx) =>
      runParity(deps, migrationId, {
        shutdown: ctx.shutdown,
        pool: 'background',
        log: ctx.log,
      }),
  };
}
