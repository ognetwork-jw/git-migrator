# ADR-0007: ZenStack RPC + Hono custom endpoints

- Status: accepted
- Date: 2026-10-08

## Context

CRUD over models should be free and policy-guarded. Domain commands need explicit endpoints (Q79).

## Decision

Mount the ZenStack RPC handler and Hono `/api/v1` (Zod, OpenAPI) in a single Hono app inside Next.js. No server actions.

## Consequences

Lifecycle fields are denied to RPC writes (API-012). All state changes go through custom endpoints.
