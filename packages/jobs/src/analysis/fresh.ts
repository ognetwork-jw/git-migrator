/**
 * LIF-021 and LIF-022: when an Analysis is too old for a Run, and whether re-analysis made the
 * readiness worse. The Run executor (T-070) calls `analyzeForRun` before a migrate, run-anyway or
 * resync Run and aborts with `readiness_changed` when `worsened` is true.
 * Decisions: docs/adr/0310-analysis-processor.md.
 */
import type { Readiness } from '@git-migrator/core';
import {
  type AnalysisDeps,
  type AnalysisResult,
  type AnalysisRunOptions,
  runAnalysis,
} from './analysis.ts';

/** Best first. `null` (never analyzed) is worse than any readiness. */
const RANK: Record<Readiness, number> = { ready: 0, needs_attention: 1, blocked: 2 };

/** True when `after` allows less than `before` (LIF-005 gates Runs by readiness). */
export function readinessWorsened(before: Readiness | null, after: Readiness | null): boolean {
  const rank = (r: Readiness | null) => (r === null ? 3 : RANK[r]);
  return rank(after) > rank(before);
}

export interface AnalysisAge {
  /** `Analysis.createdAt` of the latest Analysis, or `null` when there is none. */
  readonly analyzedAt: Date | null;
  /** `Migration.analysisStaleAt`. */
  readonly staleAt: Date | null;
}

/**
 * LIF-021: a Run re-analyzes inline when there is no Analysis, it is stale, or it is older than
 * `schedules.runRequiresAnalysisWithin`.
 */
export function needsReanalysis(
  age: AnalysisAge,
  now: Date,
  runRequiresAnalysisWithinMs: number,
): boolean {
  if (age.analyzedAt === null) return true;
  if (age.staleAt !== null && age.staleAt <= now) return true;
  return now.getTime() - age.analyzedAt.getTime() > runRequiresAnalysisWithinMs;
}

export interface RunAnalysisOutcome {
  readonly reanalyzed: boolean;
  readonly before: Readiness | null;
  readonly after: Readiness | null;
  /** The Run must abort with `readiness_changed` (LIF-022). */
  readonly worsened: boolean;
  readonly result?: AnalysisResult;
}

/**
 * Re-analyzes `migrationId` inline (interactive pool) when LIF-021 says so, and reports whether the
 * readiness got worse. Does nothing when the Analysis is fresh enough.
 */
export async function analyzeForRun(
  deps: AnalysisDeps,
  migrationId: string,
  options: Omit<AnalysisRunOptions, 'pool'>,
): Promise<RunAnalysisOutcome> {
  const row = await deps.db.migration.findUniqueOrThrow({
    where: { id: migrationId },
    select: {
      readiness: true,
      analysisStaleAt: true,
      latestAnalysis: { select: { createdAt: true } },
    },
  });
  const before = row.readiness as Readiness | null;
  const now = (deps.now ?? (() => new Date()))();
  const age: AnalysisAge = {
    analyzedAt: row.latestAnalysis?.createdAt ?? null,
    staleAt: row.analysisStaleAt,
  };
  if (!needsReanalysis(age, now, deps.config.schedules.runRequiresAnalysisWithin)) {
    return { reanalyzed: false, before, after: before, worsened: false };
  }
  const result = await runAnalysis(deps, migrationId, { ...options, pool: 'interactive' });
  const after = (
    await deps.db.migration.findUniqueOrThrow({
      where: { id: migrationId },
      select: { readiness: true },
    })
  ).readiness as Readiness | null;
  return { reanalyzed: true, before, after, worsened: readinessWorsened(before, after), result };
}
