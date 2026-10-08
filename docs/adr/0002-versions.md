# ADR-0002: Dependency versions

- Status: proposed — completed by T-001
- Date: 2026-10-08

## Context

The spec says "latest stable" for most dependencies (ARC-001).

## Decision

T-001 replaces this file's body with the exact versions chosen on the bootstrap date, and pins them exactly.

## Consequences

Upgrades after bootstrap are deliberate changes with their own ADR.
