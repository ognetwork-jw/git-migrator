# ADR-0022: Test sign-in for automated and e2e runs

- Status: accepted
- Date: 2026-10-08

## Context

Automating Entra login is brittle (Q66).

## Decision

Better Auth email/password is enabled only by `auth.testSignIn.enabled`. Startup aborts if it's enabled in production.

## Consequences

The live e2e doesn't exercise Entra. A manual smoke step covers it.
