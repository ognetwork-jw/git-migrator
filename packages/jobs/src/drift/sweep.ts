/**
 * The `drift.sweep` job (LIF-065, JOB-050): on the drift schedule it enqueues one drift check per
 * eligible Migration, spread across the schedule's interval so a sweep of thousands never reaches
 * the providers at once. The check itself is the `parity.migration` job with `drift: true`
 * (`parity/run.ts`): it re-reads the target and the source `git-refs`, applies FAC-GIT-006
 * containment while the source is read-only, and moves a `verified` or `manually_completed`
 * Migration to `drifted` when differences remain. The sweep calls `enqueueParity` and never runs a
 * check itself (ADR-0396). Decisions: docs/adr/0466-drift-checks.md.
 */
import type { Db } from '@git-migrator/db';
import type { Logger } from '@git-migrator/observability';
import { CronExpressionParser } from 'cron-parser';
import type { JobHandlers, JobRuntime } from '../runtime.ts';

/** Statuses the sweep checks (LIF-065: "applies to `verified` and `manually_completed`"). */
export const DRIFT_SWEEP_STATUSES = ['verified', 'manually_completed'] as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
/** Migrations read from the database per page. */
const PAGE = 500;

export interface DriftSweepDeps {
  readonly db: Db;
  readonly runtime: Pick<JobRuntime, 'enqueueParity'>;
  /** `schedules.drift` (a cron expression, UTC): its interval is what the sweep spreads over. */
  readonly schedule: string;
  readonly log: Logger;
  readonly now?: () => Date;
  /** Migrations read per page (a test seam). */
  readonly pageSize?: number;
}

/** The time between two firings of `cron`, within one minute and one day (24 h if it cannot tell). */
export function scheduleIntervalMs(cron: string, from: Date = new Date()): number {
  try {
    const it = CronExpressionParser.parse(cron, { currentDate: from, tz: 'UTC' });
    const first = it.next().toDate().getTime();
    const second = it.next().toDate().getTime();
    return Math.min(DAY_MS, Math.max(MINUTE_MS, second - first));
  } catch {
    return DAY_MS;
  }
}

export interface DriftSweepResult {
  readonly eligible: number;
  readonly enqueued: number;
  /** Migrations whose enqueue failed (the next sweep tries again). */
  readonly failed: number;
  readonly intervalMs: number;
}

/**
 * Eligible: a repository Migration that is `verified` or `manually_completed`, with a target, on a
 * Route that is not retired and whose source is present. Every eligible Migration gets its own slot
 * in the interval (by id), so a failed enqueue costs only that Migration its check until the next
 * sweep.
 */
export async function runDriftSweep(deps: DriftSweepDeps): Promise<DriftSweepResult> {
  const where = {
    scope: 'repository' as const,
    status: { in: [...DRIFT_SWEEP_STATUSES] },
    targetRepositoryId: { not: null },
    route: { retiredAt: null },
    sourceRepository: { presence: 'present' as const },
  };
  const eligible = await deps.db.migration.count({ where });
  const intervalMs = scheduleIntervalMs(deps.schedule, deps.now?.() ?? new Date());
  // Spread over most of the interval: the last check ends before the next sweep starts.
  const spreadMs = Math.floor(intervalMs * 0.9);
  let enqueued = 0;
  let failed = 0;
  let index = 0;
  const pageSize = deps.pageSize ?? PAGE;
  for (let cursor: string | undefined; ; ) {
    const page = await deps.db.migration.findMany({
      where,
      orderBy: [{ id: 'asc' }],
      take: pageSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: { id: true },
    });
    if (page.length === 0) break;
    cursor = page[page.length - 1]?.id;
    for (const migration of page) {
      const delayMs = eligible <= 1 ? 0 : Math.floor((index * spreadMs) / eligible);
      index += 1;
      try {
        await deps.runtime.enqueueParity(migration.id, { drift: true, delayMs });
        enqueued += 1;
      } catch (error) {
        failed += 1;
        deps.log.warn({ migrationId: migration.id, err: error }, 'could not enqueue a drift check');
      }
    }
    if (page.length < pageSize) break;
  }
  deps.log.info({ eligible, enqueued, failed, intervalMs }, 'drift sweep');
  return { eligible, enqueued, failed, intervalMs };
}

/** The `drift.sweep` handler (JOB-050). */
export function driftHandlers(deps: DriftSweepDeps): JobHandlers {
  return { 'drift.sweep': () => runDriftSweep(deps) };
}
