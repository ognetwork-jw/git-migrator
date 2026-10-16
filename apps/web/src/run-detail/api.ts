import { findMany } from '../model/rpc.ts';

/** Data of the Run page (UI-023). Reads go through the Model API; Cancel is `cancelRun` of the detail API. */

export interface RunDetail {
  readonly id: string;
  readonly migrationId: string;
  readonly kind: string;
  readonly status: string;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly cancelRequestedAt: string | null;
  readonly hasMutations: boolean;
  readonly error: unknown;
  readonly triggeredBy: { readonly displayName: string } | null;
  readonly migration: {
    readonly id: string;
    readonly sourceRepository: { readonly fullPath: string } | null;
  };
}

export interface RunStepRow {
  readonly id: string;
  readonly stepKey: string;
  readonly facetKey: string | null;
  readonly order: number;
  readonly status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
  readonly attempts: number;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

export interface RunLogRow {
  readonly id: string;
  readonly stepId: string | null;
  readonly ts: string;
  readonly level: string;
  readonly message: string;
}

export interface MutationRow {
  readonly id: string;
  readonly side: string;
  readonly facetKey: string;
  readonly action: string;
  readonly paths: readonly string[];
  readonly undoneAt: string | null;
  readonly state: string;
  readonly createdAt: string;
}

/** Query keys: all start with `run-detail` and the Run id, so one live invalidation refreshes the page. */
export const runRootKey = (id: string) => ['run-detail', id] as const;
export const runKey = (id: string) => [...runRootKey(id), 'run'] as const;
export const stepsKey = (id: string) => [...runRootKey(id), 'steps'] as const;
export const mutationsKey = (id: string) => [...runRootKey(id), 'mutations'] as const;
export const logKey = (id: string) => [...runRootKey(id), 'log'] as const;

/** Rows per request when the log is fetched, and the most lines the page keeps. */
export const LOG_PAGE = 500;
export const LOG_MAX_LINES = 20_000;
/** Most Mutations listed (a Run records far fewer in practice). */
export const MUTATION_LIMIT = 500;

export const fetchRun = async (id: string): Promise<RunDetail | null> =>
  (
    await findMany<RunDetail>('run', {
      where: { id },
      take: 1,
      select: {
        id: true,
        migrationId: true,
        kind: true,
        status: true,
        createdAt: true,
        startedAt: true,
        finishedAt: true,
        cancelRequestedAt: true,
        hasMutations: true,
        error: true,
        triggeredBy: { select: { displayName: true } },
        migration: { select: { id: true, sourceRepository: { select: { fullPath: true } } } },
      },
    })
  )[0] ?? null;

export const fetchSteps = (runId: string) =>
  findMany<RunStepRow>('runStep', {
    where: { runId },
    orderBy: { order: 'asc' },
    take: 200,
    select: {
      id: true,
      stepKey: true,
      facetKey: true,
      order: true,
      status: true,
      attempts: true,
      startedAt: true,
      finishedAt: true,
    },
  });

export const fetchMutations = (runId: string) =>
  findMany<MutationRow>('mutation', {
    where: { runId },
    orderBy: { seq: 'asc' },
    take: MUTATION_LIMIT,
    select: {
      id: true,
      side: true,
      facetKey: true,
      action: true,
      paths: true,
      undoneAt: true,
      state: true,
      createdAt: true,
    },
  });

/**
 * Live updates re-read the lines of this window before the newest line the page has, and merge
 * them by id. Log ids are UUIDv7, made when a line is inserted, so a line whose transaction
 * commits after a later one has a smaller id than lines the page already read; a plain "after
 * the last id" cursor would skip it for good.
 */
export const LOG_OVERLAP_MS = 30_000;

/**
 * Log lines with an id above `afterId`, oldest first, up to {@link LOG_PAGE}. Ids are UUIDv7, so
 * id order is (insert) time order.
 */
export const fetchLogAfter = (runId: string, afterId: string | undefined) =>
  findMany<RunLogRow>('runLog', {
    where: { runId, ...(afterId ? { id: { gt: afterId } } : {}) },
    orderBy: { id: 'asc' },
    take: LOG_PAGE,
    select: { id: true, stepId: true, ts: true, level: true, message: true },
  });

/** Log lines with an id below `beforeId`, newest first, up to {@link LOG_PAGE}. */
export const fetchLogBefore = (runId: string, beforeId: string | undefined) =>
  findMany<RunLogRow>('runLog', {
    where: { runId, ...(beforeId ? { id: { lt: beforeId } } : {}) },
    orderBy: { id: 'desc' },
    take: LOG_PAGE,
    select: { id: true, stepId: true, ts: true, level: true, message: true },
  });

/**
 * The newest `max` lines of a Run's log, oldest first, read from the end, so a long log costs
 * `max / LOG_PAGE` requests and no copies of what is dropped. `truncated`: older lines exist.
 */
export async function fetchLogTail(
  runId: string,
  max: number,
): Promise<{ rows: RunLogRow[]; truncated: boolean }> {
  const pages: RunLogRow[][] = [];
  let count = 0;
  let before: string | undefined;
  for (;;) {
    const page = await fetchLogBefore(runId, before);
    pages.push(page);
    count += page.length;
    if (page.length < LOG_PAGE) return { rows: pages.flat().reverse(), truncated: false };
    if (count >= max) {
      const rows = pages.flat().reverse();
      return { rows: rows.slice(rows.length - max), truncated: true };
    }
    before = page[page.length - 1]?.id;
  }
}

/**
 * The smallest UUIDv7 of `windowMs` before the time encoded in `id`, as a cursor for
 * `fetchLogAfter`. `undefined` when `id` is not a UUIDv7 (the caller then reads after `id`).
 */
export function uuid7Floor(id: string, windowMs: number): string | undefined {
  const match = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-/i.exec(id);
  if (!match) return undefined;
  const ms = Number.parseInt(`${match[1]}${match[2]}`, 16) - windowMs;
  if (!Number.isFinite(ms) || ms <= 0) return '00000000-0000-0000-0000-000000000000';
  const hex = ms.toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-0000-0000-000000000000`;
}

/**
 * `rows` with `fetched` merged in by id, in id order. Both are in id order; `fetched` re-reads a
 * window at the end of `rows`, so only that end is rebuilt.
 */
export function mergeLog(
  rows: readonly RunLogRow[],
  fetched: readonly RunLogRow[],
): readonly RunLogRow[] {
  const first = fetched[0];
  if (first === undefined) return rows;
  // The first row of `rows` at or above the first fetched id (binary search).
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((rows[mid] as RunLogRow).id < first.id) lo = mid + 1;
    else hi = mid;
  }
  const byId = new Map<string, RunLogRow>();
  for (let i = lo; i < rows.length; i++) byId.set((rows[i] as RunLogRow).id, rows[i] as RunLogRow);
  for (const row of fetched) byId.set(row.id, row);
  const tail = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return lo === 0 ? tail : [...rows.slice(0, lo), ...tail];
}
