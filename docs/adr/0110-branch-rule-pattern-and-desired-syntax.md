# ADR-0110: Branch-rule patterns in `desired` use the target's dialect

- Status: accepted (spec updated)
- Date: 2026-10-08
- Task: T-052
- Affects: FAC-BRR-002, FAC-BRR-003, ADP-021

## Context

FAC-BRR-003 says canonical globs convert to the target's pattern dialect. It does not say whether `desired.rules[].pattern` holds the canonical or the converted form, how a trailing `**` behaves, or what happens when two rules convert to one pattern. In the target dialect `**` is recursive only as a whole path segment, and a last segment `**` matches directories only.

## Decision

- `desired` holds the pattern in the target's dialect, because `desired` is compared with what the target adapter reads, and the adapter reads patterns verbatim. Decision paths use the converted pattern as the key.
- Conversion (`convertPattern`): runs of three or more `*` mean `**`. A whole-segment `**` is kept; a trailing `**` segment gets a final `*` segment (`a/**` becomes `a/**/*`, `**` becomes `**/*`). `**` glued to other characters becomes `*`, and a segment containing `?`, `[` or a backslash (operators in the target dialect, never valid in ref names) is passed through unchanged. The last two are not lossless: lossy `branch-rules.pattern-approximated`, whose note gives the source patterns, the target pattern and the effect (for example branches with "/" after the prefix are no longer protected). A changed but lossless pattern is a `translated` decision.
- Source rules converting to the same target pattern are merged into their strictest combination (fail closed), never dropped: every block flag is OR-ed; push and merge lists intersect, with `null` (unrestricted) as the identity; an exempt principal stays exempt only if every rule that blocks exempts it; `minApprovals` and `minPassingBuilds` take the maximum and the other change-request flags are OR-ed; a rule is `advisory` only if all are. The merge is a lossy decision under the policy key `branch-rules.patterns-merged` at the rule's path (`/rules[pattern=...]`), with the source patterns in the note. Accepting the key accepts the stricter merged rule. `pattern-approximated` is not used for merges. The key is agent-decided; it is folded into FAC-BRR-003 (docs/spec/05-facets.md).

## Consequences

The target reader must not rewrite target patterns. T-032 and T-033 should confirm.
