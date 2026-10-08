import { apiRequest } from '../api/http.ts';

export type MappingStatus = 'suggested' | 'confirmed' | 'excluded' | 'pending_invite' | 'unmapped';
export const MAPPING_STATUSES: readonly MappingStatus[] = [
  'unmapped',
  'suggested',
  'confirmed',
  'pending_invite',
  'excluded',
];

export interface IdentityRef {
  readonly id: string;
  readonly providerId: string;
  readonly login: string | null;
  readonly displayName: string | null;
  readonly email: string | null;
}

export interface IdentityMapping {
  readonly id: string;
  readonly status: MappingStatus;
  readonly method: string | null;
  readonly confidence: number | null;
  readonly decidedAt: string | null;
  readonly decidedBy: string | null;
  readonly reason: string | null;
  readonly source: IdentityRef;
  readonly target: IdentityRef | null;
}

export interface GroupRef {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly memberCount: number;
}

export interface GroupMapping {
  readonly id: string;
  readonly status: MappingStatus;
  readonly plannedSlug: string;
  readonly collision: boolean;
  readonly sourceGroup: GroupRef;
  readonly targetGroup: GroupRef | null;
}

export interface RouteSummary {
  readonly id: string;
  readonly sourceEndpointId: string;
  readonly targetEndpointId: string;
}

export interface CsvRowReport {
  readonly line: number;
  readonly source: string;
  readonly target: string;
  readonly action: string;
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly outcome: 'mapped' | 'invited' | 'excluded' | 'unchanged' | 'replaces_decision' | null;
}

export interface CsvReport {
  readonly dryRun: boolean;
  readonly ok: boolean;
  readonly fileErrors: readonly string[];
  readonly rows: readonly CsvRowReport[];
  readonly summary: {
    readonly total: number;
    readonly valid: number;
    readonly invalid: number;
    readonly mapped: number;
    readonly invited: number;
    readonly excluded: number;
    readonly unchanged: number;
    readonly replaced: number;
  };
}

const enc = encodeURIComponent;

export const routesKey = ['mapping', 'routes'] as const;
export const identitiesKey = (routeId: string, status: string, q: string) =>
  ['mapping', 'identities', routeId, status, q] as const;
export const groupsKey = (routeId: string) => ['mapping', 'groups', routeId] as const;

export const fetchRoutes = () =>
  apiRequest<{ items: RouteSummary[] }>('/api/v1/routes').then((r) => r.items);

export const fetchIdentityMappings = (
  routeId: string,
  options: { status?: string; q?: string; cursor?: string },
) => {
  const query = new URLSearchParams({ limit: '50' });
  if (options.status) query.set('status', options.status);
  if (options.q) query.set('q', options.q);
  if (options.cursor) query.set('cursor', options.cursor);
  return apiRequest<{ items: IdentityMapping[]; nextCursor: string | null }>(
    `/api/v1/routes/${enc(routeId)}/identity-mappings?${query}`,
  );
};

export const fetchTargetIdentities = (routeId: string, q: string) =>
  apiRequest<{ items: IdentityRef[] }>(
    `/api/v1/routes/${enc(routeId)}/target-identities?${new URLSearchParams(q ? { q } : {})}`,
  ).then((r) => r.items);

export const decideIdentity = (
  routeId: string,
  mappingId: string,
  action: 'confirm' | 'exclude' | 'unmap',
  body: { targetIdentityId?: string; reason?: string } = {},
) =>
  apiRequest<IdentityMapping>(
    `/api/v1/routes/${enc(routeId)}/identity-mappings/${enc(mappingId)}/${action}`,
    { method: 'POST', json: body },
  );

export const importCsv = (routeId: string, csv: string, dryRun: boolean) =>
  apiRequest<CsvReport>(
    `/api/v1/routes/${enc(routeId)}/identity-mappings/import?dryRun=${dryRun}`,
    { method: 'POST', text: { body: csv, type: 'text/csv' } },
  );

export const fetchGroupMappings = (routeId: string) =>
  apiRequest<{ items: GroupMapping[] }>(`/api/v1/routes/${enc(routeId)}/group-mappings`).then(
    (r) => r.items,
  );

export const decideGroup = (
  routeId: string,
  mappingId: string,
  action: 'confirm' | 'rename',
  body: { targetGroupId?: string; plannedSlug?: string } = {},
) =>
  apiRequest<GroupMapping>(
    `/api/v1/routes/${enc(routeId)}/group-mappings/${enc(mappingId)}/${action}`,
    { method: 'POST', json: body },
  );
