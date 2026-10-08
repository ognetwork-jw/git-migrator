/**
 * access-control (FAC-ACL): who has which role on the repository. Provider-neutral: the adapters
 * produce the effective explicit grants (FAC-ACL-001) and write them (FAC-ACL-002); this module
 * resolves principals (FAC-006, FAC-ACL-003/004), compares and declares the findings.
 * Decisions: docs/adr/0105-access-control-facet.md.
 */
import {
  ACCESS_ROLES,
  type AccessControl,
  type AccessRole,
  accessControlFacet,
  type PrincipalRef,
} from '@git-migrator/canonical';
import {
  diffDocuments,
  type FacetDefinition,
  type FieldDecision,
  type Finding,
  type FindingCodeSpec,
} from '@git-migrator/core';
import {
  principalIsGranted,
  principalLabel,
  principalPath,
  resolvePrincipal,
} from './principals.ts';

export const ACCESS_CONTROL_FINDING_CODES = {
  'access-control.unmapped-principal': { kind: 'pre', completion: 'resolution' },
  'access-control.pending-invitation': { kind: 'post', completion: 'parity' },
  'access-control.team-missing': { kind: 'blocker' },
} as const satisfies Record<string, FindingCodeSpec>;

/** Roles ordered from least to most access (the canonical order). */
export function roleRank(role: AccessRole): number {
  return ACCESS_ROLES.indexOf(role);
}

export function maxRole(a: AccessRole, b: AccessRole): AccessRole {
  return roleRank(a) >= roleRank(b) ? a : b;
}

type Grant = AccessControl['grants'][number];

/** FAC-ACL-001: where a principal appears more than once it gets the maximum role. */
function mergeGrants(grants: readonly Grant[]): Grant[] {
  const byKey = new Map<string, Grant>();
  for (const g of grants) {
    const key = principalLabel(g.principal);
    const prev = byKey.get(key);
    byKey.set(key, prev === undefined ? { ...g } : { ...prev, role: maxRole(prev.role, g.role) });
  }
  return [...byKey.values()];
}

export const accessControl: FacetDefinition<AccessControl> = {
  key: accessControlFacet.key,
  scope: accessControlFacet.scope,
  schemaVersion: accessControlFacet.schemaVersion,
  schema: accessControlFacet.schema,
  compareMode: 'full',
  collections: accessControlFacet.collections,
  sets: accessControlFacet.sets,
  dependsOn: ['members', 'teams'],
  inScope: true,
  normalize: (data) => ({ grants: mergeGrants(data.grants) }),
  translate(source, ctx) {
    const grants = new Map<string, Grant>();
    const decisions: FieldDecision[] = [];
    const blockers: Finding[] = [];
    const preTasks: Finding[] = [];
    const postTasks: Finding[] = [];

    for (const grant of source.grants) {
      const sourcePath = principalPath('grants', grant.principal);
      const label = principalLabel(grant.principal);
      const resolution = resolvePrincipal(grant.principal, ctx);
      switch (resolution.status) {
        case 'mapped': {
          const target: PrincipalRef = resolution.principal;
          const key = principalLabel(target);
          const prev = grants.get(key);
          grants.set(key, {
            principal: target,
            role: prev === undefined ? grant.role : maxRole(prev.role, grant.role),
          });
          if (key !== label) {
            decisions.push({
              path: sourcePath,
              fidelity: 'translated',
              accepted: false,
            });
          }
          break;
        }
        case 'excluded':
          // Omitted on purpose; the identity_excluded Expected Difference exists (AUTH-050).
          break;
        case 'pending_invite':
          decisions.push({ path: sourcePath, fidelity: 'unsupported', accepted: false });
          postTasks.push({
            code: 'access-control.pending-invitation',
            paths: [sourcePath],
            params: { principal: label, facet: 'access-control' },
          });
          break;
        case 'team_missing':
          decisions.push({ path: sourcePath, fidelity: 'unsupported', accepted: false });
          blockers.push({
            code: 'access-control.team-missing',
            paths: [sourcePath],
            params: { team: grant.principal.id },
          });
          break;
        case 'unmapped':
          decisions.push({ path: sourcePath, fidelity: 'unsupported', accepted: false });
          preTasks.push({
            code: 'access-control.unmapped-principal',
            paths: [sourcePath],
            params: { principal: label, facet: 'access-control' },
          });
          break;
      }
    }

    return {
      desired: { grants: [...grants.values()] },
      decisions,
      blockers,
      preTasks,
      postTasks,
      warnings: [],
    };
  },
  compare: (desired, actual) => diffDocuments(desired, actual, accessControlFacet.documentSchema),
  findingCodes: ACCESS_CONTROL_FINDING_CODES,
  policyKeys: [],
  isTaskSatisfied(task, target) {
    if (task.code !== 'access-control.pending-invitation') return false;
    return grantsContain(target, task.params);
  },
};

/**
 * `params.targetPrincipal` (`kind:id`) names the principal the invitation resolves to. Resolvers do
 * not expose it for a pending invitation yet (ADR-0105), so tasks normally lack it and stay open
 * until a later Analysis no longer emits them.
 */
function grantsContain(target: AccessControl, params: unknown): boolean {
  return principalIsGranted(
    target.grants.map((g) => g.principal),
    params,
  );
}
