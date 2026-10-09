import { apiRequest } from '../api/http.ts';

/** `GET /api/v1/dashboard` (UI-020, ADR-0332). */
export interface Dashboard {
  readonly generatedAt: string;
  readonly routes: readonly {
    readonly routeId: string;
    readonly sourceEndpointId: string;
    readonly targetEndpointId: string;
    readonly total: number;
    readonly byStatus: Readonly<Record<string, number>>;
    readonly byReadiness: Readonly<Record<string, number>>;
    readonly endpointMigration: {
      readonly migrationId: string;
      readonly status: string;
      readonly readiness: string | null;
    } | null;
  }[];
  readonly wavesTruncated: boolean;
  readonly waves: readonly {
    readonly id: string;
    readonly name: string;
    readonly targetDate: string | null;
    readonly total: number;
    readonly byStatus: Readonly<Record<string, number>>;
  }[];
  readonly recentRuns: readonly {
    readonly id: string;
    readonly migrationId: string;
    readonly kind: string;
    readonly status: string;
    readonly createdAt: string;
    readonly startedAt: string | null;
    readonly finishedAt: string | null;
  }[];
}

/** `GET /api/v1/quota` (JOB-047, ADR-0332). */
export interface Quota {
  readonly generatedAt: string;
  readonly backlogTotal: number;
  readonly backlogTruncated: boolean;
  readonly buckets: readonly {
    readonly bucketKey: string;
    readonly endpointId: string | null;
    readonly accountKey: string | null;
    readonly resourceGroup: string | null;
    readonly limit: number;
    readonly effectiveLimit: number;
    readonly windowSeconds: number;
    readonly used: number;
    readonly pools: {
      readonly backgroundLimit: number;
      readonly usedBackground: number;
      readonly usedInteractive: number;
    };
    readonly remaining: number | null;
    readonly resetAt: string | null;
    readonly blockedUntil: string | null;
    readonly nearLimit: boolean;
    readonly backgroundRatePerSecond: number;
    readonly backlog: number;
    readonly backgroundEtaSeconds: number | null;
  }[];
}

/** The queries the shell's live connection refreshes (JOB-060): counts and Runs, and the quota gauges. */
export const dashboardKey = ['dashboard'] as const;
export const quotaKey = ['quota'] as const;

export const fetchDashboard = () => apiRequest<Dashboard>('/api/v1/dashboard');
export const fetchQuota = () => apiRequest<Quota>('/api/v1/quota');
export const refreshInventory = () =>
  apiRequest<{ endpoints: string[] }>('/api/v1/inventory/refresh', { method: 'POST', json: {} });
