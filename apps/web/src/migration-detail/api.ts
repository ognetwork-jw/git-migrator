import { apiRequest } from '../api/http.ts';
import { findMany, updateRow } from '../model/rpc.ts';

/**
 * Data and actions of the repository detail page (UI-022). Reads go through the Model API (the
 * server applies the policies) and the diff endpoint; every action is a custom endpoint of API-020
 * (ADR-0415), except the Wave and the task note, which are the two RPC writes API-012 allows.
 */

export type PlanKind = 'step' | 'blocker' | 'pre_task' | 'post_task' | 'warning';

export interface PlanItemRow {
  readonly id: string;
  readonly facetKey: string;
  readonly kind: PlanKind;
  readonly code: string;
  readonly fieldPaths: readonly string[];
  readonly params: unknown;
  readonly order: number;
}

export interface MigrationDetail {
  readonly id: string;
  readonly scope: 'repository' | 'endpoint';
  readonly status: string;
  readonly readiness: string | null;
  readonly readinessCounts: {
    readonly blockers?: number;
    readonly preTasks?: number;
    readonly postTasks?: number;
    readonly warnings?: number;
  } | null;
  readonly plannedTargetName: string | null;
  readonly blockerCodes: readonly string[];
  /** Run-origin blockers (LIF-049): `[{code, params, at}]`. */
  readonly runBlockers: unknown;
  readonly waveId: string | null;
  readonly targetCreatedByFramework: boolean;
  readonly sourceReadOnlyApplied: boolean;
  readonly analysisStaleAt: string | null;
  readonly verifiedAt: string | null;
  readonly lastParityAt: string | null;
  readonly manualCompletion: {
    readonly actorId: string;
    readonly reason: string;
    readonly at: string;
  } | null;
  readonly route: {
    readonly id: string;
    readonly targetNamespacePath: string;
    readonly sourceEndpoint: { readonly displayName: string };
    readonly targetEndpoint: { readonly displayName: string };
  };
  readonly sourceRepository: { readonly id: string; readonly fullPath: string } | null;
  readonly targetRepository: { readonly id: string; readonly fullPath: string } | null;
  readonly wave: { readonly id: string; readonly name: string } | null;
  readonly latestAnalysis: {
    readonly id: string;
    readonly createdAt: string;
    readonly items: readonly PlanItemRow[];
  } | null;
}

export interface TaskRow {
  readonly id: string;
  readonly facetKey: string;
  readonly code: string;
  readonly phase: 'pre' | 'post';
  readonly origin: 'analysis' | 'run';
  readonly params: unknown;
  readonly verifiable: boolean;
  readonly status: 'open' | 'done' | 'dismissed';
  readonly note: string | null;
  readonly completedAt: string | null;
  readonly completedBy: { readonly displayName: string } | null;
  readonly sourcePlanItem: { readonly fieldPaths: readonly string[] } | null;
}

export interface RunSummaryRow {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly hasMutations: boolean;
  readonly triggeredBy: { readonly displayName: string } | null;
}

export interface MigrationAuditRow {
  readonly id: string;
  readonly action: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly data: unknown;
  readonly at: string;
  readonly actor: { readonly displayName: string } | null;
}

export interface FidelityDecision {
  readonly path: string;
  readonly fidelity: string;
  readonly accepted?: 'policy' | 'migration' | false;
  readonly policyKey?: string;
  readonly note?: string;
}

export interface ParityDiff {
  readonly path: string;
  readonly source: unknown;
  readonly target: unknown;
}

export interface DiffFacet {
  readonly facetKey: string;
  readonly source: unknown;
  readonly desired: unknown;
  readonly target: unknown;
  readonly sourceUnreadable: readonly string[];
  readonly targetUnreadable: readonly string[];
  readonly sourceFetchedAt: string | null;
  readonly targetFetchedAt: string | null;
  readonly decisions: unknown;
  readonly overridden: boolean | null;
  readonly parity: {
    readonly status: string;
    readonly checkedAt: string;
    readonly diffs: readonly ParityDiff[];
    readonly excluded: readonly { readonly path: string; readonly expectedDifferenceId: string }[];
  } | null;
  readonly expectedDifferences: readonly {
    readonly id: string;
    readonly path: string;
    readonly reason: string;
    readonly note: string | null;
    readonly migrationId: string | null;
  }[];
}

export interface MigrationDiff {
  readonly migrationId: string;
  readonly analysisId: string | null;
  readonly analyzedAt: string | null;
  readonly facets: readonly DiffFacet[];
}

const enc = encodeURIComponent;

/**
 * Query keys. All of a page's keys start with `migration-detail` and the Migration id, so one live
 * invalidation of that prefix refreshes every tab (JOB-060).
 */
export const detailRootKey = (id: string) => ['migration-detail', id] as const;
export const detailKey = (id: string) => [...detailRootKey(id), 'header'] as const;
export const tasksKey = (id: string) => [...detailRootKey(id), 'tasks'] as const;
export const runsKey = (id: string) => [...detailRootKey(id), 'runs'] as const;
export const diffKey = (id: string) => [...detailRootKey(id), 'diff'] as const;
export const auditKey = (id: string) => [...detailRootKey(id), 'audit'] as const;
export const wavesChoiceKey = ['migration-detail-waves'] as const;

/** Most tasks, Runs and audit events a tab loads. */
export const TAB_LIMIT = 200;

export const fetchMigration = async (id: string): Promise<MigrationDetail | null> =>
  (
    await findMany<MigrationDetail>('migration', {
      where: { id },
      take: 1,
      select: {
        id: true,
        scope: true,
        status: true,
        readiness: true,
        readinessCounts: true,
        plannedTargetName: true,
        blockerCodes: true,
        runBlockers: true,
        waveId: true,
        targetCreatedByFramework: true,
        sourceReadOnlyApplied: true,
        analysisStaleAt: true,
        verifiedAt: true,
        lastParityAt: true,
        manualCompletion: true,
        route: {
          select: {
            id: true,
            targetNamespacePath: true,
            sourceEndpoint: { select: { displayName: true } },
            targetEndpoint: { select: { displayName: true } },
          },
        },
        sourceRepository: { select: { id: true, fullPath: true } },
        targetRepository: { select: { id: true, fullPath: true } },
        wave: { select: { id: true, name: true } },
        latestAnalysis: {
          select: {
            id: true,
            createdAt: true,
            items: {
              orderBy: { order: 'asc' },
              select: {
                id: true,
                facetKey: true,
                kind: true,
                code: true,
                fieldPaths: true,
                params: true,
                order: true,
              },
            },
          },
        },
      },
    })
  )[0] ?? null;

export const fetchTasks = (id: string) =>
  findMany<TaskRow>('manualTask', {
    where: { migrationId: id },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: TAB_LIMIT,
    select: {
      id: true,
      facetKey: true,
      code: true,
      phase: true,
      origin: true,
      params: true,
      verifiable: true,
      status: true,
      note: true,
      completedAt: true,
      completedBy: { select: { displayName: true } },
      sourcePlanItem: { select: { fieldPaths: true } },
    },
  });

export const fetchRuns = (id: string) =>
  findMany<RunSummaryRow>('run', {
    where: { migrationId: id },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: TAB_LIMIT,
    select: {
      id: true,
      kind: true,
      status: true,
      createdAt: true,
      startedAt: true,
      finishedAt: true,
      hasMutations: true,
      triggeredBy: { select: { displayName: true } },
    },
  });

/** Audit events about the Migration, its tasks, Runs and Expected Differences (AUTH-022). */
export const fetchMigrationAudit = (id: string) =>
  findMany<MigrationAuditRow>('auditEvent', {
    where: {
      OR: [
        { subjectType: 'migration', subjectId: id },
        { data: { path: ['migrationId'], equals: id } },
      ],
    },
    orderBy: [{ at: 'desc' }, { id: 'desc' }],
    take: TAB_LIMIT,
    select: {
      id: true,
      action: true,
      subjectType: true,
      subjectId: true,
      data: true,
      at: true,
      actor: { select: { displayName: true } },
    },
  });

export const fetchWaveChoices = () =>
  findMany<{ id: string; name: string }>('wave', {
    orderBy: { name: 'asc' },
    take: 200,
    select: { id: true, name: true },
  });

/** `GET /migrations/{id}/diff`: Snapshots, desired state and the latest ParityResult per Facet. */
export const fetchDiff = (id: string) =>
  apiRequest<MigrationDiff>(`/api/v1/migrations/${enc(id)}/diff`);

// -- Actions (API-020) ----------------------------------------------------------------------------

export type DetailRunKind =
  | 'migrate'
  | 'run_anyway'
  | 'resync'
  | 'verify'
  | 'rollback'
  | 'source_read_only'
  | 'undo_source_read_only';

export interface RunRequest {
  readonly kind: DetailRunKind;
  readonly options?: { readonly adoptNonEmpty?: boolean; readonly skipSourceReadOnly?: boolean };
  /** The typed target full name (LIF-043, LIF-077). */
  readonly confirm?: string;
}

/** `POST /migrations/{id}/runs`. */
export const startRun = (id: string, request: RunRequest) =>
  apiRequest<{ runId: string }>(`/api/v1/migrations/${enc(id)}/runs`, {
    method: 'POST',
    json: request,
  });

/** `POST /migrations/{id}/analyze`. */
export const analyze = (id: string) =>
  apiRequest<unknown>(`/api/v1/migrations/${enc(id)}/analyze`, { method: 'POST' });

/** `POST /runs/{id}/cancel`: `cancelled` now, or `requested` of the executor. */
export const cancelRun = (runId: string) =>
  apiRequest<{ runId: string; outcome: 'cancelled' | 'requested' }>(
    `/api/v1/runs/${enc(runId)}/cancel`,
    { method: 'POST' },
  );

/** `POST /migrations/{id}/complete` (LIF-075). */
export const markComplete = (id: string, reason: string) =>
  apiRequest<unknown>(`/api/v1/migrations/${enc(id)}/complete`, {
    method: 'POST',
    json: { reason },
  });

/** `DELETE /migrations/{id}/complete`. */
export const revokeComplete = (id: string) =>
  apiRequest<unknown>(`/api/v1/migrations/${enc(id)}/complete`, { method: 'DELETE' });

export type TaskAction = 'done' | 'reopen' | 'dismiss';

/** `POST /migrations/{id}/tasks/{taskId}/{done|reopen|dismiss}` (LIF-006). */
export const taskAction = (id: string, taskId: string, action: TaskAction, note?: string) =>
  apiRequest<unknown>(`/api/v1/migrations/${enc(id)}/tasks/${enc(taskId)}/${action}`, {
    method: 'POST',
    json: note === undefined || note.trim() === '' ? {} : { note: note.trim() },
  });

/** The one task field RPC may write (API-012): the free-text note. */
export const saveTaskNote = (taskId: string, note: string) =>
  updateRow('manualTask', { id: taskId }, { note: note.trim() === '' ? null : note.trim() });

/** `POST /migrations/{id}/expected-differences`: a `manual_accepted` difference. */
export const createExpectedDifference = (
  id: string,
  body: { readonly facetKey: string; readonly path: string; readonly note: string },
) =>
  apiRequest<unknown>(`/api/v1/migrations/${enc(id)}/expected-differences`, {
    method: 'POST',
    json: body,
  });

/** `DELETE /expected-differences/{id}`: revokes it. */
export const revokeExpectedDifference = (differenceId: string) =>
  apiRequest<unknown>(`/api/v1/expected-differences/${enc(differenceId)}`, { method: 'DELETE' });

/** The Wave of a Migration (`Migration.waveId`, the one Migration field RPC may write, API-012). */
export const setWave = (id: string, waveId: string | null) =>
  updateRow('migration', { id }, { waveId });
