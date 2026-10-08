/** Helpers shared by the endpoint-level facet unit tests. Imported from *.test.ts files only. */
import {
  type FacetCapability,
  type PrincipalRef,
  type PrincipalResolution,
  resolveRoutePolicies,
  type TranslateEnvironment,
} from '@git-migrator/core';

/** Resolution table keyed `kind:id`; a principal not in the table is `unmapped`. */
export type ResolutionTable = Record<string, PrincipalResolution>;

export function envOf(
  table: ResolutionTable = {},
  opts: {
    route?: TranslateEnvironment['route'];
    routeIndex?: TranslateEnvironment['routeIndex'];
    policies?: unknown;
  } = {},
): TranslateEnvironment {
  const resolver = {
    resolve: (p: PrincipalRef): PrincipalResolution =>
      table[`${p.kind}:${p.id}`] ?? { status: 'unmapped' },
  };
  return {
    identities: resolver,
    groups: resolver,
    policies: resolveRoutePolicies(opts.policies ?? {}),
    route: opts.route ?? {},
    routeIndex: opts.routeIndex ?? {},
  };
}

export const identity = (id: string): PrincipalRef => ({ kind: 'identity', id });
export const group = (id: string): PrincipalRef => ({ kind: 'group', id });
export const mapped = (principal: PrincipalRef): PrincipalResolution => ({
  status: 'mapped',
  principal,
});
export const excluded: PrincipalResolution = { status: 'excluded' };
export const pendingInvite: PrincipalResolution = { status: 'pending_invite' };
export const teamMissing: PrincipalResolution = { status: 'team_missing' };

export const unreadable = (...paths: string[]): FacetCapability => ({
  read: true,
  write: false,
  fields: Object.fromEntries(paths.map((p) => [p, { kind: 'unreadable' as const }])),
});
