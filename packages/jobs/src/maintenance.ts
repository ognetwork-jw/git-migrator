import type { Logger } from '@git-migrator/observability';
import type pg from 'pg';
import { type ReaperMetrics, reapRuns } from './reaper.ts';
import { applyRetention, type RetentionResult } from './retention.ts';
import type { JobHandlers, JobRuntime } from './runtime.ts';
import { cleanScratch } from './scratch.ts';

/** Raw responses and Snapshot and Analysis retention run once per hour (JOB-046). */
export const RETENTION_INTERVAL_MS = 60 * 60 * 1000;

/** The part of `QuotaService` that `maintenance.prune` uses (JOB-046). */
export interface QuotaPruner {
  prune(): Promise<{ events: number; leases: number }>;
}

export interface MaintenanceDeps {
  /** The application pool (`DbHandle.pool`). */
  readonly appPool: pg.Pool;
  readonly quota: QuotaPruner;
  readonly runtime: JobRuntime;
  readonly log: Logger;
  readonly scratchRoot: string;
  readonly metrics?: ReaperMetrics;
  /** Test seam. */
  readonly now?: () => number;
  readonly retentionIntervalMs?: number;
}

export interface PruneResult {
  readonly events: number;
  readonly leases: number;
  readonly retention?: RetentionResult;
}

/**
 * `maintenance.prune` (JOB-046, DATA-020): every run prunes the quota ledger and expired leases;
 * the retention pass (raw responses, Snapshots, Analyses) runs when the last one in this process is
 * an hour old. Every statement is idempotent, so two pods doing the hourly pass is only redundant.
 */
export function createPruner(deps: MaintenanceDeps): () => Promise<PruneResult> {
  const interval = deps.retentionIntervalMs ?? RETENTION_INTERVAL_MS;
  const now = deps.now ?? Date.now;
  let lastRetention: number | undefined;
  return async () => {
    const pruned = await deps.quota.prune();
    if (lastRetention !== undefined && now() - lastRetention < interval) return pruned;
    const retention = await applyRetention(deps.appPool);
    lastRetention = now();
    deps.log.info({ ...pruned, ...retention }, 'pruned');
    return { ...pruned, retention };
  };
}

/** Scheduler-driven jobs whose processors arrive with later tasks (ADR-0212). */
const PENDING: ReadonlyArray<readonly [name: PendingJob, task: string]> = [
  ['analysis.feeder', 'T-061'],
  ['drift.sweep', 'T-089'],
  ['parity.migration', 'T-072'],
];
type PendingJob = 'analysis.feeder' | 'drift.sweep' | 'parity.migration';

/**
 * The handlers this module provides: `maintenance.prune`, `maintenance.scratch-cleanup` and
 * `maintenance.run-reaper`. Scheduler-driven jobs whose processors belong to later tasks complete
 * as skipped with a warning, so the schedulers (JOB-050) do not fill the failed set every minute.
 */
export function maintenanceHandlers(deps: MaintenanceDeps): JobHandlers {
  const prune = createPruner(deps);
  const pending = Object.fromEntries(
    PENDING.map(([name, task]) => [
      name,
      async () => {
        deps.log.warn({ job: name, task }, 'no processor yet; job skipped');
        return { skipped: true };
      },
    ]),
  ) as JobHandlers;
  return {
    ...pending,
    'maintenance.prune': () => prune(),
    'maintenance.scratch-cleanup': async () => ({
      removed: await cleanScratch({ root: deps.scratchRoot, log: deps.log }),
    }),
    'maintenance.run-reaper': () =>
      reapRuns({
        pool: deps.appPool,
        runs: deps.runtime,
        log: deps.log,
        ...(deps.metrics ? { metrics: deps.metrics } : {}),
      }),
  };
}
