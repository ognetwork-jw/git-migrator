# ADR-0107: Facet guidance coverage is asserted from `testing/integration`

- Status: agent-decided
- Date: 2026-10-08

## Context

FAC-002 and the T-014 follow-up require each facet task to call `assertGuidanceCoverage` with the facet's declared finding codes. ARC-012 gives `facets` only `core` and `canonical`, and `guidance` may not depend on `facets`. `check-deps` allows only `provider-fakes` and `fixtures` as test-only extra dependencies, so a test inside `packages/facets` cannot import `guidance`.

## Decision

The coverage test of T-051 lives in `testing/integration/src/` (which may depend on anything), and `@git-migrator/facets` and `@git-migrator/guidance` are added to that package's `dependencies`. It also checks that each declared code's kind and `(v)` marker agree with the guidance source list. The dependency rules are unchanged. Each facet task can add its own file there, or T-058 can fold them into one registry-level test.

## Alternatives

- Allow `guidance` as a test-only dependency of `facets` in `tools/check-deps.ts`: a rule change outside this task, and parallel facet tasks would conflict on it.
- Wait for T-058 (registry): leaves the facets' coverage unchecked until then.

## Affected requirements

FAC-002, ARC-012, LIF-006.
