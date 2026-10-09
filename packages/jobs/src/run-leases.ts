import { randomBytes } from 'node:crypto';
import type { Logger } from '@git-migrator/observability';
import type pg from 'pg';
import type { RunRouting } from './queues.ts';

/** A Run's lease is renewed every 30 s and valid for 2 min (LIF-046). */
export const RUN_LEASE_RENEW_MS = 30_000;
export const RUN_LEASE_TTL_SECONDS = 120;

/**
 * A holder gives up locally when no renewal has succeeded for this long, whatever the error: the
 * database cannot confirm the lease, so another worker may already have it (ADR-0212). 30 s under
 * the TTL covers one missed tick and the clock difference between pod and database.
 */
export const RUN_LEASE_LOCAL_LIMIT_MS = 90_000;

/**
 * Prefix of the `lease_owner` marker the reaper writes when it resumes a Run, until the resumed job
 * claims the lease. A claim over it counts as one reaper resumption (LIF-046, ADR-0212).
 */
export const RESUME_PENDING_OWNER = 'reaper:resume-pending';

/**
 * Prefix of the `lease_owner` marker for a Run that waits for its next job without a failure,
 * after a SIGTERM hand-off. A claim over it counts nothing (ADR-0212).
 */
export const HANDOFF_PENDING_OWNER = 'handoff-pending';

export type PendingMarkerKind = 'resume' | 'handoff';

/**
 * The `lease_owner` value of a pending marker: the prefix, then the deduplication id of the job the
 * Run waits for, so the reaper can tell a job that still waits from one that died (ADR-0212).
 */
export function pendingMarker(kind: PendingMarkerKind, dedupeId: string): string {
  return `${kind === 'resume' ? RESUME_PENDING_OWNER : HANDOFF_PENDING_OWNER}:${dedupeId}`;
}

/**
 * Reads a pending marker. Undefined for a real lease token or no owner; `dedupeId` is undefined
 * for a bare prefix, whose job cannot be looked up.
 */
export function parsePendingMarker(
  owner: string | null,
): { readonly kind: PendingMarkerKind; readonly dedupeId: string | undefined } | undefined {
  if (owner === null) return undefined;
  for (const [kind, prefix] of [
    ['resume', RESUME_PENDING_OWNER],
    ['handoff', HANDOFF_PENDING_OWNER],
  ] as const) {
    if (owner === prefix) return { kind, dedupeId: undefined };
    if (owner.startsWith(`${prefix}:`)) return { kind, dedupeId: owner.slice(prefix.length + 1) };
  }
  return undefined;
}

/** A fresh lease token for one claim: never reused, so a restarted pod cannot re-enter a lease. */
export function newLeaseToken(workerId: string, jobId: string | number | undefined): string {
  return `${workerId}:${jobId ?? 'job'}:${randomBytes(6).toString('hex')}`;
}

/**
 * Claims the lease on a `running` Run: allowed when nobody holds it, a pending marker (resume or
 * hand-off) is on it, or the holder's lease expired. It is never re-entrant: the same token (or the same worker
 * under another token) cannot claim twice, so two jobs never hold one Run. Taking over a lease that
 * was held (the resume marker, or an expired real lease) counts as a reaper resumption; the first
 * claim and a claim over the hand-off marker do not. The expiry is computed by the database clock (ADR-0180). True when the caller now holds it.
 */
export async function claimRunLease(pool: pg.Pool, runId: string, token: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE app.run
     SET lease_owner = $2, lease_expires_at = clock_timestamp() + make_interval(secs => $3),
         reaper_resumes = reaper_resumes
           + CASE WHEN lease_owner IS NULL OR lease_owner = $5 OR starts_with(lease_owner, $5 || ':')
                  THEN 0 ELSE 1 END
     WHERE id = $1 AND status = 'running'
       AND (lease_owner IS NULL OR lease_owner IN ($4, $5)
            OR starts_with(lease_owner, $4 || ':') OR starts_with(lease_owner, $5 || ':')
            OR lease_expires_at IS NULL OR lease_expires_at < clock_timestamp())`,
    [runId, token, RUN_LEASE_TTL_SECONDS, RESUME_PENDING_OWNER, HANDOFF_PENDING_OWNER],
  );
  return (result.rowCount ?? 0) === 1;
}

/**
 * Starts a `queued` Run: the first job of a Run moves it to `running` and takes the lease in one
 * statement, so two jobs cannot both start it, and a cancelled Run is never started (LIF-040,
 * ADR-0340). True when the caller now holds the lease.
 */
export async function startQueuedRun(
  pool: pg.Pool,
  runId: string,
  token: string,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE app.run
     SET status = 'running', started_at = clock_timestamp(), updated_at = clock_timestamp(),
         lease_owner = $2, lease_expires_at = clock_timestamp() + make_interval(secs => $3)
     WHERE id = $1 AND status = 'queued' AND cancel_requested_at IS NULL`,
    [runId, token, RUN_LEASE_TTL_SECONDS],
  );
  return (result.rowCount ?? 0) === 1;
}

/** Extends the lease while `token` still holds it. False means the lease was lost. */
export async function renewRunLease(pool: pg.Pool, runId: string, token: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE app.run
     SET lease_expires_at = clock_timestamp() + make_interval(secs => $3)
     WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
    [runId, token, RUN_LEASE_TTL_SECONDS],
  );
  return (result.rowCount ?? 0) === 1;
}

/** Releases the lease if `token` holds it (the Run finished). */
export async function releaseRunLease(
  pool: pg.Pool,
  runId: string,
  token: string,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE app.run SET lease_owner = NULL, lease_expires_at = NULL
     WHERE id = $1 AND lease_owner = $2`,
    [runId, token],
  );
  return (result.rowCount ?? 0) === 1;
}

export interface RunLeaseHandle {
  /** The unique token that owns the lease. */
  readonly token: string;
  /**
   * Aborted when a renewal finds the lease gone, or when no renewal succeeded within
   * `RUN_LEASE_LOCAL_LIMIT_MS`: stop work without writing.
   */
  readonly lost: AbortSignal;
  /** Stops renewing and releases the lease. */
  release(): Promise<void>;
  /** Stops renewing without touching the row (after `handOffRun`). */
  stop(): void;
}

export interface KeepRunLeaseOptions {
  readonly pool: pg.Pool;
  readonly runId: string;
  /** Worker id, for diagnostics; the lease token adds the job id and a random part. */
  readonly workerId: string;
  readonly jobId?: string | number | undefined;
  /** Also start a `queued` Run (the first job of a Run), not only resume a `running` one. */
  readonly startQueued?: boolean;
  readonly log?: Logger;
  readonly renewMs?: number;
  readonly localLimitMs?: number;
  /** Test seam. */
  readonly now?: () => number;
}

/**
 * Claims the lease under a fresh token and renews it every 30 s until `release()` (LIF-046).
 * Resolves to undefined when the Run is not claimable (another job holds a live lease, or it is
 * not `running`): the job must not process the Run. `lost` aborts when a renewal reports the row is
 * no longer ours, and also when no renewal succeeded within the local limit, so a pod cut off from
 * the database stops executing before the reaper's resume can run elsewhere.
 */
export async function keepRunLease(
  options: KeepRunLeaseOptions,
): Promise<RunLeaseHandle | undefined> {
  const { pool, runId, log } = options;
  const token = newLeaseToken(options.workerId, options.jobId);
  const now = options.now ?? Date.now;
  const limit = options.localLimitMs ?? RUN_LEASE_LOCAL_LIMIT_MS;
  const claimSentAt = now();
  const claimed =
    (options.startQueued === true && (await startQueuedRun(pool, runId, token))) ||
    (await claimRunLease(pool, runId, token));
  if (!claimed) return undefined;
  const lost = new AbortController();
  let watchdog: NodeJS.Timeout | undefined;
  const giveUp = (): void => {
    lost.abort();
    clearInterval(timer);
    clearTimeout(watchdog);
  };
  // The holder gives up `limit` after the last renewal that *succeeded* was sent, however the
  // renewals fail or hang: a dedicated timer, not a check inside the 30 s tick (ADR-0212).
  const arm = (sentAt: number): void => {
    clearTimeout(watchdog);
    watchdog = setTimeout(giveUp, Math.max(0, limit - (now() - sentAt)));
    watchdog.unref();
  };
  arm(claimSentAt);
  // Renewals can answer out of order (a slow one after a fast one): only a later send moves the
  // deadline, never an earlier one.
  let lastSuccessSentAt = claimSentAt;
  const timer = setInterval(() => {
    const sentAt = now();
    renewRunLease(pool, runId, token).then(
      (held) => {
        if (!held) giveUp();
        else if (sentAt > lastSuccessSentAt && !lost.signal.aborted) {
          lastSuccessSentAt = sentAt;
          arm(sentAt);
        }
      },
      (error: unknown) => log?.warn({ err: error, runId }, 'run lease renewal failed'),
    );
  }, options.renewMs ?? RUN_LEASE_RENEW_MS);
  timer.unref();
  return {
    token,
    lost: lost.signal,
    stop: () => {
      clearInterval(timer);
      clearTimeout(watchdog);
    },
    release: async () => {
      clearInterval(timer);
      clearTimeout(watchdog);
      await releaseRunLease(pool, runId, token);
    },
  };
}

export interface RunEnqueuerLike {
  enqueueRun(
    runId: string,
    routing: RunRouting,
    options?: { dedupeId?: string; delayMs?: number },
  ): Promise<unknown>;
}

/**
 * The SIGTERM hand-off (LIF-046): the worker finished its current step and gives the Run back. It
 * releases the lease with a grace period (hand-off marker, expiry TTL ahead), so the reaper leaves
 * the Run alone and no resumption is counted, then enqueues `run.execute` under a distinct
 * deduplication id (`run-<id>:handoff-<token>`), because the current job still exists and the plain
 * `run-<id>` id would drop the enqueue. Returns false, and enqueues nothing, when the token no
 * longer owns the lease: the reaper has the Run.
 */
export async function handOffRun(options: {
  readonly pool: pg.Pool;
  readonly runs: RunEnqueuerLike;
  readonly runId: string;
  readonly token: string;
  readonly routing: RunRouting;
  /** Delay of the next job (rate limit, scratch space); the lease marker waits for it (ADR-0212). */
  readonly delayMs?: number;
}): Promise<boolean> {
  // The old token is unique per claim, so the id is stable if this is retried and distinct from
  // the id of any earlier hand-off of the same Run. The marker carries it for the reaper.
  const dedupeId = `run-${options.runId}:handoff-${options.token}`;
  const released = await options.pool.query(
    `UPDATE app.run
     SET lease_owner = $4,
         lease_expires_at = clock_timestamp() + make_interval(secs => $3)
     WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
    [options.runId, options.token, RUN_LEASE_TTL_SECONDS, pendingMarker('handoff', dedupeId)],
  );
  if ((released.rowCount ?? 0) !== 1) return false;
  await options.runs.enqueueRun(options.runId, options.routing, {
    dedupeId,
    ...(options.delayMs !== undefined && options.delayMs > 0 ? { delayMs: options.delayMs } : {}),
  });
  return true;
}
