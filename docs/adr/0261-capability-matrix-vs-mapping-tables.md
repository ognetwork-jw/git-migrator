# ADR-0261: Where declared capabilities and the 05-facets mapping tables disagree

- Status: agent-decided
- Date: 2026-10-08
- Task: T-058
- Affects: ADP-014, API-020 (capability-matrix), FAC-BRR-002, FAC-ENV, FAC-WEB-003, FAC-SET, FAC-VAR-003, FAC-COD

## Context

T-058 requires the computed matrix to match the mapping tables in docs/spec/05-facets.md. Neither side was changed: the snapshot (`packages/registry/src/__snapshots__/capability-matrix.json`) reflects the adapters' declared capabilities, and `packages/registry/src/builtin.test.ts` asserts each row below as the code declares it. The orchestrator decides which side moves.

## Disagreements (table value versus declared capability)

1. `branch-rules` `/rules/restrictMerges`: table lossy (`branch-rules.merge-restriction-as-push`); GitHub declares `unsupported`.
2. `branch-rules` `/rules/deletionExempt`: table lossy (`branch-rules.exemptions-dropped`); GitHub declares `unsupported`.
3. `environments` `/environments/category`: table lossy (`environments.category-dropped`, accepted by default); GitHub declares `unsupported`.
4. `branch-rules` `/rules/changeRequest/requireTasksResolved`: table lossy (`branch-rules.tasks-as-conversations`); GitHub declares nothing, so the matrix shows it `exact`.
5. `webhooks` and `org-webhooks` `/hooks/secret`: table (FAC-WEB-003) says the secret is unreadable on the source (post task `webhooks.set-secret`); only GitHub declares it, as `unreadable` on the target. Bitbucket Cloud declares no field, so Bitbucket Cloud to GitHub shows `exact` and the reverse pair shows `unreadable`.
6. Bitbucket Cloud declares every Facet readable with no fields. The tables also name source-side facts it could declare: `secrets` values (FAC-VAR-001, unreadable; the canonical schema has no value field), merge-settings `/allowed` and `/deleteBranchOnMerge` (FAC-MRG-002, unreadable per repository, so a read-time fact).

## Table rows the matrix cannot express

These are chosen by `translate` from the data, not by capabilities, so the matrix shows `exact` for them by design: description truncation at 350 characters and public-repository fork policy (`repository-settings`, the latter is a read-time capability, ADR-0231), pattern conversion and merging (`branch-rules.pattern-approximated`, `patterns-merged`, `overlap-unresolved`), upper-cased variable names, unmapped webhook events (`webhooks.event-dropped`), `code-ownership.default-reviewers-as-codeowners`, and everything marked `translated`.

## Reading notes

- `branch-rules` shows `unsupported` as a cell because `minPassingBuilds` is `unsupported` (table: post task `branch-rules.configure-status-checks`). A UI should show the field rows, not only the worst value.
- `write: false` on GitHub for `git-refs`, `pipelines`, `change-requests`, `members`, `secrets` and `org-secrets` agrees with the tables (push, Change Request, detection, invitation, post task), whose fidelity is not about a driver write.

## Decision

Keep both sides unchanged and record this list. Likely resolutions for the orchestrator: align GitHub capabilities to the table (items 1 to 3 to `constrained`, item 4 added as `constrained`, with a note) or amend the table to `unsupported` (FieldSupport `unsupported` and fidelity `lossy` differ in ADP-040 only by whether an approximation is applied); and add the `/hooks/secret` `unreadable` declaration to the Bitbucket Cloud adapter (item 5).
