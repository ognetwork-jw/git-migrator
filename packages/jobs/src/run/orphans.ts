/**
 * Runs that fell between the transactions of the Run lifecycle (LIF-046, ADR-0343):
 * - a `queued` Run whose `run.execute` job was never enqueued (the process died between the commit
 *   of `createRun` and the enqueue), which would block its Migration for ever (DOM-010);
 * - a Migration still `running` behind a Run the reaper abandoned (see `settleOrphanedMigrations`).
 * `maintenance.run-reaper` calls both after the reaper.
 */
import type { Logger } from '@git-migrator/observability';
import type pg from 'pg';
import type { RunRouting } from '../queues.ts';

/** A queued Run younger than this may still be on its way to the queue. */
export const QUEUED_GRACE_SECONDS = 120;

export interface QueuedRunEnqueuer {
  enqueueRun(runId: string, routing: RunRouting, options?: { dedupeId?: string }): Promise<unknown>;
  isRunJobPending(dedupeId: string): Promise<boolean>;
}

/** Re-enqueues `queued` Runs older than the grace period whose job is gone. Returns their ids. */
export async function requeueOrphanedQueuedRuns(
  pool: pg.Pool,
  runs: QueuedRunEnqueuer,
  log: Logger,
  graceSeconds = QUEUED_GRACE_SECONDS,
): Promise<string[]> {
  const found = await pool.query<{
    id: string;
    kind: string;
    scope: 'repository' | 'endpoint';
    size_class: 'standard' | 'large';
  }>(
    `SELECT r.id, r.kind, m.scope, coalesce(repo.size_class, 'standard') AS size_class
     FROM app.run r
     JOIN app.migration m ON m.id = r.migration_id
     LEFT JOIN app.repository repo ON repo.id = m.source_repository_id
     WHERE r.status = 'queued'
       AND r.created_at < clock_timestamp() - make_interval(secs => $1)
     ORDER BY r.created_at`,
    [graceSeconds],
  );
  const requeued: string[] = [];
  for (const row of found.rows) {
    try {
      // The list is a snapshot: a worker may have started or a user cancelled the Run since.
      const still = await pool.query("SELECT 1 FROM app.run WHERE id = $1 AND status = 'queued'", [
        row.id,
      ]);
      if (still.rowCount !== 1) continue;
      if (await runs.isRunJobPending(`run-${row.id}`)) continue;
      await runs.enqueueRun(
        row.id,
        { kind: row.kind, scope: row.scope, sizeClass: row.size_class },
        { dedupeId: `run-${row.id}` },
      );
      requeued.push(row.id);
    } catch (error) {
      log.warn({ err: error, runId: row.id }, 'could not re-enqueue a queued Run');
    }
  }
  return requeued;
}
