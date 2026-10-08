# ADR-0010: Endpoints and Routes defined at deploy time

- Status: accepted
- Date: 2026-10-08

## Context

Only 2 Endpoints exist for now, and credentials live in Key Vault through secretspec (Q64).

## Decision

Endpoints and Routes are config. They are upserted into the DB at migrate time and marked `retired` when removed.

## Consequences

Adding an Endpoint requires a deployment.
