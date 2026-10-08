/**
 * members facet (FAC-END members): who is a member of the target organization. Pure: no I/O, no
 * provider vocabulary (GLO-002). Members are never added here; invitations go out only through
 * approved Invitation Batches (AUTH-060, AUTH-061).
 *
 * Decisions: docs/adr/0150-endpoint-facets-members-teams.md.
 */
import { type Members, membersFacet } from '@git-migrator/canonical';
import type {
  FacetDefinition,
  FacetTaskRef,
  FieldDecision,
  FieldDiff,
  Finding,
  FindingCodeSpec,
  TranslateContext,
  TranslationResult,
} from '@git-migrator/core';
import {
  compareCodeUnits,
  diffDesiredOnly,
  paramStrings,
  principalLabel,
  principalPath,
  resolvePrincipal,
  targetOrgMembers,
} from '../endpoint-support.ts';

export const MEMBERS_FINDING_CODES = {
  'members.review-identity-mapping': { kind: 'pre', completion: 'resolution' },
  'members.approve-invitations': { kind: 'post', completion: 'resolution' },
  'members.pending-acceptance': { kind: 'post', completion: 'parity' },
} as const satisfies Record<string, FindingCodeSpec>;

type Member = Members['members'][number];

/** `admin` outranks `member`. */
function maxRole(a: Member['role'], b: Member['role']): Member['role'] {
  return a === 'admin' || b === 'admin' ? 'admin' : 'member';
}

/** Merges duplicate principals (highest role wins) and sorts by `kind:id`. */
export function normalizeMembers(data: Members): Members {
  const byKey = new Map<string, Member>();
  for (const m of data.members) {
    const key = principalLabel(m.principal);
    const prev = byKey.get(key);
    byKey.set(key, prev === undefined ? { ...m } : { ...prev, role: maxRole(prev.role, m.role) });
  }
  return {
    members: [...byKey.entries()].sort(([a], [b]) => compareCodeUnits(a, b)).map(([, m]) => m),
  };
}

/**
 * `ctx.routeIndex.invitationCandidates`: source identity ids that are invitation candidates (an
 * unmapped identity with a known email that is not in a sent batch and was not deselected). The
 * facet sees neither emails nor batches. A malformed list throws.
 */
export function invitationCandidates(routeIndex: TranslateContext['routeIndex']): Set<string> {
  const configured = routeIndex.invitationCandidates;
  if (configured === undefined) return new Set();
  if (!Array.isArray(configured) || configured.some((id) => typeof id !== 'string')) {
    throw new TypeError('routeIndex.invitationCandidates must be an array of source identity ids');
  }
  return new Set(configured as string[]);
}

export function translateMembers(
  source: Members,
  ctx: TranslateContext,
): TranslationResult<Members> {
  const candidateIds = invitationCandidates(ctx.routeIndex);
  const orgMembers = targetOrgMembers(ctx.routeIndex);
  const desired = new Map<string, Member>();
  const decisions: FieldDecision[] = [];
  const unmappedPaths: string[] = [];
  const candidatePaths: string[] = [];
  const pendingPaths: string[] = [];

  for (const member of source.members) {
    const path = principalPath('members', member.principal);
    const resolution = resolvePrincipal(member.principal, ctx);
    switch (resolution.status) {
      case 'mapped': {
        const target = resolution.principal;
        if (target.kind !== 'identity' || !orgMembers.has(target.id)) {
          // Confirmed but not in the organization yet: writing it as a member would invite it
          // outside an approved batch (AUTH-061). It goes the invitation route instead.
          decisions.push({ path, fidelity: 'unsupported', accepted: false });
          candidatePaths.push(path);
          break;
        }
        const key = principalLabel(target);
        const prev = desired.get(key);
        desired.set(key, {
          principal: target,
          role: prev === undefined ? member.role : maxRole(prev.role, member.role),
        });
        if (key !== principalLabel(member.principal)) {
          decisions.push({ path, fidelity: 'translated', accepted: false });
        }
        break;
      }
      case 'excluded':
        // Omitted on purpose; the identity_excluded Expected Difference exists (AUTH-050).
        break;
      case 'pending_invite':
        decisions.push({ path, fidelity: 'unsupported', accepted: false });
        pendingPaths.push(path);
        break;
      case 'unmapped':
      case 'team_missing':
        decisions.push({ path, fidelity: 'unsupported', accepted: false });
        unmappedPaths.push(path);
        if (member.principal.kind === 'identity' && candidateIds.has(member.principal.id)) {
          candidatePaths.push(path);
        }
        break;
    }
  }

  const preTasks: Finding[] = [];
  const postTasks: Finding[] = [];
  if (unmappedPaths.length > 0) {
    preTasks.push({
      code: 'members.review-identity-mapping',
      paths: unmappedPaths,
      params: { count: unmappedPaths.length },
    });
  }
  if (candidatePaths.length > 0) {
    postTasks.push({
      code: 'members.approve-invitations',
      paths: candidatePaths,
      params: { count: candidatePaths.length },
    });
  }
  if (pendingPaths.length > 0) {
    postTasks.push({
      code: 'members.pending-acceptance',
      paths: pendingPaths,
      params: { count: pendingPaths.length },
    });
  }

  return {
    desired: normalizeMembers({ members: [...desired.values()] }),
    decisions,
    blockers: [],
    preTasks,
    postTasks,
    warnings: [],
  };
}

/** Parity ignores target-only members: the organization keeps people the source never had. */
export function compareMembers(desired: Members, actual: Members): FieldDiff[] {
  return diffDesiredOnly(desired, actual, membersFacet.documentSchema);
}

/**
 * `members.pending-acceptance` is done when every `params.targetPrincipals` entry (`kind:id`) is a
 * member of the target. The resolver does not say which target identity an invitation becomes
 * (ADR-0105), so tasks normally lack the param and stay open until a later Analysis no longer
 * emits them (the mapping is then `confirmed`).
 */
export function isMembersTaskSatisfied(task: FacetTaskRef, target: Members): boolean {
  if (task.code !== 'members.pending-acceptance') return false;
  const wanted = paramStrings(task.params, 'targetPrincipals');
  if (wanted === undefined || wanted.length === 0) return false;
  const present = new Set(target.members.map((m) => principalLabel(m.principal)));
  return wanted.every((w) => present.has(w));
}

export const membersDefinition: FacetDefinition<Members> = {
  key: membersFacet.key,
  scope: membersFacet.scope,
  schemaVersion: membersFacet.schemaVersion,
  schema: membersFacet.schema,
  compareMode: 'full',
  collections: membersFacet.collections,
  sets: membersFacet.sets,
  dependsOn: [],
  inScope: true,
  normalize: normalizeMembers,
  translate: translateMembers,
  compare: (desired, actual) => compareMembers(desired, actual),
  findingCodes: MEMBERS_FINDING_CODES,
  policyKeys: [],
  isTaskSatisfied: (task, target) => isMembersTaskSatisfied(task, target),
};
