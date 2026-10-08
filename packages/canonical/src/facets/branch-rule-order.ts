/**
 * Branch-rule patterns as the target applies them (docs/adr/0113-branch-rule-overlap.md).
 *
 * Patterns are in the target dialect of ADR-0110: `*` stays inside one path segment and a
 * whole-segment `**` matches zero or more segments. The target applies one rule per branch: a rule
 * naming the exact branch wins, and among wildcard rules (any of `*`, `?`, `[`, `]`, `\`) the one
 * created first wins. A writer therefore creates rules in `branchRuleApplyOrder`, which puts every
 * rule before the wildcard rules that include it.
 */

/** Characters that make a rule a wildcard rule for the target's priority. */
const SPECIAL = /[*?[\]\\]/;
/** Operators whose matching is not interpreted here (`]` alone matches itself). */
const UNINTERPRETED = /[?[\\]/;

/** A rule without special characters names one branch, and has priority over wildcard rules. */
export function isLiteralBranchPattern(pattern: string): boolean {
  return !SPECIAL.test(pattern);
}

/** The text before the first special character. */
export function branchPatternPrefix(pattern: string): string {
  const at = pattern.search(SPECIAL);
  return at === -1 ? pattern : pattern.slice(0, at);
}

/** `**` followed by a final `*` segment matches every branch name. */
export function matchesEveryBranch(pattern: string): boolean {
  return pattern === '**/*';
}

/**
 * Does segment glob `glob` match every name that segment `text` matches? `text` may hold `*`
 * itself; only a `*` of `glob` can absorb it, so a `true` holds for every expansion of `text`.
 */
function segmentIncludes(glob: string, text: string): boolean {
  const parts = glob.split('*');
  if (parts.length === 1) return glob === text;
  const first = parts[0] as string;
  const last = parts[parts.length - 1] as string;
  if (text.length < first.length + last.length) return false;
  if (!text.startsWith(first) || !text.endsWith(last)) return false;
  let at = first.length;
  const end = text.length - last.length;
  for (const mid of parts.slice(1, -1)) {
    const found = text.indexOf(mid, at);
    if (found === -1 || found + mid.length > end) return false;
    at = found + mid.length;
  }
  return true;
}

function segmentsInclude(
  wide: readonly string[],
  w: number,
  narrow: readonly string[],
  n: number,
): boolean {
  if (w === wide.length) return n === narrow.length;
  const segment = wide[w] as string;
  if (segment === '**') {
    // Zero or more segments, whatever they are (a `**` of `narrow` included).
    for (let skip = n; skip <= narrow.length; skip += 1) {
      if (segmentsInclude(wide, w + 1, narrow, skip)) return true;
    }
    return false;
  }
  const current = narrow[n];
  // Only a `**` can stand for any number of segments.
  if (current === undefined || current === '**') return false;
  return segmentIncludes(segment, current) && segmentsInclude(wide, w + 1, narrow, n + 1);
}

/**
 * Does `wide` match every branch that `narrow` matches? Sound but conservative: `true` is proven,
 * `false` means "not shown", and `undefined` means a pattern uses operators not interpreted here.
 */
export function branchPatternIncludes(wide: string, narrow: string): boolean | undefined {
  if (UNINTERPRETED.test(wide) || UNINTERPRETED.test(narrow)) return undefined;
  return segmentsInclude(wide.split('/'), 0, narrow.split('/'), 0);
}

/** `wide` is a different pattern that provably matches every branch `narrow` matches. */
export function branchPatternCovers(wide: string, narrow: string): boolean {
  if (wide === narrow) return false;
  if (matchesEveryBranch(wide)) return true;
  return branchPatternIncludes(wide, narrow) === true;
}

function applyRank(pattern: string): number {
  if (isLiteralBranchPattern(pattern)) return 0;
  return matchesEveryBranch(pattern) ? 2 : 1;
}

/**
 * Tie-break of the apply order: literal rules first (their order does not matter), the rule that
 * matches every branch last, other wildcard rules by longer literal prefix; then code-unit order.
 */
export function compareBranchRuleApplyOrder(a: string, b: string): number {
  const rank = applyRank(a) - applyRank(b);
  if (rank !== 0) return rank;
  const prefix = branchPatternPrefix(b).length - branchPatternPrefix(a).length;
  if (applyRank(a) === 1 && prefix !== 0) return prefix;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The rules in apply order: a topological order of `branchPatternCovers` (every rule before the
 * rules that cover it), choosing by `compareBranchRuleApplyOrder` among the rules that are ready.
 * Keyed collections are stored sorted by key (ADP-021), so a writer computes this order from the
 * patterns. Deterministic for any input order; the input is not changed.
 */
export function branchRuleApplyOrder<T extends { readonly pattern: string }>(
  rules: readonly T[],
): T[] {
  const remaining = [...rules].sort((x, y) => compareBranchRuleApplyOrder(x.pattern, y.pattern));
  const out: T[] = [];
  while (remaining.length > 0) {
    const ready = remaining.findIndex(
      (r) => !remaining.some((x) => x !== r && branchPatternCovers(r.pattern, x.pattern)),
    );
    // Inclusion is a strict order on distinct patterns, so some rule is always ready; the
    // fallback only keeps the function total.
    const [next] = remaining.splice(ready === -1 ? 0 : ready, 1) as [T];
    out.push(next);
  }
  return out;
}
