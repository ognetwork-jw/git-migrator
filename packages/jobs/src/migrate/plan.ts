/**
 * The Steps of a migrate, run-anyway or resync Run (LIF-040): the Run's Analysis lists them in
 * LIF-040 order (`PlanItem` of kind `step`), and each listed key maps to its implementation here.
 * A key without an implementation (`verify`, `source.read-only` until T-072 and T-073 provide them
 * through `MigrationServices.extraSteps`) is left out. After the last planned Step the Migration is
 * analyzed again. Decisions: docs/adr/0380-migration-steps.md.
 */
import { StepFailure } from '../run/errors.ts';
import type { RunPlanner, StepDefinition } from '../run/types.ts';
import { changeRequestsStep } from './change-requests.ts';
import { facetApplyStep } from './facets.ts';
import { overlaysStep } from './overlays.ts';
import { gitPrepareStep, preflightStep } from './prepare.ts';
import { pushLfsStep, pushRefsStep } from './push.ts';
import { ensureRepositoryStep, liftProtectionStep } from './repository.ts';
import type { MigrationServices } from './services.ts';

/** Step 13's neighbour: re-analyzes at the end of the Run (T-062 follow-up, ADR-0380). */
export function refreshAnalysisStep(): StepDefinition<MigrationServices> {
  return {
    key: 'analysis.refresh',
    severity: 'advisory',
    async run(ctx) {
      await ctx.services.reanalyze(ctx.migration.id, ctx.signal);
      return { status: 'succeeded' };
    },
  };
}

const FACET_STEP = /^facet\.([a-z][a-z0-9-]*)\.apply$/;

const FIXED: Readonly<Record<string, () => StepDefinition<MigrationServices>>> = {
  preflight: preflightStep,
  'git.prepare': gitPrepareStep,
  'target.ensure-repository': ensureRepositoryStep,
  'target.lift-protection': liftProtectionStep,
  'git.push-lfs': pushLfsStep,
  'git.push-refs': pushRefsStep,
  'change-requests.open': changeRequestsStep,
  'overlays.apply': overlaysStep,
};

/** Keys of the Steps this task implements, in LIF-040 order. */
export const IMPLEMENTED_STEP_KEYS: readonly string[] = Object.keys(FIXED);

export function createMigrationPlanner(services: MigrationServices): RunPlanner<MigrationServices> {
  return {
    async steps({ run, migration }) {
      if (migration.scope !== 'repository') {
        // The endpoint Run order is LIF-081 (T-086); until it is registered the Run fails visibly.
        return [
          {
            key: 'run.scope',
            severity: 'fatal',
            async run() {
              throw new StepFailure(
                'run.scope_unsupported',
                'Runs of an endpoint Migration are not implemented yet',
              );
            },
          },
        ];
      }
      const items =
        run.analysisId === null
          ? []
          : await services.db.planItem.findMany({
              where: { analysisId: run.analysisId, kind: 'step' },
              orderBy: { order: 'asc' },
              select: { code: true, facetKey: true },
            });
      const defs: StepDefinition<MigrationServices>[] = [];
      for (const item of items) {
        const facet = FACET_STEP.exec(item.code)?.[1];
        const fixed = FIXED[item.code];
        const extra = services.extraSteps?.get(item.code);
        const def = facet ? facetApplyStep(facet) : fixed ? fixed() : extra;
        if (def) defs.push(def);
      }
      defs.push(refreshAnalysisStep());
      return defs;
    },
  };
}
