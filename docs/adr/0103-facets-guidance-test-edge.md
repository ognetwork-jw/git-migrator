# ADR-0103: guidance coverage test for the git/settings facets lives in testing/integration

- Status: accepted (no spec change needed)
- Date: 2026-10-08
- Task: T-050
- Affects: ARC-012, FAC-002

## Context

docs/followups.md (T-014) requires each facet task to call `assertGuidanceCoverage` with its facets' declared finding codes. ARC-012 gives `facets` only `core` and `canonical`, and `guidance` only `core` and `canonical`, so neither package may import the other.

## Decision

ARC-012 and `tools/check-deps.ts` are unchanged. The coverage test is `testing/integration/src/facets-git-settings-guidance.test.ts`: `testing/*` may depend on anything, so `@git-migrator/facets` and `@git-migrator/guidance` are listed in `testing/integration/package.json`. The test calls `assertGuidanceCoverage` with every code in the `findingCodes` of `git-refs`, `repository-settings` and `merge-settings`. This is the same rule as the parallel decision in T-051; the two do not depend on each other.

## Alternatives

- Allow `facets` to depend on `guidance` (devDependency, tests only): rejected, it adds an edge ARC-012 does not allow.
- Run the assertion only in `registry`: it lacks the edge as well and runs later than the facet's own change.
