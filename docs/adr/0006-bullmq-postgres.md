# ADR-0006: BullMQ on PostgreSQL

- Status: accepted
- Date: 2026-10-08

## Context

Background work needs retries, delays, priorities and schedulers, without extra infrastructure (Q21).

## Decision

Use BullMQ ≥ 6 with its PostgreSQL backend in schema `bullmq`.

## Consequences

There is no Redis. Throughput is bounded by Postgres, which is ample for about 2,000 repositories.
