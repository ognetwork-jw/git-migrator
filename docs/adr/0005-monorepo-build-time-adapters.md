# ADR-0005: Monorepo, build-time adapters

- Status: accepted
- Date: 2026-10-08

## Context

Tools for specific provider pairs should be buildable from the framework, and one default app should host all adapters (Q7c). Runtime plugin loading complicates read-only, non-root images (Q8).

## Decision

Use a pnpm/Turborepo monorepo with framework packages, and a `registry` package composing adapters at build time.

## Consequences

Adding an adapter requires a rebuild and redeploy.
