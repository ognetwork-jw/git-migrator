# ADR-0261: Adapter capabilities aligned to the 05-facets mapping tables

- Status: accepted (spec updated)
- Date: 2026-10-08
- Task: T-058
- Affects: ADP-014, API-020 (capability-matrix), FAC-BRR-002, FAC-BRR-003, FAC-ENV, FAC-WEB-001, FAC-WEB-003, FAC-SET, FAC-VAR-001, FAC-VAR-003, FAC-SEC-001, FAC-COD, FAC-MRG-002

## Context

T-058 requires the computed matrix to match the mapping tables in docs/spec/05-facets.md. The first snapshot reflected the adapters as declared and differed from the tables. The orchestrator ruled that the spec is normative, so the adapters moved, and (review round 1) that one consistent rule applies to every row.

## The rule: the static matrix is a worst-case ceiling

- Every row the 05 tables mark lossy for the pair is declared `constrained` on the target-side canonical field it affects, whether or not the loss depends on the data. This is why `/description` (350 characters), `minApprovals` (above 6) and `deletionExempt` sit beside always-lossy rows.
- Rows decided only at read time stay dynamic, through `FacetRead.capabilities` (`/forking` for an organization that forbids private forks) or `FacetRead.unreadable` (merge-settings `/allowed` and `/deleteBranchOnMerge`, FAC-MRG-002).
- `translated` is never produced statically.
- Paths such as `/rules/pattern`, `/owners`, `/variables/name`, `/hooks/events` and `/secrets/value` are matrix markers for a whole concern, not schema paths. `/secrets/value` in particular is not in the canonical schema; it exists so the matrix can show that the source never returns secret values. Tests pin the source-side markers.

## Declarations

GitHub, `constrained` (lossy): `repository-settings` `/description`; `branch-rules` `/rules/pattern`, `/rules/enforcement`, `/rules/restrictMerges`, `/rules/deletionExempt`, `/rules/changeRequest/minApprovals`, `/rules/changeRequest/requireTasksResolved`; `environments` `/environments/category`; `variables` and `org-variables` `/variables/name`; `webhooks` and `org-webhooks` `/hooks/events`; `code-ownership` `/owners`; `merge-settings` `/allowed`. `minPassingBuilds` stays `unsupported`; `/hooks/secret` stays `unreadable`.

Bitbucket Cloud: `webhooks` and `org-webhooks` `/hooks/secret`, `secrets` and `org-secrets` `/secrets/value`: `unreadable` (FAC-WEB-003, FAC-VAR-001, FAC-SEC-001).

## Runtime readers checked

A declared path that a translator reads at run time would change behaviour. Checked: `/rules/forcePushExempt` (unchanged, `supported`), `/forking` (unchanged), `/hooks/events` (read by the webhooks translator, but only a constraint starting with `only:` acts; the declared text does not, and tests in the registry and the GitHub adapter pin that, so translate behaviour is unchanged), `/files` and the teams membership path (source side, not declared), merge-settings paths (source side, not declared). No other declared path has a runtime reader. The translators emit the lossy findings from the data, not from these declarations.

## Tests

`packages/registry/src/builtin.test.ts` compares the computed Bitbucket Cloud to GitHub cell with a transcription of every lossy, unreadable or unsupported table row, checks each facet cell is the worst of its rows, that no undeclared field exists, and that driver writes match the delivery the tables describe. Each adapter has its own test of the declarations.

## Reading note

`branch-rules` shows `unsupported` as a cell because `minPassingBuilds` is `unsupported` (table: post task `branch-rules.configure-status-checks`). A UI should show the field rows, not only the worst value.
