import { json, mockApi } from './test-api.ts';

/** Fixtures shared by the naming rule page tests (UI-030). Used only by tests. */

export const ROUTE = { id: 'r1', sourceEndpointId: 'e1', targetEndpointId: 'e2' };
export const DEFAULT_STEPS = [
  { var: 'namespace', op: 'projectKey' },
  { var: 'namespace', op: 'lowercase' },
  { var: 'repository', op: 'slug' },
  { var: 'repository', op: 'kebab' },
];
export const RULE = {
  id: 'rule-1',
  routeId: 'r1',
  scope: 'namespace',
  scopeRef: 'ns1',
  pipeline: { steps: DEFAULT_STEPS, template: '{namespace}-{repository}' },
  override: null,
};

export const preview = (collisions: unknown[] = []) => ({
  summary: { affected: 2, changed: 2, invalid: 0, colliding: collisions.length },
  collisions,
  items: [
    {
      migrationId: 'm1',
      sourcePath: 'proj/alpha',
      inScope: true,
      currentName: 'proj-alpha',
      plannedName: 'proj-alpha',
      changed: false,
      ruleSource: 'namespace',
      findings: [],
    },
  ],
  nextCursor: null,
});

export const COLLISION = [{ key: 'proj-alpha', members: ['m1', 'm2'] }];

/** One saved rule for namespace `ns1`; the preview answers with `previewReply()`. */
export function setupNaming(previewReply: () => Response) {
  return mockApi(
    (url, init) => {
      if (url.pathname === '/api/v1/routes') return json({ items: [ROUTE] });
      if (url.pathname === '/api/v1/routes/r1/naming/preview' && init?.method === 'POST') {
        return previewReply();
      }
      return undefined;
    },
    {
      namingRule: [RULE],
      namespace: [{ id: 'ns1', name: 'Projects', key: 'PROJ' }],
      repository: [],
      route: [{ id: 'r1', defaults: { naming: null }, policies: { acceptLossy: [] } }],
    },
  );
}
