# ADR-0021: Identity-provider claims mapped to in-app roles

- Status: accepted
- Date: 2026-10-08

## Context

Entra app roles should drive authorization, while future sign-in methods map their own claims (Q77).

## Decision

Config `auth.roleMappings` maps (method, claim, value) to role. The highest wins, no match is denied, and the role re-syncs at sign-in.

## Consequences

Human roles cannot be edited in-app.
