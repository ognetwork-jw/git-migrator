import type { BranchRule, PrincipalEntry } from '@git-migrator/canonical';

/**
 * Strictest combination of source rules that convert to one target pattern (ADR-0110). Works on
 * normalized source rules, before principals are resolved.
 */

function keyOf(e: PrincipalEntry): string {
  return `${e.principal.kind}:${e.principal.id}`;
}

function intersect(lists: readonly PrincipalEntry[][]): PrincipalEntry[] {
  const [first, ...rest] = lists;
  if (first === undefined) return [];
  return first.filter((e) => rest.every((l) => l.some((x) => keyOf(x) === keyOf(e))));
}

/** `null` (unrestricted) is the identity; otherwise only principals every list allows remain. */
function strictestList(lists: readonly (PrincipalEntry[] | null)[]): PrincipalEntry[] | null {
  const set = lists.filter((l): l is PrincipalEntry[] => l !== null);
  return set.length === 0 ? null : intersect(set);
}

/** Exemptions only matter for rules that block; a principal stays exempt if every blocking rule exempts it. */
function strictestExempt(
  rules: readonly BranchRule[],
  kind: 'force' | 'deletion',
): PrincipalEntry[] {
  const blocking = rules.filter((r) => (kind === 'force' ? r.blockForcePush : r.blockDeletion));
  return intersect(blocking.map((r) => (kind === 'force' ? r.forcePushExempt : r.deletionExempt)));
}

function strictestChangeRequest(rules: readonly BranchRule[]): BranchRule['changeRequest'] {
  const crs = rules.map((r) => r.changeRequest).filter((c) => c !== null);
  if (crs.length === 0) return null;
  return {
    minApprovals: Math.max(...crs.map((c) => c.minApprovals)),
    requireCodeOwnerApproval: crs.some((c) => c.requireCodeOwnerApproval),
    dismissStaleApprovals: crs.some((c) => c.dismissStaleApprovals),
    requireNoChangesRequested: crs.some((c) => c.requireNoChangesRequested),
    requireTasksResolved: crs.some((c) => c.requireTasksResolved),
    requireUpToDate: crs.some((c) => c.requireUpToDate),
    minPassingBuilds: Math.max(...crs.map((c) => c.minPassingBuilds)),
  };
}

/**
 * One target list restricts both pushes and merges, so the merged allowance is the intersection of
 * every rule's effective list (`restrictPushes`, else `restrictMerges`) and of every merge list.
 * A single rule is left as it is; translate handles its two lists.
 */
function restrictions(
  rules: readonly BranchRule[],
): Pick<BranchRule, 'restrictPushes' | 'restrictMerges'> {
  if (rules.length === 1) {
    const [only] = rules as [BranchRule];
    return { restrictPushes: only.restrictPushes, restrictMerges: only.restrictMerges };
  }
  const effective = strictestList([
    ...rules.map((r) => r.restrictPushes ?? r.restrictMerges),
    ...rules.map((r) => r.restrictMerges),
  ]);
  return {
    restrictPushes: effective,
    restrictMerges: rules.some((r) => r.restrictMerges !== null) ? effective : null,
  };
}

export function mergeRules(pattern: string, rules: readonly BranchRule[]): BranchRule {
  const blockForcePush = rules.some((r) => r.blockForcePush);
  const blockDeletion = rules.some((r) => r.blockDeletion);
  return {
    pattern,
    enforcement: rules.some((r) => r.enforcement === 'enforced') ? 'enforced' : 'advisory',
    ...restrictions(rules),
    blockForcePush,
    forcePushExempt: blockForcePush ? strictestExempt(rules, 'force') : [],
    blockDeletion,
    deletionExempt: blockDeletion ? strictestExempt(rules, 'deletion') : [],
    changeRequest: strictestChangeRequest(rules),
  };
}
