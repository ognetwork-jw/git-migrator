import type { BranchRule, BranchRules, PrincipalEntry } from '@git-migrator/canonical';

function dedupe(entries: PrincipalEntry[]): PrincipalEntry[] {
  const seen = new Set<string>();
  const out: PrincipalEntry[] = [];
  for (const e of entries) {
    const key = `${e.principal.kind}:${e.principal.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ principal: { kind: e.principal.kind, id: e.principal.id } });
  }
  return out;
}

function isEmptyChangeRequest(cr: NonNullable<BranchRule['changeRequest']>): boolean {
  return (
    cr.minApprovals === 0 &&
    !cr.requireCodeOwnerApproval &&
    !cr.dismissStaleApprovals &&
    !cr.requireNoChangesRequested &&
    !cr.requireTasksResolved &&
    !cr.requireUpToDate &&
    cr.minPassingBuilds === 0
  );
}

/**
 * Canonical form of one rule (docs/adr/0112-branch-rules-normalization-and-compare.md): principal
 * lists without duplicates; exemption lists empty when the thing they exempt from is not blocked
 * (they carry no meaning then, and the target never reports them); a change-request block that
 * requires nothing is `null`.
 */
export function normalizeRule(rule: BranchRule): BranchRule {
  const cr = rule.changeRequest;
  return {
    pattern: rule.pattern,
    enforcement: rule.enforcement,
    restrictPushes: rule.restrictPushes === null ? null : dedupe(rule.restrictPushes),
    restrictMerges: rule.restrictMerges === null ? null : dedupe(rule.restrictMerges),
    blockForcePush: rule.blockForcePush,
    forcePushExempt: rule.blockForcePush ? dedupe(rule.forcePushExempt) : [],
    blockDeletion: rule.blockDeletion,
    deletionExempt: rule.blockDeletion ? dedupe(rule.deletionExempt) : [],
    changeRequest: cr === null || isEmptyChangeRequest(cr) ? null : { ...cr },
  };
}

export function normalizeBranchRules(data: BranchRules): BranchRules {
  return { rules: data.rules.map(normalizeRule) };
}
