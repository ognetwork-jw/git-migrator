# ADR-0360: Configuration and admin pages read and write through the ZenStack RPC mount

- Status: accepted (spec updated)
- Date: 2026-10-09
- Task: T-091
- Affects: UI-030, UI-031, UI-032, UI-034, UI-035, API-012, AUTH-021, AUTH-022

## Context

UI-030 to UI-035 show NamingRule, WebhookAllowlistEntry, Overlay, Actor, ApiKey and AuditEvent rows. API-012 allows RPC writes for the first three (admin) and reads for all of them, and says Actor and ApiKey change only through `/api/v1`. API-020 has no list endpoint for Actors, API keys or audit events, and the orchestrator asked not to invent large endpoints. The web app has no generated ZenStack hooks (`@zenstackhq/tanstack-query` is not installed), and the mapping pages use `apiRequest` only.

## Decision

- `apps/web/src/model/rpc.ts` is a thin client over `/api/model` with four functions: `findMany` (arguments as JSON in `q`), `createRow` (`{data}`), `updateRow` (`{where, data}` with PUT), `deleteRow` (`{where}` in `q`). It uses `apiRequest`, so a refusal carries the problem `code` like any other call.
- Reads of the configuration and audit pages go through `findMany`. Writes of NamingRule and WebhookAllowlistEntry go through the RPC mount, which runs the policies and the RPC audit plugin (AUTH-022). The server marks Migrations stale through the database trigger (ADR-0310), so the client does not. Overlay writes go to `/api/v1/overlays` (ADR-0362).
- Actor and API-key writes use `/api/v1` (`POST /actors`, `PATCH /actors/{id}`, `POST /actors/{id}/api-keys`, `DELETE /api-keys/{id}`). Actor and API-key reads use RPC. The key list never selects `hash`, which API-012 denies for read.
- `apiRequest` gained PATCH, PUT and DELETE, and a 204 answer resolves to `undefined`.

## Alternatives

- Generated TanStack hooks from `@zenstackhq/tanstack-query`: a new dependency and generation step for six pages. Rejected for this task.
- New `/api/v1` list endpoints for Actors, keys and audit events: API-020 has none, and the orchestrator asked for no large endpoints.

## Consequences

Every read of these pages is policy-checked by the server. The client relies on the RPC protocol of ZenStack 3.9 (`packages/api` mounts the handler).
