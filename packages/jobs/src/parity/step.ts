/**
 * The `verify` Step (LIF-040 step 13) and the planner of `verify` Runs. A Parity error never fails
 * the Run (LIF-042): a Facet that cannot be read is stored `unverifiable`, and the Step is
 * `advisory`. The Migration's status follows when the Run ends (`run/finish.ts`, LIF-002: "then
 * `parity_*` from the Run's verify step applies"). Decisions: docs/adr/0396-parity-engine-and-verified-status.md.
 */
import type { RunPlanner, StepDefinition } from '../run/types.ts';
import { computeParity, type ParityDeps, type ParityServices } from './compute.ts';
import { storeParity } from './store.ts';

export { PARITY_RUN_KINDS } from './verdict.ts';

/** The key of the Step in every Run kind that verifies (LIF-040 step 13, LIF-081). */
export const VERIFY_STEP_KEY = 'verify';

/**
 * The Step. T-071's migrate planners append it after `overlays.apply`; the `verify` planner below
 * uses it alone. It needs nothing from `ctx.services`: everything it uses is in `deps`.
 */
export function createVerifyStep<S = unknown>(deps: ParityDeps): StepDefinition<S> {
  return {
    key: VERIFY_STEP_KEY,
    severity: 'advisory',
    async run(ctx) {
      const now = deps.now ?? (() => new Date());
      const computation = await computeParity(deps, ctx.migration.id, {
        shutdown: ctx.signal,
        pool: 'interactive',
        log: ctx.log,
        // T-071's `git.prepare` leaves the source mirror; reading the LFS ids from it costs nothing.
        mirrorDir: (ctx.services as ParityServices | undefined)?.sourceMirror?.(ctx.run.id),
      });
      if (computation.skipped) {
        return { status: 'skipped', reason: `nothing to verify: ${computation.skipped}` };
      }
      if (computation.facets.length === 0) {
        return { status: 'skipped', reason: 'nothing to verify: no Facet to compare' };
      }
      ctx.checkpoint();
      const stored = await ctx.transaction(
        (tx) =>
          storeParity(tx, {
            computation,
            registry: deps.registry.facets,
            now: now(),
            log: ctx.log,
          }),
        { migration: true },
      );
      // Superseded cannot happen to a Migration that is `running`; if it does, the newer data stands.
      const statuses: Record<string, string> = {};
      for (const facet of computation.facets) {
        statuses[facet.facetKey] = facet.status;
        if (facet.status === 'unverifiable') {
          await ctx.runLog('warn', `${facet.facetKey} could not be verified`, {
            facetKey: facet.facetKey,
            reason: facet.reason ?? 'unknown',
          });
        }
      }
      return {
        status: 'succeeded',
        detail: {
          facets: statuses,
          completedTasks: stored.completed.length,
          ...(stored.superseded ? { superseded: true } : {}),
        },
      };
    },
  };
}

/** `verify` Runs (LIF-040): the one Step. The status follows from the ParityResults (LIF-061). */
export function createVerifyPlanner<S = unknown>(deps: ParityDeps): RunPlanner<S> {
  return { steps: () => [createVerifyStep<S>(deps)] };
}
