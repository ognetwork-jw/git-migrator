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
 * Log lines after `afterId` (ids are UUIDv7, so id order is time order), oldest first, up to
 * {@link LOG_PAGE}. Live updates fetch only what is new.
 */
export const fetchLogAfter = (runId: string, afterId: string | undefined) =>
  findMany<RunLogRow>('runLog', {
    where: { runId, ...(afterId ? { id: { gt: afterId } } : {}) },
    orderBy: { id: 'asc' },
    take: LOG_PAGE,
    select: { id: true, stepId: true, ts: true, level: true, message: true },
  });
