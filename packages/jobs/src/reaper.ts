import type { Logger } from '@git-migrator/observability';
import type pg from 'pg';
import type { RunRouting } from './queues.ts';
import { parsePendingMarker, pendingMarker, RUN_LEASE_TTL_SECONDS } from './run-leases.ts';

/** After 3 reaper resumptions of one Run, the next expiry marks it failed (LIF-046). */
export const MAX_REAPER_RESUMES = 3;

/** The Run error code when the reaper gives up (LIF-046). */
export const RUN_ABANDONED = 'run.abandoned';

export interface RunEnqueuer {
  enqueueRun(runId: string, routing: RunRouting, options?: { dedupeId?: string }): Promise<unknown>;
  /**
   * Whether the Run job enqueued under `dedupeId` still exists and can still run (waiting,
   * delayed, prioritized or active). False when it is missing, failed or completed.
   */
  isRunJobPending(dedupeId: string): Promise<boolean>;
}

export interface ReaperMetrics {
  recordRun(kind: string, status: string, durationSeconds: number): void;
}

export interface ReaperOptions {
  readonly pool: pg.Pool;
  readonly runs: RunEnqueuer;
  readonly log: Logger;
  readonly metrics?: ReaperMetrics;
}

export interface ReaperResult {
  /** Run ids re-enqueued. */
  readonly resumed: readonly string[];
  /** Run ids marked failed with `run.abandoned`. */
  readonly abandoned: readonly string[];
}

interface ExpiredRun {
  id: string;
  kind: string;
  reaper_resumes: number;
  lease_owner: string | null;
  scope: 'repository' | 'endpoint';
  size_class: 'standard' | 'large';
  seconds: number | null;
}

/**
 * `maintenance.run-reaper` (LIF-046): finds Runs that are `running` while their lease expired
 * (a Run that never got a lease counts from its last update) and re-enqueues `run.execute`. Steps
 * are idempotent, so the Run resumes at the first non-succeeded step.
 *
 * A Run whose lease expired is in one of two situations (ADR-0212):
 * - A real lease token expired: the holder died. The reaper writes a resume marker
 *   (`reaper:resume-pending:<dedupe id>`) and a fresh lease period, and enqueues under the stable id
 *   `run-<id>:resume-<n>`. The resumption is counted when that job claims the lease.
 * - A pending marker (resume or hand-off) or no owner at all: the Run waits for a job. The reaper
 *   looks the job up by its deduplication id. While it waits or runs, the reaper only extends the
 *   period, so a backlogged queue neither counts nor duplicates anything. If the job is missing,
 *   failed or completed without claiming, the wait is over: a dead resume job counts as the
 *   resumption it was, and a dead hand-off or first job becomes a counted resume.
 *
 * After 3 resumptions, the next expiry of a real lease, or the next dead pending job, marks the Run
 * `failed` with error `run.abandoned`. Each Run is handled in its own transaction under
 * `FOR UPDATE SKIP LOCKED`, so two reapers never resume one Run twice.
 */
export async function reapRuns(options: ReaperOptions): Promise<ReaperResult> {
  const resumed: string[] = [];
  const abandoned: string[] = [];
  const expired = await options.pool.query<{ id: string }>(
    `SELECT id FROM app.run
     WHERE status = 'running'
       AND coalesce(lease_expires_at, updated_at + make_interval(secs => $1)) < clock_timestamp()
     ORDER BY created_at`,
    [RUN_LEASE_TTL_SECONDS],
  );
  for (const { id } of expired.rows) {
    const outcome = await reapOne(options, id);
    if (outcome?.action === 'resume') resumed.push(id);
    if (outcome?.action === 'abandon') abandoned.push(id);
  }
  return { resumed, abandoned };
}

type Outcome =
  | { action: 'resume'; routing: RunRouting; resumes: number; dedupeId: string }
  | { action: 'wait' }
  | { action: 'abandon' };

/** The deduplication id of the job a Run without a real lease waits for, if it can be known. */
function awaitedJob(runId: string, leaseOwner: string | null): string | undefined {
  // The first job of a Run is enqueued under the default id (`enqueueRun`).
  if (leaseOwner === null) return `run-${runId}`;
  return parsePendingMarker(leaseOwner)?.dedupeId;
}

async function reapOne(options: ReaperOptions, runId: string): Promise<Outcome | undefined> {
  const client = await options.pool.connect();
  let outcome: Outcome | undefined;
  try {
    await client.query('BEGIN');
    const found = await client.query<ExpiredRun>(
      `SELECT r.id, r.kind, r.reaper_resumes, r.lease_owner, m.scope,
              coalesce(repo.size_class, 'standard') AS size_class,
              extract(epoch FROM clock_timestamp() - r.started_at)::float8 AS seconds
       FROM app.run r
       JOIN app.migration m ON m.id = r.migration_id
       LEFT JOIN app.repository repo ON repo.id = m.source_repository_id
       WHERE r.id = $2 AND r.status = 'running'
         AND coalesce(r.lease_expires_at, r.updated_at + make_interval(secs => $1))
             < clock_timestamp()
       FOR UPDATE OF r SKIP LOCKED`,
      [RUN_LEASE_TTL_SECONDS, runId],
    );
    const run = found.rows[0];
    if (!run) {
      await client.query('ROLLBACK');
      return undefined;
    }
    const marker = parsePendingMarker(run.lease_owner);
    const realLease = run.lease_owner !== null && marker === undefined;
    let resumes = run.reaper_resumes;
    // After 3 resumptions, the next expiry of a real lease or the next dead job ends the Run.
    const abandon = resumes >= MAX_REAPER_RESUMES;
    if (!realLease) {
      const dedupeId = awaitedJob(runId, run.lease_owner);
      // A lookup that fails says nothing about the job: wait for the next pass.
      const pending =
        dedupeId === undefined
          ? false
          : await options.runs.isRunJobPending(dedupeId).catch((error: unknown) => {
              options.log.warn({ err: error, runId }, 'run reaper could not look up a Run job');
              return true;
            });
      if (pending) {
        await client.query(
          `UPDATE app.run SET lease_expires_at = clock_timestamp() + make_interval(secs => $2)
           WHERE id = $1`,
          [runId, RUN_LEASE_TTL_SECONDS],
        );
        await client.query('COMMIT');
        return { action: 'wait' };
      }
      // The awaited job died without claiming. A resume job was a resumption: count it now, as its
      // claim never will. A dead hand-off or first job becomes a resume, counted when claimed.
      if (marker?.kind === 'resume' && !abandon) resumes += 1;
    }
    if (abandon) {
      await client.query(
        `UPDATE app.run
         SET status = 'failed', finished_at = clock_timestamp(), lease_owner = NULL,
             lease_expires_at = NULL, reaper_resumes = $3, error = $2::jsonb
         WHERE id = $1`,
        [runId, JSON.stringify({ code: RUN_ABANDONED, resumes }), resumes],
      );
      outcome = { action: 'abandon' };
      options.metrics?.recordRun(run.kind, 'failed', run.seconds ?? 0);
    } else {
      // Stable per resumption number: later passes and a second reaper find the same job.
      const dedupeId = `run-${runId}:resume-${resumes + 1}`;
      await client.query(
        `UPDATE app.run
         SET lease_owner = $3, reaper_resumes = $4,
             lease_expires_at = clock_timestamp() + make_interval(secs => $2)
         WHERE id = $1`,
        [runId, RUN_LEASE_TTL_SECONDS, pendingMarker('resume', dedupeId), resumes],
      );
      outcome = {
        action: 'resume',
        resumes: resumes + 1, // the number this resumption will have once claimed
        dedupeId,
        routing: { kind: run.kind, scope: run.scope, sizeClass: run.size_class },
      };
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    options.log.error({ err: error, runId }, 'run reaper failed for a Run');
    return undefined;
  } finally {
    client.release();
  }
  if (!outcome) return undefined;
  if (outcome.action === 'abandon') {
    options.log.warn({ runId }, 'Run abandoned after repeated lease expiry');
    return outcome;
  }
  try {
    // A fresh dedupe id per resumption: the dead worker's job may still exist, and a plain
    // `run-<id>` id would then drop this enqueue (JOB-011).
    await options.runs.enqueueRun(runId, outcome.routing, { dedupeId: outcome.dedupeId });
    options.log.info({ runId, resumes: outcome.resumes }, 'Run resumed by the reaper');
  } catch (error) {
    options.log.error({ err: error, runId }, 'run reaper could not re-enqueue a Run');
  }
  return outcome;
}
