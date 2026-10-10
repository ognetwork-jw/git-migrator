/**
 * The Model API query behind `/repositories` (UI-021, API-012). Pure: filters, sort and page in,
 * the ZenStack RPC arguments out, so the server (not the browser) filters, sorts and pages.
 */

export const MIGRATION_STATUSES = [
  'discovered',
  'analyzed',
  'running',
  'migrated',
  'failed',
  'partial',
  'verified',
  'manually_completed',
  'drifted',
  'rolled_back',
  'source_missing',
] as const;
export type MigrationStatus = (typeof MIGRATION_STATUSES)[number];

/** "Unmigrated", the default filter, is every status but these two (06-migration-lifecycle.md). */
export const DONE_STATUSES: readonly MigrationStatus[] = ['verified', 'manually_completed'];

export const READINESS_VALUES = ['ready', 'needs_attention', 'blocked'] as const;
export type Readiness = (typeof READINESS_VALUES)[number];
export const SIZE_CLASSES = ['standard', 'large'] as const;
export type SizeClass = (typeof SIZE_CLASSES)[number];

export type StatusFilter = 'unmigrated' | 'all' | MigrationStatus;

export interface RepositoryFilters {
  readonly routeId: string;
  readonly namespaceId?: string;
  readonly status: StatusFilter;
  readonly readiness?: Readiness;
  readonly sizeClass?: SizeClass;
  readonly waveId?: string;
  readonly blockerCode?: string;
  readonly hasOpenTasks: boolean;
  readonly search: string;
}

export const SORT_FIELDS = [
  'path',
  'target',
  'status',
  'readiness',
  'size',
  'wave',
  'analyzed',
] as const;
export type SortField = (typeof SORT_FIELDS)[number];
export interface RepositorySort {
  readonly field: SortField;
  readonly order: 'asc' | 'desc';
}

export const PAGE_SIZE = 50;
export const DEFAULT_SORT: RepositorySort = { field: 'path', order: 'asc' };

export const defaultFilters = (routeId: string): RepositoryFilters => ({
  routeId,
  status: 'unmigrated',
  hasOpenTasks: false,
  search: '',
});

function statusClause(status: StatusFilter): Record<string, unknown> {
  if (status === 'all') return {};
  if (status === 'unmigrated') return { status: { notIn: DONE_STATUSES } };
  return { status };
}

/** The `where` of a Migration list for these filters (repository scope only). */
export function buildWhere(filters: RepositoryFilters): Record<string, unknown> {
  const repository: Record<string, unknown> = {};
  if (filters.namespaceId) repository.namespaceId = filters.namespaceId;
  if (filters.sizeClass) repository.sizeClass = filters.sizeClass;
  const search = filters.search.trim();
  if (search !== '') {
    repository.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { fullPath: { contains: search, mode: 'insensitive' } },
    ];
  }
  const blockerCode = filters.blockerCode?.trim();
  return {
    scope: 'repository',
    routeId: filters.routeId,
    ...statusClause(filters.status),
    ...(filters.readiness ? { readiness: filters.readiness } : {}),
    ...(filters.waveId ? { waveId: filters.waveId } : {}),
    ...(blockerCode ? { blockerCodes: { has: blockerCode } } : {}),
    ...(filters.hasOpenTasks ? { manualTasks: { some: { status: 'open' } } } : {}),
    ...(Object.keys(repository).length > 0 ? { sourceRepository: repository } : {}),
  };
}

/** The `orderBy` for a sort. The id is the tie-breaker, so the order is deterministic. */
export function buildOrderBy(sort: RepositorySort): Record<string, unknown>[] {
  const { order } = sort;
  const primary: Record<string, unknown> = (() => {
    switch (sort.field) {
      case 'path':
        return { sourceRepository: { fullPath: order } };
      case 'target':
        return { plannedTargetName: order };
      case 'status':
        return { status: order };
      case 'readiness':
        return { readiness: order };
      case 'size':
        return { sourceRepository: { sizeBytes: order } };
      case 'wave':
        return { wave: { name: order } };
      case 'analyzed':
        return { latestAnalysis: { createdAt: order } };
    }
  })();
  return [primary, { id: 'asc' }];
}

/** What a list row needs (one query: the row, its repository, Wave, Analysis findings, last Run). */
export const LIST_SELECT = {
  id: true,
  status: true,
  readiness: true,
  readinessCounts: true,
  plannedTargetName: true,
  blockerCodes: true,
  targetPlacementUnknown: true,
  waveId: true,
  sourceRepository: {
    select: { id: true, name: true, fullPath: true, sizeBytes: true, sizeClass: true },
  },
  wave: { select: { id: true, name: true } },
  latestAnalysis: {
    select: { createdAt: true, items: { select: { facetKey: true, kind: true } } },
  },
  runs: {
    orderBy: { createdAt: 'desc' },
    take: 1,
    select: { id: true, kind: true, status: true, createdAt: true, finishedAt: true },
  },
} as const;

/** `findMany` arguments for page `page` (1-based). */
export function buildFindMany(
  filters: RepositoryFilters,
  sort: RepositorySort,
  page: number,
  pageSize = PAGE_SIZE,
): Record<string, unknown> {
  return {
    where: buildWhere(filters),
    orderBy: buildOrderBy(sort),
    select: LIST_SELECT,
    skip: (Math.max(1, page) - 1) * pageSize,
    take: pageSize,
  };
}

/**
 * Filters from the address of the page (`?route=&status=&readiness=`), so links such as the
 * dashboard's can open a pre-filtered list. Unknown values are ignored.
 */
export function parseInitialFilters(
  params: Readonly<Record<string, string | string[] | undefined>>,
): { routeId?: string; filters: Partial<Omit<RepositoryFilters, 'routeId'>> } {
  const one = (key: string) => {
    const v = params[key];
    return typeof v === 'string' && v !== '' ? v : undefined;
  };
  const status = one('status');
  const readiness = one('readiness');
  const routeId = one('route');
  return {
    ...(routeId ? { routeId } : {}),
    filters: {
      ...(status === 'unmigrated' ||
      status === 'all' ||
      (MIGRATION_STATUSES as readonly string[]).includes(status ?? '')
        ? { status: status as StatusFilter }
        : {}),
      ...((READINESS_VALUES as readonly string[]).includes(readiness ?? '')
        ? { readiness: readiness as Readiness }
        : {}),
    },
  };
}
