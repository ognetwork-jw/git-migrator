/**
 * Readiness derivation (LIF-004).
 *
 * - `blocked` if the latest Analysis has a blocker, or there is an open run-origin blocker (LIF-049);
 * - `needs_attention` if any `pre` task is `open`;
 * - `ready` otherwise.
 * Post tasks never affect readiness. Decisions: docs/adr/0059-readiness-and-policy-resolution.md.
 */

export type Readiness = 'ready' | 'needs_attention' | 'blocked';
export type TaskPhase = 'pre' | 'post';
export type TaskStatus = 'open' | 'done' | 'dismissed';

export interface ReadinessAnalysis {
  /** Blocker findings of the latest Analysis (`PlanItem` kind `blocker`). */
  readonly blockers: readonly { readonly code: string }[];
  /** Number of warning findings (informational). */
  readonly warnings: number;
}

export interface ReadinessTask {
  readonly phase: TaskPhase;
  readonly status: TaskStatus;
}

export interface ReadinessInput {
  /** The latest Analysis, or `null` when the Migration has none (never analyzed, or pruned). */
  readonly analysis: ReadinessAnalysis | null;
  /** `Migration.runBlockers`: run-origin blockers that have not been cleared or dismissed. */
  readonly runBlockers: readonly { readonly code: string }[];
  /** Every ManualTask of the Migration, of any origin and status. */
  readonly tasks: readonly ReadinessTask[];
}

/** `Migration.readinessCounts`. */
export interface ReadinessCounts {
  readonly blockers: number;
  readonly preTasks: number;
  readonly postTasks: number;
  readonly warnings: number;
}

export interface ReadinessResult {
  /** `null` only when there is no Analysis and no run-origin blocker. */
  readonly readiness: Readiness | null;
  readonly counts: ReadinessCounts;
  /** Sorted, unique codes of the analysis and run-origin blockers (`Migration.blockerCodes`). */
  readonly blockerCodes: string[];
}

/**
 * Derives readiness. `preTasks` and `postTasks` count open tasks only. With no Analysis the
 * readiness is unset, except that open run-origin blockers still block (fail closed), so pruning
 * an Analysis can never turn a blocked Migration into an unset one.
 */
export function deriveReadiness(input: ReadinessInput): ReadinessResult {
  const analysisBlockers = input.analysis?.blockers ?? [];
  const blockers = analysisBlockers.length + input.runBlockers.length;
  const preTasks = input.tasks.filter((t) => t.phase === 'pre' && t.status === 'open').length;
  const postTasks = input.tasks.filter((t) => t.phase === 'post' && t.status === 'open').length;
  const counts: ReadinessCounts = {
    blockers,
    preTasks,
    postTasks,
    warnings: input.analysis?.warnings ?? 0,
  };
  const blockerCodes = [
    ...new Set([...analysisBlockers, ...input.runBlockers].map((b) => b.code)),
  ].sort();

  let readiness: Readiness | null;
  if (blockers > 0) readiness = 'blocked';
  else if (input.analysis === null) readiness = null;
  else readiness = preTasks > 0 ? 'needs_attention' : 'ready';
  return { readiness, counts, blockerCodes };
}
