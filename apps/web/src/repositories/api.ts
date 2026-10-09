import { apiRequest } from '../api/http.ts';
import {
  buildFindMany,
  buildWhere,
  type MigrationStatus,
  type Readiness,
  type RepositoryFilters,
  type RepositorySort,
  type SizeClass,
} from './query.ts';

/** The finding kinds of a plan item (the Facet badge strip counts them). */
export type PlanItemKind = 'step' | 'blocker' | 'pre_task' | 'post_task' | 'warning';

export interface RepositoryRow {
  readonly id: string;
  readonly status: MigrationStatus;
  readonly readiness: Readiness | null;
  readonly readinessCounts: {
    readonly blockers?: number;
    readonly preTasks?: number;
    readonly postTasks?: number;
    readonly warnings?: number;
  } | null;
  readonly plannedTargetName: string | null;
  readonly blockerCodes: readonly string[];
  readonly waveId: string | null;
  readonly sourceRepository: {
    readonly id: string;
    readonly name: string;
    readonly fullPath: string;
    /** BigInt: the RPC sends it as a string. */
    readonly sizeBytes: string | number | null;
    readonly sizeClass: SizeClass;
  } | null;
  readonly wave: { readonly id: string; readonly name: string } | null;
  readonly latestAnalysis: {
    readonly createdAt: string;
    readonly items: readonly { readonly facetKey: string; readonly kind: PlanItemKind }[];
  } | null;
  readonly runs: readonly {
    readonly id: string;
    readonly kind: string;
    readonly status: string;
    readonly createdAt: string;
    readonly finishedAt: string | null;
  }[];
}

export interface RepositoryPage {
  readonly rows: readonly RepositoryRow[];
  readonly total: number;
}

export interface NamedRef {
  readonly id: string;
  readonly name: string;
}

const enc = encodeURIComponent;
const rpc = <T>(model: string, op: string, args: unknown) =>
  apiRequest<{ data: T }>(`/api/model/${model}/${op}?q=${enc(JSON.stringify(args))}`).then(
    (r) => r.data,
  );

/**
 * Query keys. Every key starts with `repositories` so one live invalidation refreshes the page
 * (JOB-060); the Route's namespaces and the Waves change rarely and are not invalidated by it.
 */
export const repositoriesKey = ['repositories'] as const;
export const repositoryPageKey = (
  f: RepositoryFilters,
  s: RepositorySort,
  page: number,
  pageSize: number,
) => [...repositoriesKey, 'page', f, s, page, pageSize] as const;
export const namespacesKey = (endpointId: string) => ['repository-namespaces', endpointId] as const;
export const wavesKey = ['repository-waves'] as const;

/** One page and the total, from two Model API reads (the server filters, sorts and pages). */
export async function fetchRepositoryPage(
  filters: RepositoryFilters,
  sort: RepositorySort,
  page: number,
  pageSize: number,
): Promise<RepositoryPage> {
  const [rows, total] = await Promise.all([
    rpc<RepositoryRow[]>('migration', 'findMany', buildFindMany(filters, sort, page, pageSize)),
    rpc<number>('migration', 'count', { where: buildWhere(filters) }),
  ]);
  return { rows, total };
}

export const fetchNamespaces = (endpointId: string) =>
  rpc<{ id: string; name: string; slug: string }[]>('namespace', 'findMany', {
    where: { endpointId },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, slug: true },
    take: 500,
  });

export const fetchWaves = () =>
  rpc<NamedRef[]>('wave', 'findMany', {
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
    take: 200,
  });

/** Row action (UI-021): `POST /migrations/{id}/analyze`. Migrate and Run anyway arrive with the Run endpoint (T-074). */
export const analyzeMigration = (id: string) =>
  apiRequest<unknown>(`/api/v1/migrations/${enc(id)}/analyze`, { method: 'POST' });

/** How many of `ids` the filters still show, so the view can say how many selected rows they hide. */
export const countMatching = (filters: RepositoryFilters, ids: readonly string[]) =>
  rpc<number>('migration', 'count', { where: { AND: [buildWhere(filters), { id: { in: ids } }] } });
