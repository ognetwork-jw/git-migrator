/**
 * @git-migrator/canonical: TypeScript types, Zod schemas, keyed-collection declarations and schema
 * versions of every built-in facet (FAC-001, ADP-002, ADP-021). Depends only on core (ARC-012).
 */
export const PACKAGE_NAME = '@git-migrator/canonical';

export * from './common.ts';
export * from './facets/access-control.ts';
export * from './facets/branch-rule-order.ts';
export * from './facets/branch-rules.ts';
export * from './facets/change-requests.ts';
export * from './facets/code-ownership.ts';
export * from './facets/deploy-keys.ts';
export * from './facets/environments.ts';
export * from './facets/extras.ts';
export * from './facets/git-refs.ts';
export * from './facets/members.ts';
export * from './facets/merge-settings.ts';
export * from './facets/org-facets.ts';
export * from './facets/pipelines.ts';
export * from './facets/repository-settings.ts';
export * from './facets/teams.ts';
export * from './facets/variables.ts';
export * from './facets/webhooks.ts';
export * from './registry.ts';
