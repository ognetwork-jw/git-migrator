import type pg from 'pg';

/** Raw provider responses are kept 30 days (DATA-020). */
export const RAW_RESPONSE_RETENTION_DAYS = 30;
/** Facet Snapshots kept per (repository or endpoint, facet, side), plus protected ones (DATA-020). */
export const SNAPSHOTS_KEPT = 5;
/** Analyses kept per Migration, plus those a Run references (DATA-020). */
export const ANALYSES_KEPT = 10;

export interface RetentionResult {
  readonly rawResponses: number;
  readonly analyses: number;
  readonly snapshots: number;
}

export interface RetentionOptions {
  /** Test seam: runs after a ranked table's victims are chosen and before they are deleted. */
  readonly afterRanking?: (table: 'analysis' | 'facet_snapshot') => Promise<void>;
}

/** Rows deleted per statement, so a large backlog never holds one long transaction. */
export const RETENTION_BATCH = 1_000;

/** An Analysis is protected while a Run references it or it is a Migration's latest (DATA-020). */
const PROTECTED_ANALYSIS = `(EXISTS (SELECT 1 FROM app.run r WHERE r.analysis_id = a.id)
  OR EXISTS (SELECT 1 FROM app.migration m WHERE m.latest_analysis_id = a.id))`;

/**
 * Applies the retention table of DATA-020 that `maintenance.prune` owns (JOB-046):
 *
 * - `RawResponse`: older than 30 days.
 * - `Analysis` (with its `PlanItem`s, which cascade): all but the latest 10 per Migration, except
 *   any referenced by a Run and any that is a Migration's latest.
 * - `FacetSnapshot`: all but the latest 5 per (repository or endpoint, facet, side), except every
 *   Snapshot referenced by an Analysis that a Run references or that is a Migration's latest.
 *
 * Analyses go first, so the snapshot rule sees the surviving set. Everything else is kept
 * indefinitely. Idempotent, and each statement is a single delete that re-checks the rule, so a
 * concurrent pass or a reference added meanwhile is safe.
 */
export async function applyRetention(
  pool: pg.Pool,
  options: RetentionOptions = {},
): Promise<RetentionResult> {
  // Raw responses need no ranking: delete the next 1,000 old rows until none are left, so the
  // victims are never loaded into memory.
  let rawResponses = 0;
  for (;;) {
    const result = await pool.query(
      `DELETE FROM app.raw_response WHERE id IN (
         SELECT id FROM app.raw_response
         WHERE fetched_at < clock_timestamp() - make_interval(days => $1)
         LIMIT $2)`,
      [RAW_RESPONSE_RETENTION_DAYS, RETENTION_BATCH],
    );
    const count = result.rowCount ?? 0;
    rawResponses += count;
    if (count === 0) break;
  }
  const analyses = await deleteRanked(
    pool,
    'analysis',
    `SELECT a.id FROM (
       SELECT id, row_number() OVER (
         PARTITION BY migration_id ORDER BY created_at DESC, id DESC
       ) AS rank
       FROM app.analysis
     ) a
     WHERE a.rank > $1 AND NOT ${PROTECTED_ANALYSIS}`,
    [ANALYSES_KEPT],
    // Re-checked per chunk: a Run or a Migration may have started to reference it meanwhile.
    `DELETE FROM app.analysis a WHERE a.id = ANY($1::text[]) AND NOT ${PROTECTED_ANALYSIS}`,
    options,
  );
  const snapshots = await deleteRanked(
    pool,
    'facet_snapshot',
    `WITH protected AS (
       SELECT DISTINCT unnest(a.source_snapshot_ids || a.target_snapshot_ids) AS id
       FROM app.analysis a
       WHERE ${PROTECTED_ANALYSIS}
     )
     SELECT ranked.id FROM (
       SELECT id, row_number() OVER (
         PARTITION BY endpoint_id, repository_id, facet_key, side
         ORDER BY fetched_at DESC, id DESC
       ) AS rank
       FROM app.facet_snapshot
     ) ranked
     WHERE ranked.rank > $1 AND ranked.id NOT IN (SELECT id FROM protected)`,
    [SNAPSHOTS_KEPT],
    `DELETE FROM app.facet_snapshot s WHERE s.id = ANY($1::text[])
       AND NOT EXISTS (
         SELECT 1 FROM app.analysis a
         WHERE s.id = ANY(a.source_snapshot_ids || a.target_snapshot_ids) AND ${PROTECTED_ANALYSIS})`,
    options,
  );
  return { rawResponses, analyses, snapshots };
}

/**
 * Ranks the table once, then deletes the chosen ids in chunks of `RETENTION_BATCH`, each chunk its
 * own transaction, so progress survives an interruption. Each chunk's DELETE re-checks the
 * protection, so a row that became protected after the ranking stays. A row that vanished
 * meanwhile (a concurrent pass) is simply not counted.
 */
async function deleteRanked(
  pool: pg.Pool,
  table: 'analysis' | 'facet_snapshot',
  select: string,
  params: readonly unknown[],
  deleteChunk: string,
  options: RetentionOptions,
): Promise<number> {
  const victims = await pool.query<{ id: string }>(select, [...params]);
  const ids = victims.rows.map((row) => row.id);
  await options.afterRanking?.(table);
  let deleted = 0;
  for (let from = 0; from < ids.length; from += RETENTION_BATCH) {
    const result = await pool.query(deleteChunk, [ids.slice(from, from + RETENTION_BATCH)]);
    deleted += result.rowCount ?? 0;
  }
  return deleted;
}
