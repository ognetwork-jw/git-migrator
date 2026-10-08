import type { BranchRules } from '@git-migrator/canonical';
import { branchRulesFacet } from '@git-migrator/canonical';
import { diffDocuments, type FieldDiff, parseFieldPath } from '@git-migrator/core';

function isMinPassingBuilds(path: string): boolean {
  const segments = parseFieldPath(path);
  const n = segments.length;
  return (
    n === 3 &&
    segments[0]?.name === 'rules' &&
    segments[1]?.name === 'changeRequest' &&
    segments[2]?.name === 'minPassingBuilds'
  );
}

function required(value: unknown): boolean {
  return typeof value === 'number' && value > 0;
}

/**
 * Structural diff, except that `minPassingBuilds` is compared as "any required builds or none":
 * the target holds named checks that the user chooses, so their number cannot be expected to equal
 * the source's count (docs/adr/0112-branch-rules-normalization-and-compare.md).
 */
export function compareBranchRules(desired: BranchRules, actual: BranchRules): FieldDiff[] {
  return diffDocuments(desired, actual, branchRulesFacet.documentSchema).filter(
    (d) => !(isMinPassingBuilds(d.path) && required(d.desired) === required(d.actual)),
  );
}
