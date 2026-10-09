# ADR-0113: Overlapping branch-rule patterns and merged restrictions

- Status: accepted (spec updated)
- Date: 2026-10-08
- Task: T-052
- Affects: FAC-BRR-002, FAC-BRR-003, ADR-0110, T-033 (target writer)

## Context

Classic branch protection on the target applies one rule per branch. Which rule wins is documented in github/docs at commit `7b80792`, `content/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/managing-a-branch-protection-rule.md` (lines 37 to 39):

> If a repository has multiple protected branch rules that affect the same branches, the rules that include a specific branch name have the highest priority. If there is more than one protected branch rule that references the same specific branch name, then the branch rule created first will have higher priority.
>
> Protected branch rules that mention a special character, such as `*`, `?`, or `]`, are applied in the order they were created, so older rules with these characters have a higher priority.

So an exact name always beats a wildcard rule, and among wildcard rules the **oldest** wins, whatever its pattern. Source rules combine instead: every matching restriction applies. Translating each rule on its own would lose protection on every branch where another target rule takes priority. Folding protection into a wildcard rule only helps if that rule is the one the target applies, which depends on creation order. Keyed collections are stored sorted by key (ADP-021): the engine re-sorts `desired.rules` by pattern, so an order cannot be carried in the array.

## Decision

1. **Decidable supersets are folded.** For each target rule R, every other rule S that matches every branch R matches is merged into R with the strictest merge of ADR-0110, recorded as lossy `branch-rules.patterns-merged` naming the folded patterns. S is still emitted for its own pattern. Decidable cases: S is `**/*` (matches everything). Otherwise inclusion is decided segment by segment by `branchPatternCovers` in `@git-migrator/canonical`, for patterns whose only operators are `*` (inside a segment) and a whole-segment `**` (zero or more segments). A `*` of R can only be absorbed by a `*` of S, and a `**` of R only by a `**` of S, so a positive answer holds for every branch. The test is conservative: "not shown" counts as not covered, and `?`, `[` and `\` are not interpreted. It covers a literal under a glob and globs such as `*hotfix` under `*` or `release/*` under `release/**/*`. S and R that are equivalent after normalization collide into one group. Repeated `**` segments collapse to one (`a/**/**` is `a/**`), so equivalent patterns collide into one group.
2. **Undecidable overlaps are never silent.** Two rules that neither cover the other, and that may select the same branch, get a lossy decision under the new policy key `branch-rules.overlap-unresolved` at `/rules[pattern=...]/overlap` of the narrower rule (longer literal prefix; both rules on a tie). The note names both patterns and says that only one rule applies per branch, so protection from the other may not apply. May select the same branch: two globs whose literal prefixes are compatible (one is a prefix of the other), unless neither has a `**` segment (nor `[` or `\`) and their segment counts differ, because no operator matches `/` (`release/*` and `release/*/rc` are disjoint); or a plain name and a glob whose operators this facet does not interpret. Disjoint prefixes, two literals, and a literal that a glob provably does not match need nothing. The apply order of point 5 creates the rule with the longer literal prefix first, so it is the one the target applies where both match.
3. **Merged restrictions never widen the allowance.** One target list restricts both pushes and merges. When rules are merged, the allowance is the intersection of every rule's effective list (`restrictPushes`, else `restrictMerges`) and of every merge list, with `null` as the identity; the result is `restrictPushes`, and `restrictMerges` equals it (or is `null` when no rule had one). When a merged rule had a merge list that its push list does not equal, the dropped merge restriction is a lossy `merge-restriction-as-push` decision whose note says the allowance is the intersection.
4. A merged group with any advisory source rule (own or folded) keeps the `advisory-enforced` decision.
5. **Apply order is part of the meaning of `desired`.** A rule must be created before every rule folded into it, so that it is older and wins. Because the stored array is sorted by key, the order is computed from the patterns by `branchRuleApplyOrder` / `compareBranchRuleApplyOrder` in `@git-migrator/canonical` (pure, usable by adapters under ARC-012): a deterministic topological sort over `branchPatternCovers`, so every rule comes before the rules that cover it (`*hotfix` before `*`, `release/*` before `release/**/*`). Among the rules that are ready, the tie-break `compareBranchRuleApplyOrder` picks literal rules first (order-independent, an exact name always wins), then wildcard rules by longer literal prefix, then code-unit order, with `**/*` last. A comparator alone cannot give this order, because inclusion does not follow prefix length. A property test checks the order over random rule sets and input orders. A rule counts as a wildcard rule for priority if it contains any special character of the target (`*`, `?`, `[`, `]`, `\`), although a `]` on its own still matches itself. `translate` returns its rules in this order too. **The target writer (T-033) MUST create wildcard rules in `branchRuleApplyOrder(desired.rules)` order.**
6. **Never silent when the order cannot be guaranteed.** Rules that already exist on the target, or that a user created by hand, are older than anything the migration creates. So for every wildcard rule R folded under a wildcard rule S, translate also emits lossy `branch-rules.overlap-unresolved` at R's `/overlap` path; the note names S, says that the target applies the older wildcard rule, and that R's protection holds only if R is created before S. A literal folded under a glob stays `patterns-merged` only, because an exact name wins whatever the order. When R also has an undecidable overlap (point 2), both notes go into the one decision at that path.

The `/overlap` path segment is not a canonical field: decisions are keyed by path and this key needs its own path beside `/pattern` (`pattern-approximated`) and the rule path (`patterns-merged`).

Both new keys are agent-decided; they are folded into FAC-BRR-003 (docs/spec/05-facets.md).

## Alternatives

- Emit nothing for partial overlaps: rejected, silent loss of protection.
- Compute exact glob inclusion: possible for simple globs but not for the target's full dialect; the three cases above cover the common ones.
- Carry the apply order as the array order of `desired`: impossible, the engine sorts keyed collections (ADP-021).
- Add an order field to the canonical rule: changes the FAC-BRR schema for something derivable from the patterns.
- Rely on creation order alone, without a finding: silent when the target already has older wildcard rules.
