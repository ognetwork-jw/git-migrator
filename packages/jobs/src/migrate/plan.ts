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
import { ENDPOINT_FACET_KEYS, endpointFacetStep } from './endpoint.ts';
import { facetApplyStep } from './facets.ts';
import { overlaysStep } from './overlays.ts';
import { gitPrepareStep, preflightStep } from './prepare.ts';
import { pushLfsStep, pushRefsStep } from './push.ts';
import { ensureRepositoryStep, liftProtectionStep, warnIfProtectionLifted } from './repository.ts';
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

/**
 * A Step the Plan lists and nobody implements (yet): it is planned as skipped with its reason and
 * a Run log warning, never left out silently (LIF-081, ADR-0435).
 */
export function unimplementedStep(code: string): StepDefinition<MigrationServices> {
  return {
    key: code,
    severity: 'advisory',
    async run(ctx) {
      const reason = `no implementation is registered for the planned Step ${code}`;
      await ctx.runLog('warn', reason, { step: code });
      return { status: 'skipped', reason };
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

/**
 * The Steps of an endpoint-scope Run (LIF-081): the `step` PlanItems of the Run's Analysis in
 * `ENDPOINT_STEP_TEMPLATE` order (`members`, `teams`, `org-variables`, `org-webhooks`, `verify`),
 * mapped to their implementations, then the re-analysis. Same dispatch as the repository kinds
 * (ADR-0380, ADR-0435): the executor is not forked.
 */
async function endpointSteps(
  services: MigrationServices,
  analysisId: string | null,
): Promise<StepDefinition<MigrationServices>[]> {
  if (analysisId === null) {
    return [
      {
        key: 'run.analysis',
        severity: 'fatal',
        async run() {
          throw new StepFailure('run.analysis_missing', 'The Run has no Analysis to apply');
        },
      },
    ];
  }
  const items = await services.db.planItem.findMany({
    where: { analysisId, kind: 'step' },
    orderBy: { order: 'asc' },
    select: { code: true },
  });
  const defs: StepDefinition<MigrationServices>[] = [];
  for (const item of items) {
    const facet = FACET_STEP.exec(item.code)?.[1];
    const def =
      facet && ENDPOINT_FACET_KEYS.includes(facet)
        ? endpointFacetStep(facet)
        : services.extraSteps?.get(item.code);
    defs.push(def ?? unimplementedStep(item.code));
  }
  defs.push(refreshAnalysisStep());
  return defs;
}

export function createMigrationPlanner(services: MigrationServices): RunPlanner<MigrationServices> {
  return {
    async steps({ run, migration }) {
      if (migration.scope === 'endpoint') return endpointSteps(services, run.analysisId);
      if (run.analysisId === null) {
        return [
          {
            key: 'run.analysis',
            severity: 'fatal',
            async run() {
              throw new StepFailure('run.analysis_missing', 'The Run has no Analysis to apply');
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
        let def = facet ? facetApplyStep(facet) : fixed ? fixed() : extra;
        // A Step that fails for good after step 3a lifted rules names them (LIF-049, ADR-0380).
        if (def && (item.code === 'git.push-lfs' || item.code === 'git.push-refs')) {
          def = { ...def, onFailed: warnIfProtectionLifted };
        }
        defs.push(def ?? unimplementedStep(item.code));
      }
      defs.push(refreshAnalysisStep());
      return defs;
    },
  };
}
