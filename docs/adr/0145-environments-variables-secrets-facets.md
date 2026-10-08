# ADR-0145: environments, variables and secrets facet semantics

- Status: agent-decided
- Date: 2026-10-08
- Task: T-054
- Affects: FAC-ENV, FAC-VAR-001..003, FAC-SEC-001, FAC-005, FAC-002, ADP-021

## Context

The spec fixes the mapping tables for these three facets but is silent on: environment names that differ only by case (the target is case-insensitive, docs/followups.md T-015); where the name of the target repository for `gh secret set --repo` comes from; how secret names that are invalid on the target are reported; and which path a decision uses when a name is rewritten and so changes the collection key.

## Decision

- **Case-insensitive environment names.** `environments` groups source names by lower-cased name. In a group of two or more, the first name in code-unit order is kept in `desired`; the others get an `unsupported` decision and the group raises the new pre task `environments.name-collision` (`params.names`, completion manual: the user renames in the source and re-analyzes). `variables` and `secrets` depend on `environments` and rewrite an `environment:<name>` scope to the casing of the desired environment (`ctx.deps.environments.desired`), so two scopes that differ only by case become one and their same-name items collide (next point). Without the dependency the scope is left unchanged. `compare` aligns the target's environment and name casing to the desired spelling, so casing on the target is never drift.
- **Name collisions and invalid names (FAC-VAR-003).** Names are upper-cased, then checked against `^[A-Z_][A-Z0-9_]*$` and the `GITHUB_` prefix. Items that fail, and every item in a group that collides after upper-casing within one (case-folded) scope, are omitted from `desired` and listed in one `variables.name-invalid` pre task (`params.names`, sorted source names; `paths` are the source keys). No item of a collision is kept, because choosing one would be a silent guess. A variable whose only change is upper-casing gets a lossy decision with `variables.uppercase-names`.
- **Secrets.** The target stores secret names in upper case itself, so the same rewrite is `translated` for secrets (no new policy key, no new accept task). Invalid or colliding secret names raise the new pre task `secrets.name-invalid`, because `variables.name-invalid` belongs to another facet (finding codes are `<facet>.<name>`). `secrets.set-value` is one post task per desired scope with `params: { scope, names, environment? }`, names sorted. It carries no value and no repository name: a facet cannot know the planned target name (LIF-030), so the guidance renderer supplies `repository` when it builds the `gh secret set` lines. `isTaskSatisfied` holds when every listed name exists in that scope on the target (scope and name case-insensitive); malformed params are never satisfied.
- **Secret values.** The canonical secret schema is strict and has no value field, so a source secret that carries one fails `schema.parse` in the engine and the message does not echo it. No fixture or test uses a realistic value; the only test value is a plainly labelled placeholder.
- **Decision paths** address the desired document (`/variables[key=repository/API_URL]/name`), the same document `compare` diffs. Finding paths for rejected items address the source document, because the item is not in `desired`.
- **Deployment branches** are `translated` (a decision with no policy key) and sorted/deduplicated as a set. `category` is always `null` in `desired`.
- **Guidance.** `environments.name-collision` and `secrets.name-invalid` have entries in `packages/guidance`, listed in `AGENT_DECIDED_CODES` in `spec-crosscheck.test.ts` (the spec does not name them yet). The coverage test is `testing/integration/src/facets-env-vars-secrets-guidance.test.ts` (same rule as ADR-0103).

## Alternatives

- Keep every environment of a case-colliding group and let the apply step fail: the failure would surface during the Run instead of at analysis.
- Make the collision a blocker: a pre task is enough, as with `variables.name-invalid`, and clears when the user renames in the source.
- Keep the first of a colliding variable pair: hides data loss.
- Add `secrets.uppercase-names` as a lossy policy key: nothing is lost, since the target upper-cases secret names itself.

## Affected requirements

FAC-VAR-001, FAC-VAR-002, FAC-VAR-003, FAC-SEC-001, FAC-005, FAC-002.
