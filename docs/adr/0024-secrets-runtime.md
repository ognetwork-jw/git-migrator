# ADR-0024: secretspec + Key Vault via workload identity

- Status: accepted
- Date: 2026-10-08

## Context

Production secrets live in Key Vault, Postgres uses a password (Q63a), and Blob isn't used.

## Decision

The entrypoint runs `secretspec run --provider akv://<vault>?auth=workload_identity`. The Postgres connection string is assembled from config plus `POSTGRES_PASSWORD`.

## Consequences

Workload identity is required from day one for Key Vault access.
