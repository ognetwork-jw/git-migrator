/**
 * Which target rule applies to a branch (ADR-0113). The target applies one rule per branch, so a
 * rule's protection is lost on branches where a different rule takes priority. Inclusion is decided
 * segment by segment in `@git-migrator/canonical` (`branchPatternCovers`), which also gives the
 * apply order; this module adds the "may select the same branch" test for the other pairs.
 */
import {
  branchPatternCovers,
  branchPatternIncludes,
  branchPatternPrefix,
} from '@git-migrator/canonical';

export { branchPatternCovers as covers };

/** No `*` and no uninterpreted operator: the pattern matches exactly its own text. */
function isPlainName(pattern: string): boolean {
  return !/[*?[\\]/.test(pattern);
}

function hasGlobstar(pattern: string): boolean {
  return pattern.split('/').includes('**');
}

/** Two rules that neither cover the other may still select the same branch. */
export function mayOverlap(a: string, b: string): boolean {
  if (isPlainName(a) && isPlainName(b)) return false;
  const name = isPlainName(a) ? a : isPlainName(b) ? b : undefined;
  if (name !== undefined) {
    // `false` is decided (the glob does not match the name); `true` would be a cover.
    return branchPatternIncludes(name === a ? b : a, name) === undefined;
  }
  // Without a `**`, every branch a pattern matches has as many segments as the pattern (no
  // operator matches `/`). Brackets and escapes could hide a `/`, so they are left undecided.
  const countable = (p: string) => !hasGlobstar(p) && !/[[\\]/.test(p);
  if (countable(a) && countable(b) && a.split('/').length !== b.split('/').length) return false;
  const pa = branchPatternPrefix(a);
  const pb = branchPatternPrefix(b);
  return pa.startsWith(pb) || pb.startsWith(pa);
}
