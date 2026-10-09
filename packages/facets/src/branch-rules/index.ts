/**
 * The branch-rules Facet (FAC-BRR, docs/spec/05-facets.md). Provider-neutral: the canonical
 * document is translated for the target, whatever it is; the adapters do the reading and writing.
 */
import { type BranchRules, branchRulesFacet } from '@git-migrator/canonical';
import type { FacetDefinition, FacetTaskRef } from '@git-migrator/core';
import { compareBranchRules } from './compare.ts';
import { normalizeBranchRules } from './normalize.ts';
import { FACET } from './principals.ts';
import { POLICY, translateBranchRules } from './translate.ts';

export { compareBranchRules } from './compare.ts';
export { normalizeBranchRules, normalizeRule } from './normalize.ts';
export { convertPattern } from './pattern.ts';
export { MAX_APPROVALS, POLICY as BRANCH_RULES_POLICY, translateBranchRules } from './translate.ts';

/** `configure-status-checks` is done once the target rule requires any builds. */
function isTaskSatisfied(task: FacetTaskRef, target: BranchRules): boolean {
  if (task.code !== `${FACET}.configure-status-checks`) return false;
  const params = task.params as { pattern?: unknown } | null;
  const rule = target.rules.find((r) => r.pattern === params?.pattern);
  return (rule?.changeRequest?.minPassingBuilds ?? 0) > 0;
}

export const branchRulesDefinition: FacetDefinition<BranchRules> = {
  key: 'branch-rules',
  scope: branchRulesFacet.scope,
  schemaVersion: branchRulesFacet.schemaVersion,
  schema: branchRulesFacet.schema,
  compareMode: 'full',
  collections: branchRulesFacet.collections,
  sets: branchRulesFacet.sets,
  dependsOn: ['git-refs', 'access-control'],
  inScope: true,
  normalize: normalizeBranchRules,
  translate: translateBranchRules,
  compare: (desired, actual) => compareBranchRules(desired, actual),
  findingCodes: {
    'branch-rules.accept-lossy': { kind: 'pre', completion: 'accept' },
    'branch-rules.configure-status-checks': { kind: 'post', completion: 'parity' },
    'branch-rules.exemptions-not-applied': { kind: 'post' },
    'branch-rules.protection-lifted': { kind: 'post' },
    'branch-rules.unknown-kind': { kind: 'warning' },
    'branch-rules.branching-model': { kind: 'warning' },
    'branch-rules.unmapped-principal': { kind: 'pre', completion: 'resolution' },
    'branch-rules.pending-invitation': { kind: 'post', completion: 'parity' },
    'branch-rules.team-missing': { kind: 'blocker' },
  },
  policyKeys: Object.values(POLICY),
  isTaskSatisfied,
};
