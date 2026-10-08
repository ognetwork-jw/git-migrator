# ADR-0009: Typed JSON for snapshots, relational for everything else

- Status: accepted
- Date: 2026-10-08

## Context

The user asked whether Postgres tables should replace JSONB for facet data (Q84/Q86).

## Decision

Use relational tables for queried, filtered, constrained and state-bearing data. Facet Snapshots and translations are ZenStack typed JSON, validated by Zod. Any filterable value is promoted to a column (DOM-001, DOM-002).

## Consequences

New Facets need no core migration. Ad-hoc SQL over facet internals is harder, which is mitigated by promotion.
