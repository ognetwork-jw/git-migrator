# ADR-0035: Bitbucket merge settings are read from the main branch (FAC-MRG-002)

- Status: accepted (spec updated)
- Date: 2026-10-08
- Task: T-030
- Affects: FAC-MRG-002, FAC-MRG-001

## Context

FAC-MRG-002 asks whether Bitbucket's REST API exposes the allowed merge strategies and the "close source branch" default per repository, and describes two outcomes: both exposed or both `unreadable`.

The published OpenAPI document (retrieved 2026-10-08) exposes both, through different endpoints:

- `merge_strategies` and `default_merge_strategy` on the `branch` object, from `GET /2.0/repositories/{ws}/{slug}/refs/branches/{name}` (scope `read:repository:bitbucket`). They describe pull requests targeting that branch.
- `default_branch_deletion` on `GET …/branching-model/settings` (scope `admin:repository:bitbucket`), a string `"true"`/`"false"` that is absent from the schema.

The reference does not say whether branch-level values reflect repository- or project-level settings (ADR-0036).

## Decision

Take the first outcome of FAC-MRG-002, with these sources:

- `allowed` = `merge_strategies` of the main branch (`GET …/refs/branches/{mainbranch}`). One extra call per repository.
- `deleteBranchOnMerge` = `default_branch_deletion` (string or boolean accepted).
- `default_merge_strategy` is captured in the raw facet data but has no canonical field in v1.
- Any 403, 404 or missing field makes that field `unreadable`, and the desired value then comes from `routes[].defaults.mergeSettings` with an automatic `unreadable_defaulted` Expected Difference.

FAC-MRG-001 mapping is unchanged. The mapping of `squash_fast_forward` is decided by T-050 (merge-settings facet), likely `squash` and lossy.

## Alternatives

- Treat the facet as unreadable: gives up values the API exposes.
- Read project-level values and merge: inheritance semantics are undocumented.

## Consequences

Call budget grows by one per repository. The adapter needs `read:repository:bitbucket` and `admin:repository:bitbucket` (already required). Live e2e must confirm what the branch-level values reflect.
