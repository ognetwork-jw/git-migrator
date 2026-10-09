/**
 * Branch-name patterns of the target's protection rules (LIF-040 step 3a). They are shell globs
 * over the branch name where `*` stops at `/`, `**` does not, and `?` is one character that is
 * not `/`. A character class `[...]` is read literally here: a rule that uses one is lifted only
 * when its literal text matches, which errs on the side of leaving a rule in place; the push is
 * then refused by the provider and the Step fails visibly instead of lifting a rule it should not.
 */
export function branchPatternMatches(pattern: string, name: string): boolean {
  // Iterative dynamic programme over (pattern token, text position): linear in the product, no
  // backtracking, so a hostile pattern cannot take exponential time.
  const tokens: ('any' | 'seg' | 'one' | string)[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        tokens.push('any');
        i++;
      } else tokens.push('seg');
    } else if (ch === '?') tokens.push('one');
    else tokens.push(`=${ch}`);
  }
  let row = new Array<boolean>(name.length + 1).fill(false);
  row[0] = true;
  for (const token of tokens) {
    const next = new Array<boolean>(name.length + 1).fill(false);
    if (token === 'any' || token === 'seg') next[0] = row[0] === true;
    for (let j = 1; j <= name.length; j++) {
      const ch = name[j - 1] as string;
      if (token === 'any') next[j] = row[j] === true || next[j - 1] === true;
      else if (token === 'seg') next[j] = row[j] === true || (ch !== '/' && next[j - 1] === true);
      else if (token === 'one') next[j] = row[j - 1] === true && ch !== '/';
      else next[j] = row[j - 1] === true && token === `=${ch}`;
    }
    row = next;
  }
  return row[name.length] === true;
}
