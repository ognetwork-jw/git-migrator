/**
 * Run-origin findings (LIF-049): blockers in `Migration.runBlockers` and ManualTasks with
 * `origin: run`, and the readiness recomputation they trigger (LIF-004). Decisions:
 * docs/adr/0343-run-guard-and-findings.md.
 */
import { deriveReadiness, hashCanonical } from '@git-migrator/core';
import { toJson } from './store.ts';
import type { Tx } from './types.ts';

export interface RunBlocker {
  readonly code: string;
  readonly params: Record<string, unknown>;
  readonly at: string;
}

function parseBlockers(value: unknown): RunBlocker[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (b): b is RunBlocker => typeof b === 'object' && b !== null && typeof b.code === 'string',
  );
}

/**
 * Recomputes `readiness`, `readinessCounts` and `blockerCodes` from the latest Analysis' blockers,
 * the run-origin blockers and every ManualTask (LIF-004). The caller holds the Migration row lock.
 */
export async function recomputeReadiness(tx: Tx, migrationId: string): Promise<void> {
  const migration = await tx.migration.findUniqueOrThrow({
    where: { id: migrationId },
    select: { runBlockers: true, latestAnalysisId: true },
  });
  const planItems = migration.latestAnalysisId
    ? await tx.planItem.findMany({
        where: { analysisId: migration.latestAnalysisId, kind: { in: ['blocker', 'warning'] } },
        select: { kind: true, code: true },
      })
    : null;
  const tasks = await tx.manualTask.findMany({
    where: { migrationId },
    select: { phase: true, status: true },
  });
  const derived = deriveReadiness({
    analysis: planItems
      ? {
          blockers: planItems.filter((p) => p.kind === 'blocker'),
          warnings: planItems.filter((p) => p.kind === 'warning').length,
        }
      : null,
    runBlockers: parseBlockers(migration.runBlockers),
    tasks: tasks.map((t) => ({
      phase: t.phase === 'pre' ? ('pre' as const) : ('post' as const),
      status: t.status,
    })),
  });
  await tx.migration.update({
    where: { id: migrationId },
    data: {
      readiness: derived.readiness,
      readinessCounts: { ...derived.counts },
      blockerCodes: derived.blockerCodes,
    },
  });
}

/** Adds or refreshes a run-origin blocker (one per code and params) and recomputes readiness. */
export async function addRunBlocker(
  tx: Tx,
  migrationId: string,
  finding: { code: string; params?: Record<string, unknown> },
  at: Date,
): Promise<void> {
  const row = await tx.migration.findUniqueOrThrow({
    where: { id: migrationId },
    select: { runBlockers: true },
  });
  const params = finding.params ?? {};
  const key = hashCanonical(params);
  const kept = parseBlockers(row.runBlockers).filter(
    (b) => !(b.code === finding.code && hashCanonical(b.params ?? {}) === key),
  );
  const next: RunBlocker[] = [...kept, { code: finding.code, params, at: at.toISOString() }];
  await tx.migration.update({ where: { id: migrationId }, data: { runBlockers: toJson(next) } });
  await recomputeReadiness(tx, migrationId);
}

/** Removes run-origin blockers by code. Returns the number removed. */
export async function clearRunBlockers(
  tx: Tx,
  migrationId: string,
  codes: readonly string[],
): Promise<number> {
  const row = await tx.migration.findUniqueOrThrow({
    where: { id: migrationId },
    select: { runBlockers: true },
  });
  const all = parseBlockers(row.runBlockers);
  const next = all.filter((b) => !codes.includes(b.code));
  if (next.length === all.length) return 0;
  await tx.migration.update({ where: { id: migrationId }, data: { runBlockers: toJson(next) } });
  await recomputeReadiness(tx, migrationId);
  return all.length - next.length;
}

/**
 * Adds a run-origin ManualTask, identified by (code, facetKey, paramsHash) like an analysis-origin
 * one. An existing task of that identity keeps its status and origin: a task an operator completed
 * is not reopened by a later Run. Returns whether a task was created.
 */
export async function addRunTask(
  tx: Tx,
  migrationId: string,
  finding: {
    code: string;
    facetKey: string;
    phase: 'pre' | 'post';
    params?: Record<string, unknown>;
    verifiable?: boolean;
  },
): Promise<boolean> {
  const params = finding.params ?? {};
  const paramsHash = hashCanonical(params);
  const existing = await tx.manualTask.findFirst({
    where: { migrationId, code: finding.code, facetKey: finding.facetKey, paramsHash },
    select: { id: true },
  });
  if (existing) return false;
  await tx.manualTask.create({
    data: {
      migrationId,
      facetKey: finding.facetKey,
      code: finding.code,
      phase: finding.phase,
      origin: 'run',
      params: toJson(params),
      verifiable: finding.verifiable === true,
      paramsHash,
    },
  });
  await recomputeReadiness(tx, migrationId);
  return true;
}
