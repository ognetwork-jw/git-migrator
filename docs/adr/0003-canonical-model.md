# ADR-0003: Canonical model with pair overrides

- Status: accepted
- Date: 2026-10-08

## Context

Pairwise translators scale as N² providers and spread provider knowledge everywhere.

## Decision

Adapters convert provider data to and from versioned canonical Facet documents. Facet definitions translate canonical → canonical, driven by declared capabilities. Pair overrides are allowed where semantics need provider-pair knowledge (v1: pipelines).

## Consequences

Adding a provider means one adapter. Canonical schemas must be expressive enough for every provider, which costs some up-front design.
