import { apiRequest } from '../api/http.ts';
import { createRow, deleteRow, findMany, updateRow } from '../model/rpc.ts';
import {
  OVERRIDE_PLACEHOLDER_PIPELINE,
  type PipelinePayload,
  type PreviewResult,
  type RuleBody,
  type Scope,
} from './naming-draft.ts';

const enc = encodeURIComponent;

export interface NamingRuleRow {
  readonly id: string;
  readonly routeId: string;
  readonly scope: Scope;
  readonly scopeRef: string;
  readonly pipeline: PipelinePayload;
  readonly override: string | null;
}

export interface RouteConfig {
  readonly id: string;
  readonly sourceEndpointId: string;
  readonly targetEndpointId: string;
  /** The adapter types of the two Endpoints: the pair the capability matrix is keyed by. */
  readonly sourceEndpoint: { readonly providerType: string };
  readonly targetEndpoint: { readonly providerType: string };
  readonly defaults: { readonly naming?: PipelinePayload } & Record<string, unknown>;
  readonly policies: { readonly acceptLossy?: string[] } & Record<string, unknown>;
}

export interface WebhookRow {
  readonly id: string;
  readonly routeId: string;
  readonly pattern: string;
  readonly note: string | null;
}

export interface OverlayRow {
  readonly id: string;
  readonly routeId: string;
  readonly facetKey: string;
  readonly data: unknown;
  readonly enabled: boolean;
  readonly updatedAt: string;
}

export type Fidelity = 'exact' | 'translated' | 'lossy' | 'unreadable' | 'unsupported';

export interface MatrixField {
  readonly path: string;
  readonly source: { readonly kind: string };
  readonly target: { readonly kind: string };
  readonly fidelity: Fidelity;
}

export interface MatrixCell {
  readonly source: string;
  readonly target: string;
  readonly fidelity: Fidelity;
  readonly read: boolean;
  readonly write: boolean;
  readonly override: boolean;
  readonly fields: readonly MatrixField[];
}

export interface CapabilityMatrix {
  readonly ceiling: 'static';
  readonly adapters: readonly string[];
  readonly rows: readonly {
    readonly facet: string;
    readonly scope: 'repository' | 'endpoint';
    readonly inScope: boolean;
    readonly cells: readonly MatrixCell[];
  }[];
}

export const namingRulesKey = (routeId: string) => ['config', 'naming-rules', routeId] as const;
export const routeConfigKey = ['config', 'route-config'] as const;
export const webhooksKey = (routeId: string) => ['config', 'webhooks', routeId] as const;
export const overlaysKey = (routeId: string) => ['config', 'overlays', routeId] as const;
export const matrixKey = ['config', 'capability-matrix'] as const;

export const fetchNamingRules = (routeId: string) =>
  findMany<NamingRuleRow>('namingRule', {
    where: { routeId },
    orderBy: [{ scope: 'asc' }, { scopeRef: 'asc' }],
  });

/** The stored data of a rule body. An override rule keeps the placeholder pipeline (LIF-030). */
const ruleData = (body: RuleBody) =>
  'override' in body
    ? { override: body.override, pipeline: OVERRIDE_PLACEHOLDER_PIPELINE }
    : { override: null, pipeline: body.pipeline };

export const createNamingRule = (routeId: string, body: RuleBody) =>
  createRow<NamingRuleRow>('namingRule', {
    routeId,
    scope: body.scope,
    scopeRef: body.scopeRef,
    ...ruleData(body),
  });

/** Scope is fixed once a rule exists; only its body changes. */
export const updateNamingRule = (id: string, body: RuleBody) =>
  updateRow<NamingRuleRow>('namingRule', { id }, ruleData(body));

export const deleteNamingRule = (id: string) => deleteRow('namingRule', { id });

/** `POST /routes/{id}/naming/preview` (API-020): names and collisions, nothing is saved. */
export const previewNaming = (routeId: string, body: RuleBody, cursor?: string) =>
  apiRequest<PreviewResult>(
    `/api/v1/routes/${enc(routeId)}/naming/preview${cursor ? `?cursor=${enc(cursor)}` : ''}`,
    { method: 'POST', json: { rule: body } },
  );

export const fetchRouteConfigs = () =>
  findMany<RouteConfig>('route', {
    select: {
      id: true,
      defaults: true,
      policies: true,
      sourceEndpointId: true,
      targetEndpointId: true,
      sourceEndpoint: { select: { providerType: true } },
      targetEndpoint: { select: { providerType: true } },
    },
    orderBy: { id: 'asc' },
  });

/** Namespaces of a source Endpoint for the scope picker, searched by name. */
export const searchNamespaces = (endpointId: string, q: string) =>
  findMany<{ id: string; name: string; key: string | null }>('namespace', {
    where: { endpointId, ...(q ? { name: { contains: q } } : {}) },
    select: { id: true, name: true, key: true },
    orderBy: { name: 'asc' },
    take: 50,
  }).then((rows) =>
    rows.map((r) => ({ id: r.id, label: r.key ? `${r.name} (${r.key})` : r.name })),
  );

/** Repositories of a source Endpoint for the scope picker, searched by path. */
export const searchRepositories = (endpointId: string, q: string) =>
  findMany<{ id: string; fullPath: string }>('repository', {
    where: { endpointId, ...(q ? { fullPath: { contains: q } } : {}) },
    select: { id: true, fullPath: true },
    orderBy: { fullPath: 'asc' },
    take: 50,
  }).then((rows) => rows.map((r) => ({ id: r.id, label: r.fullPath })));

/** Labels of the scope references of saved rules: the namespace or repository each rule names. */
export async function scopeLabels(rules: readonly NamingRuleRow[]): Promise<Map<string, string>> {
  const repoIds = rules.filter((r) => r.scope === 'repository').map((r) => r.scopeRef);
  const nsIds = rules.filter((r) => r.scope === 'namespace').map((r) => r.scopeRef);
  const [repos, namespaces] = await Promise.all([
    repoIds.length === 0
      ? []
      : findMany<{ id: string; fullPath: string }>('repository', {
          where: { id: { in: repoIds } },
          select: { id: true, fullPath: true },
        }),
    nsIds.length === 0
      ? []
      : findMany<{ id: string; name: string }>('namespace', {
          where: { id: { in: nsIds } },
          select: { id: true, name: true },
        }),
  ]);
  const labels = new Map<string, string>();
  for (const r of repos) labels.set(r.id, r.fullPath);
  for (const n of namespaces) labels.set(n.id, n.name);
  return labels;
}

export const fetchWebhooks = (routeId: string) =>
  findMany<WebhookRow>('webhookAllowlistEntry', {
    where: { routeId },
    orderBy: { pattern: 'asc' },
  });

export const createWebhook = (routeId: string, pattern: string, note: string | null) =>
  createRow<WebhookRow>('webhookAllowlistEntry', { routeId, pattern, note });

export const updateWebhook = (id: string, pattern: string, note: string | null) =>
  updateRow<WebhookRow>('webhookAllowlistEntry', { id }, { pattern, note });

export const deleteWebhook = (id: string) => deleteRow('webhookAllowlistEntry', { id });

export const fetchOverlays = (routeId: string) =>
  findMany<OverlayRow>('overlay', {
    where: { routeId },
    orderBy: { facetKey: 'asc' },
  });

export type OverlayInput = {
  readonly facetKey: string;
  readonly data: Record<string, unknown>;
  readonly enabled: boolean;
};

/**
 * Overlay writes go to the validated `/api/v1/overlays` endpoints, not the RPC mount: the server
 * checks the document against the Facet's schema (DOM-003, ADR-0362). Reads stay on the RPC mount.
 */
export const createOverlay = (routeId: string, input: OverlayInput) =>
  apiRequest<OverlayRow>('/api/v1/overlays', { method: 'POST', json: { routeId, ...input } });

/** The Facet is fixed once an Overlay exists; its document and flag change. */
export const updateOverlay = (id: string, input: Omit<OverlayInput, 'facetKey'>) =>
  apiRequest<OverlayRow>(`/api/v1/overlays/${enc(id)}`, { method: 'PATCH', json: input });

export const deleteOverlay = (id: string) =>
  apiRequest<void>(`/api/v1/overlays/${enc(id)}`, { method: 'DELETE' });

export const fetchCapabilityMatrix = () =>
  apiRequest<CapabilityMatrix>('/api/v1/capability-matrix');
