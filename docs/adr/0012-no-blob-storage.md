# ADR-0012: No blob storage in v1

- Status: accepted
- Date: 2026-10-08

## Context

Mirror bundles and log archives were declined (Q35). Git work uses local scratch.

## Decision

Do not wire `@flystorage/file-storage` or Azurite in v1. If file storage becomes necessary, use flystorage with the Azure Blob adapter, and in-memory in dev (Q36).

## Consequences

Less infrastructure. Run logs live in Postgres.
