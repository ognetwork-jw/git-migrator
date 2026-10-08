import { formatFieldPath, itemSeg, parsePathPattern } from '@git-migrator/core';

/** One Expected Difference an exclusion needs: a facet and the path pattern it masks. */
export interface ExclusionPattern {
  readonly facetKey: string;
  readonly path: string;
}

/** The collections of principals a Rule can hold (`branch-rules`). */
const RULE_PRINCIPAL_LISTS = [
  'restrictPushes',
  'restrictMerges',
  'forcePushExempt',
  'deletionExempt',
] as const;

/**
 * The Expected Difference patterns that cover one principal wherever it can appear (AUTH-050
 * step 4). `principalId` is the Provider-stable ID of the Identity (`identity:<id>` in a path).
 * The principal segment is rendered with `formatFieldPath`, which escapes `*` in the id, and every
 * pattern is checked by `parsePathPattern`, so an unusual id can never turn into a wildcard.
 * The `[slug=*]` and `[pattern=*]` selectors are the only wildcards, written by hand.
 */
export function exclusionPatterns(principalId: string): ExclusionPattern[] {
  const principal = (name: string) =>
    formatFieldPath([itemSeg(name, 'principal', `identity:${principalId}`)]);
  const out: ExclusionPattern[] = [
    { facetKey: 'access-control', path: principal('grants') },
    { facetKey: 'members', path: principal('members') },
    { facetKey: 'teams', path: `/teams[slug=*]${principal('members')}` },
    ...RULE_PRINCIPAL_LISTS.map((list) => ({
      facetKey: 'branch-rules',
      path: `/rules[pattern=*]${principal(list)}`,
    })),
    { facetKey: 'code-ownership', path: `/owners[pattern=*]${principal('principals')}` },
  ];
  for (const p of out) parsePathPattern(p.path);
  return out;
}
