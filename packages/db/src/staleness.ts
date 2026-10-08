import type { Db } from './client.ts';

/** The part of a Migration filter callers may narrow by (all Migrations of the Route, or a few). */
export interface StaleScope {
  readonly routeId?: string;
  readonly ids?: readonly string[];
  readonly sourceRepositoryIds?: readonly string[];
}

/**
 * Marks the latest Analysis of the matching Migrations stale now (LIF-021). `analysisStaleAt` is
 * the instant an Analysis becomes stale (LIF-020 step 7), so a Migration that is already stale
 * keeps its earlier instant and only a still-fresh one is written. Returns the ids marked. An
 * empty `ids` or `sourceRepositoryIds` list matches nothing.
 */
export async function markAnalysesStale(
  db: Pick<Db, 'migration'>,
  scope: StaleScope,
  now: Date = new Date(),
): Promise<string[]> {
  if (scope.ids?.length === 0 || scope.sourceRepositoryIds?.length === 0) return [];
  const where = {
    ...(scope.routeId === undefined ? {} : { routeId: scope.routeId }),
    ...(scope.ids === undefined ? {} : { id: { in: [...scope.ids] } }),
    ...(scope.sourceRepositoryIds === undefined
      ? {}
      : { sourceRepositoryId: { in: [...scope.sourceRepositoryIds] } }),
    latestAnalysisId: { not: null },
    OR: [{ analysisStaleAt: null }, { analysisStaleAt: { gt: now } }],
  };
  const rows = await db.migration.findMany({ where, select: { id: true } });
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  await db.migration.updateMany({
    where: { ...where, id: { in: ids } },
    data: { analysisStaleAt: now },
  });
  return ids;
}
