import type { DetailRunKind, MigrationDetail, RunSummaryRow } from './api.ts';

/**
 * Which actions the header offers (UI-022). These rules only decide what is worth showing; the
 * server decides again for every request (LIF-005, LIF-043, LIF-077, DOM-010) and a refusal is
 * shown with its own message.
 */

export type HeaderAction =
  | 'analyze'
  | 'migrate'
  | 'run_anyway'
  | 'force_adopt'
  | 'resync'
  | 'verify'
  | 'rollback'
  | 'source_read_only'
  | 'undo_source_read_only'
  | 'mark_complete'
  | 'revoke_complete';

/** Statuses a first (or repeated after failure) migration may start from. */
const MIGRATABLE = ['analyzed', 'failed', 'rolled_back'] as const;
/** Statuses with a target that exists, or may exist after a partial Run. */
const MIGRATED = ['migrated', 'partial', 'verified', 'manually_completed', 'drifted'] as const;
/** LIF-077: rollback is not offered for these. */
const NO_ROLLBACK = ['running', 'source_missing', 'discovered', 'rolled_back'] as const;
/** The blocker force-adopt overrides (LIF-031, LIF-043). */
export const FORCE_ADOPT_BLOCKER = 'target.exists-nonempty';

const isIn = (list: readonly string[], value: string) => list.includes(value);

/** True while a Run is queued or running (DOM-010): nothing else may start. */
export const hasActiveRun = (runs: readonly RunSummaryRow[]): boolean =>
  runs.some((r) => r.status === 'queued' || r.status === 'running');

/** The full name the typed confirmation must equal (LIF-043, LIF-077). `null`: nothing to name. */
export function targetFullName(m: MigrationDetail): string | null {
  if (m.targetRepository) return m.targetRepository.fullPath;
  return m.plannedTargetName ? `${m.route.targetNamespacePath}/${m.plannedTargetName}` : null;
}

/** The blocker of a legacy Migration whose target writes have no recorded place (ADR-0504). */
export const PLACEMENT_UNKNOWN_BLOCKER = 'repository-settings.target-placement-unknown';

/**
 * The readiness the header offers Runs by. A legacy Migration of unknown place is blocked only by
 * `PLACEMENT_UNKNOWN_BLOCKER`, which its typed confirmation answers, so the server judges it by its
 * open pre tasks (the guard's `effectiveReadiness` with that blocker waived, ADR-0504).
 */
export function offeredReadiness(m: MigrationDetail): MigrationDetail['readiness'] {
  if (m.targetPlacementUnknown !== true || m.readiness !== 'blocked') return m.readiness;
  if (
    m.blockerCodes.length === 0 ||
    !m.blockerCodes.every((c) => c === PLACEMENT_UNKNOWN_BLOCKER)
  ) {
    return m.readiness;
  }
  return (m.readinessCounts?.preTasks ?? 0) > 0 ? 'needs_attention' : 'ready';
}

export interface ActionState {
  readonly action: HeaderAction;
  /** Why the action cannot be used now (shown as a hint), or undefined when it can. */
  readonly disabled?: 'active_run' | 'running';
}

/**
 * The actions for a Migration, in display order. `runs` may be empty while they load; then no
 * action is disabled for an active Run and the server's `run_active` answer covers it.
 */
export function availableActions(
  m: MigrationDetail,
  runs: readonly RunSummaryRow[],
): readonly ActionState[] {
  if (m.scope !== 'repository') return [{ action: 'analyze' }];
  const out: ActionState[] = [];
  const active = hasActiveRun(runs) || m.status === 'running';
  const lock = (action: HeaderAction): ActionState =>
    active ? { action, disabled: m.status === 'running' ? 'running' : 'active_run' } : { action };
  const blocked = m.status === 'source_missing';
  const readiness = offeredReadiness(m);

  out.push(lock('analyze'));
  if (!blocked && isIn(MIGRATABLE, m.status)) {
    if (readiness === 'ready') out.push(lock('migrate'));
    if (readiness === 'needs_attention') out.push(lock('run_anyway'));
    if (m.blockerCodes.includes(FORCE_ADOPT_BLOCKER)) out.push(lock('force_adopt'));
  }
  if (!blocked && isIn(MIGRATED, m.status) && readiness !== 'blocked') out.push(lock('resync'));
  if (!blocked && m.targetRepository !== null && m.status !== 'running') out.push(lock('verify'));
  const hasMutations = runs.some((r) => r.hasMutations);
  if (!isIn(NO_ROLLBACK, m.status) && (m.targetRepository !== null || hasMutations)) {
    out.push(lock('rollback'));
  }
  if (!blocked && m.targetRepository !== null && isIn(MIGRATED, m.status)) {
    out.push(lock(m.sourceReadOnlyApplied ? 'undo_source_read_only' : 'source_read_only'));
  }
  if (m.status === 'manually_completed') out.push(lock('revoke_complete'));
  else if (!blocked && m.status !== 'running') out.push(lock('mark_complete'));
  return out;
}

/** The Run kind a force-adopt starts: a plain migrate unless pre tasks are open (LIF-043). */
export function forceAdoptKind(
  m: MigrationDetail,
): Extract<DetailRunKind, 'migrate' | 'run_anyway'> {
  return (m.readinessCounts?.preTasks ?? 0) > 0 ? 'run_anyway' : 'migrate';
}

/** The facet badge color class of a finding kind (worst first). */
export const FINDING_ORDER = ['blocker', 'pre_task', 'post_task', 'warning'] as const;
export type FindingKind = (typeof FINDING_ORDER)[number];
