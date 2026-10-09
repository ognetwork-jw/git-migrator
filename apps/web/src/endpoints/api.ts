import { apiRequest } from '../api/http.ts';
import { findMany } from '../model/rpc.ts';

const enc = encodeURIComponent;

/** An Endpoint as the Endpoints page lists it (UI-025): configuration is read-only. */
export interface EndpointRow {
  readonly id: string;
  readonly displayName: string;
  readonly providerType: string;
  readonly baseUrl: string;
  readonly status: string;
}

export interface EndpointStats {
  readonly repositories: number;
  readonly identities: number;
  readonly groups: number;
  /** The most recent inventory of a repository of the Endpoint, if any. */
  readonly lastInventoriedAt: string | null;
}

export interface RouteRow {
  readonly id: string;
  readonly sourceEndpointId: string;
  readonly targetEndpointId: string;
  readonly targetNamespacePath: string;
}

export const endpointsKey = ['endpoints', 'list'] as const;
export const routesKey = ['endpoints', 'routes'] as const;
export const endpointStatsKey = (id: string) => ['endpoints', 'stats', id] as const;

export const fetchEndpoints = () =>
  findMany<EndpointRow>('endpoint', {
    orderBy: { id: 'asc' },
    select: { id: true, displayName: true, providerType: true, baseUrl: true, status: true },
  });

export const fetchRoutes = () =>
  findMany<RouteRow>('route', {
    where: { retiredAt: null },
    orderBy: { id: 'asc' },
    select: { id: true, sourceEndpointId: true, targetEndpointId: true, targetNamespacePath: true },
  });

const count = (model: string, where: Record<string, unknown>) =>
  apiRequest<{ data: number }>(
    `/api/model/${model}/count?q=${enc(JSON.stringify({ where }))}`,
  ).then((r) => r.data);

/** Counts and the last inventory time of one Endpoint, from the rows the inventory keeps (JOB-030). */
export async function fetchEndpointStats(endpointId: string): Promise<EndpointStats> {
  const [repositories, identities, groups, latest] = await Promise.all([
    count('repository', { endpointId }),
    count('identity', { endpointId }),
    count('group', { endpointId }),
    findMany<{ lastInventoriedAt: string | null }>('repository', {
      where: { endpointId },
      orderBy: { lastInventoriedAt: 'desc' },
      take: 1,
      select: { lastInventoriedAt: true },
    }),
  ]);
  return {
    repositories,
    identities,
    groups,
    lastInventoriedAt: latest[0]?.lastInventoriedAt ?? null,
  };
}

/** The endpoint-scope Migration of a Route (DOM-014), with what the header shows. */
export interface EndpointMigration {
  readonly id: string;
  readonly status: string;
  readonly readiness: string | null;
  readonly latestAnalysisId: string | null;
  readonly analysisStaleAt: string | null;
  readonly route: RouteRow & {
    readonly sourceEndpoint: { readonly displayName: string };
    readonly targetEndpoint: { readonly displayName: string };
  };
}

export const endpointMigrationKey = (routeId: string) =>
  ['endpoints', 'migration', routeId] as const;

export const fetchEndpointMigration = async (routeId: string): Promise<EndpointMigration | null> =>
  (
    await findMany<EndpointMigration>('migration', {
      where: { routeId, scope: 'endpoint' },
      take: 1,
      select: {
        id: true,
        status: true,
        readiness: true,
        latestAnalysisId: true,
        analysisStaleAt: true,
        route: {
          select: {
            id: true,
            sourceEndpointId: true,
            targetEndpointId: true,
            targetNamespacePath: true,
            sourceEndpoint: { select: { displayName: true } },
            targetEndpoint: { select: { displayName: true } },
          },
        },
      },
    })
  )[0] ?? null;

export type FindingKind = 'step' | 'blocker' | 'pre_task' | 'post_task' | 'warning';

export interface FindingRow {
  readonly id: string;
  readonly facetKey: string;
  readonly kind: FindingKind;
  readonly code: string;
  readonly fieldPaths: readonly string[];
}

export const findingsKey = (analysisId: string) => ['endpoints', 'findings', analysisId] as const;

/** Findings and Steps of an Analysis: the Steps give the Facet strip its Facets with no finding. */
export const fetchFindings = (analysisId: string) =>
  findMany<FindingRow>('planItem', {
    where: { analysisId },
    orderBy: [{ order: 'asc' }, { id: 'asc' }],
    select: { id: true, facetKey: true, kind: true, code: true, fieldPaths: true },
  });

/** `GET /api/v1/migrations/{id}/diff` (API-020): source, desired and target side by side. */
export interface DiffFacet {
  readonly facetKey: string;
  readonly source: unknown;
  readonly desired: unknown;
  readonly target: unknown;
  readonly parity: {
    readonly status: string;
    readonly diffs: readonly { readonly path: string }[];
  } | null;
  readonly expectedDifferences: readonly {
    readonly id: string;
    readonly path: string;
    readonly reason: string;
  }[];
}
export interface MigrationDiff {
  readonly analyzedAt: string | null;
  readonly facets: readonly DiffFacet[];
}

export const diffKey = (migrationId: string, analysisId: string | null) =>
  ['endpoints', 'diff', migrationId, analysisId] as const;

export const fetchDiff = (migrationId: string) =>
  apiRequest<MigrationDiff>(`/api/v1/migrations/${enc(migrationId)}/diff`);

export interface RunRow {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

export const runsKey = (migrationId: string) => ['endpoints', 'runs', migrationId] as const;

export const fetchRuns = (migrationId: string) =>
  findMany<RunRow>('run', {
    where: { migrationId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 50,
    select: {
      id: true,
      kind: true,
      status: true,
      createdAt: true,
      startedAt: true,
      finishedAt: true,
    },
  });

export {
  analyzeMigration,
  type RowRunKind as EndpointRunKind,
  startMigrationRun,
} from '../repositories/api.ts';
