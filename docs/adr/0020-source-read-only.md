# ADR-0020: Source read-only on Bitbucket

- Status: accepted
- Date: 2026-10-08

## Context

Bitbucket has no archive. The default post-migration action is read-only (Q13, Q57).

## Decision

Add a push restriction on `*` with nobody allowed, and prefix the description with `[MIGRATED → url]`. Both are Mutations, undoable.

## Consequences

Tags remain writable on the source. This is documented in guidance.
