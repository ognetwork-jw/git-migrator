/**
 * FAC-BRR-003: canonical glob to the target's pattern dialect (docs/adr/0110-branch-rule-pattern-and-desired-syntax.md).
 *
 * Canonical globs: `*` stays inside one path segment, `**` crosses `/`. The target dialect treats
 * `*` the same way, but a `**` crosses `/` only when it is a whole path segment; a trailing `**`
 * segment matches directories only, so it needs a final `*` segment (`a/**` -> `a/**` + `/*`).
 * A `**` glued to other characters acts like `*` there, and `?`, `[` and `\` are pattern operators
 * there, so those patterns have no lossless conversion. Longer runs of `*` mean the same as `**`.
 */

export interface ConvertedPattern {
  readonly pattern: string;
  /** `false` when no lossless conversion exists (policy `branch-rules.pattern-approximated`). */
  readonly lossless: boolean;
  /** What changes for the user when `lossless` is false. */
  readonly effects: readonly string[];
}

const OPERATORS = /[?[\\]/;

const GLUED_EFFECT =
  'a "**" inside a name segment matches like "*" on the target, so branches with "/" after the prefix are no longer protected';
const OPERATOR_EFFECT =
  '"?", "[" or "\\" are pattern operators on the target and may match other branches than the source does';

export function convertPattern(canonical: string): ConvertedPattern {
  const effects = new Set<string>();
  const out = canonical.split('/').map((segment) => {
    let text = segment.replace(/\*{3,}/g, '**');
    if (text === '**') return text;
    if (text.includes('**')) {
      effects.add(GLUED_EFFECT);
      text = text.replace(/\*{2}/g, '*');
    }
    if (OPERATORS.test(text)) effects.add(OPERATOR_EFFECT);
    return text;
  });
  // `**/**` is `**/`: repeated globstar segments are one.
  const collapsed = out.filter((segment, i) => !(segment === '**' && out[i - 1] === '**'));
  if (collapsed[collapsed.length - 1] === '**') collapsed.push('*');
  return { pattern: collapsed.join('/'), lossless: effects.size === 0, effects: [...effects] };
}
