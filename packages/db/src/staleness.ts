import type { Db } from './client.ts';

/** The part of a Migration filter callers may narrow by (all Migrations of the Route, or a few). */
export interface StaleScope {
  readonly routeId?: string;
  readonly routeIds?: readonly string[];
  readonly ids?: readonly string[];
  readonly sourceRepositoryIds?: readonly string[];
}

/**
 * Marks the Migrations that match `scope` as changed (LIF-021, ADR-0310), on the **database**
 * clock:
 *
 * - `staleGeneration` is incremented for every one of them, unconditionally, including those that
 *   are already stale or were never analyzed. An Analysis that started before the change sees a
 *   different generation when it is stored and stays stale.
 * - `analysisStaleAt` is set to now where the Migration has an Analysis and is not stale yet (null
 *   or a future expiry); an earlier stale instant is kept.
 * - The failure marker is lifted (`analysisFailedAt`, `analysisRetryAt`) so the feeder tries again
 *   at once; `analysisFailureCount` is kept, so the next failure resumes at its backoff step
 *   (ADR-0312).
 *
 * Rows are locked in id order, the same order the staleness triggers use (`mark_routes_stale`
 * takes `ORDER BY id FOR UPDATE` before it updates), so concurrent markers cannot deadlock with
 * each other or with a trigger. A caller that marks several scopes should pass them in one call
 * (`routeIds`, `ids`) so that one statement locks them all in a single id order. Returns the ids that were
 * newly marked stale. An empty `ids` or `sourceRepositoryIds` list matches nothing.
 */
export async function markAnalysesStale(
  db: Pick<Db, 'migration' | '$queryRaw'>,
  scope: StaleScope,
): Promise<string[]> {
  if (
    scope.ids?.length === 0 ||
    scope.sourceRepositoryIds?.length === 0 ||
    scope.routeIds?.length === 0
  ) {
    return [];
  }
  const rows = await db.migration.findMany({
    where: {
      ...(scope.routeId === undefined ? {} : { routeId: scope.routeId }),
      ...(scope.routeIds === undefined ? {} : { routeId: { in: [...scope.routeIds] } }),
      ...(scope.ids === undefined ? {} : { id: { in: [...scope.ids] } }),
      ...(scope.sourceRepositoryIds === undefined
        ? {}
        : { sourceRepositoryId: { in: [...scope.sourceRepositoryIds] } }),
    },
    select: { id: true },
  });
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id).sort();
  const marked = await db.$queryRaw<{ id: string; newly: boolean }[]>`
    WITH locked AS (
      SELECT id, latest_analysis_id, analysis_stale_at
        FROM app.migration
       WHERE id = ANY(${ids}::text[])
       ORDER BY id
         FOR UPDATE
    )
    UPDATE app.migration m
       SET stale_generation = m.stale_generation + 1,
           analysis_failed_at = NULL,
           analysis_retry_at = NULL,
           analysis_stale_at = CASE
             WHEN l.latest_analysis_id IS NOT NULL
                  AND (l.analysis_stale_at IS NULL OR l.analysis_stale_at > clock_timestamp())
             THEN clock_timestamp()
             ELSE l.analysis_stale_at
           END
      FROM locked l
     WHERE m.id = l.id
    RETURNING m.id AS id,
              (l.latest_analysis_id IS NOT NULL
               AND (l.analysis_stale_at IS NULL OR l.analysis_stale_at > clock_timestamp())) AS newly`;
  return marked.filter((m) => m.newly).map((m) => m.id);
}
