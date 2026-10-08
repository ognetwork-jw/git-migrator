# ADR-0140: the facet translate context must be plain JSON

- Status: agent-decided
- Date: 2026-10-08
- Task: T-053
- Affects: ADP-030, ADP-031, FAC-DKY-003

## Context

The facet engine snapshots `route`, `routeIndex`, policies and capabilities before `translate` runs. Its deep clone went through `Object.entries`, which turns a `Map`, `Set` or `Date` into `{}` without an error. FAC-DKY-003 needs deploy-key usage counts from `routeIndex`; a Map-based index would have silently reported no duplicates (docs/followups.md, T-012).

## Decision

The context is plain JSON. The clone throws a `TypeError` for any object whose prototype is not `Object.prototype` or `null`, and `translateFacet` reports it as `FacetEngineError` code `invalid_context`. The deploy-keys facet reads `routeIndex.deployKeyUsage`, a plain `Record<publicKey, number>`.

## Alternatives

- Snapshot once per `translateAll` and deep-freeze without cloning: leaves a shared mutable reference for the caller, and still accepts values that cannot be stored or hashed.
- Extend the clone to Map and Set: the index is persisted and compared between Analyses, so JSON is the only form that survives.
