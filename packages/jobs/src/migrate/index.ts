/**
 * Migration Steps (T-071): LIF-040 steps 1 to 12 of a migrate, run-anyway or resync Run, with the
 * adoption of LIF-031, the batched push of LIF-044, the Change Requests of LIF-047 and the
 * Overlays of LIF-048. `registerMigrationSteps` is called once by the worker.
 */
import type { RunKind } from '@git-migrator/core';
import type { RunStepRegistry } from '../run/types.ts';
import { createMigrationPlanner } from './plan.ts';
import type { MigrationServices } from './services.ts';
import { createSourceLockPlanner } from './source-read-only.ts';

export const MIGRATION_RUN_KINDS: readonly RunKind[] = ['migrate', 'run_anyway', 'resync'];

/** Registers the Steps of the three repository migration kinds (LIF-040, LIF-043) and the two source lock kinds (LIF-070). */
export function registerMigrationSteps(
  registry: RunStepRegistry<MigrationServices>,
  services: MigrationServices,
): void {
  for (const kind of MIGRATION_RUN_KINDS) registry.register(kind, createMigrationPlanner(services));
  // LIF-070: the two Run kinds that only lock or unlock the source.
  registry.register('source_read_only', createSourceLockPlanner('source_read_only'));
  registry.register('undo_source_read_only', createSourceLockPlanner('undo_source_read_only'));
}

export { changeRequestsStep, partialMutationsOf } from './change-requests.ts';
export {
  createdTeamSlugs,
  ENDPOINT_FACET_KEYS,
  endpointFacetStep,
  loadEndpointWorld,
  settleTeams,
} from './endpoint.ts';
export { facetApplyStep } from './facets.ts';
export { branchPatternMatches } from './glob.ts';
export { MirrorRegistry } from './mirror.ts';
export { overlaysStep } from './overlays.ts';
export { createMigrationPlanner, IMPLEMENTED_STEP_KEYS, refreshAnalysisStep } from './plan.ts';
export { gitPrepareStep, preflightStep } from './prepare.ts';
export { chooseDefaultBranch, pushLfsStep, pushRefsStep } from './push.ts';
export { ensureRepositoryStep, liftProtectionStep } from './repository.ts';
export {
  connectSide,
  effectiveMaxPushBytes,
  type MigrationContext,
  MigrationLinks,
  type MigrationServices,
  type Side,
} from './services.ts';
export {
  createSourceLockPlanner,
  SOURCE_LOCK_RUN_KINDS,
  SOURCE_READ_ONLY_STEP,
  sourceReadOnlyStep,
  targetWebUrl,
  UNDO_SOURCE_READ_ONLY_STEP,
  undoSourceReadOnlyStep,
} from './source-read-only.ts';
