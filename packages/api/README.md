# @git-migrator/api

Hono app: routes, OpenAPI, SSE, ZenStack RPC mount.

Declared internal dependencies (ARC-012, checked by `pnpm lint`): @git-migrator/core, @git-migrator/canonical, @git-migrator/db, @git-migrator/auth, @git-migrator/jobs, @git-migrator/registry, @git-migrator/quota, @git-migrator/config, @git-migrator/observability, @git-migrator/guidance, @git-migrator/adapter-sdk.

## What is here (T-021)

`createApiApp(deps)` builds the one Hono app of API-001:

| Path | |
|---|---|
| `/api/auth/*` | `AuthService.handle` (never `auth.handler`, or every Entra sign-in is denied) |
| `/api/model/*` | ZenStack `RPCApiHandler` through `createHonoHandler`, on `db.forActor(actor)` (the allow-list facade) |
| `/api/v1/*` | `@hono/zod-openapi` endpoints; `/api/v1/openapi.json` is the OpenAPI 3.1 document |
| `/api/healthz`, `/api/readyz` | liveness (no database) and readiness (`select 1` plus `deps.ready`) |

Every request to `/api/model/*` and `/api/v1/*` resolves to an Actor (`resolvePrincipal`) or gets a 401 problem. An `Authorization: Bearer gm_...` header is an API key and decides alone; otherwise the Better Auth session is mapped to its Actor by `authUserId`. A disabled Actor is rejected on every request. A session-authenticated write must carry `Origin` equal to `publicUrl`. Name and email always come from the Actor, never from `session.user` (ADR-0171). Request bodies are limited to 1 MiB.

Errors are RFC 9457 `application/problem+json` with `type` `https://git-migrator.invalid/problems/<code>` (`problem.ts`); handlers `throw new ProblemError(code)`. The UI maps `code` to `problem.<code>` in `apps/web/messages/en.json`. List endpoints use `PageQuerySchema` and `toPage` (cursor, `limit` at most 200).

The typed client of the custom endpoints is `createApiClient` from `@git-migrator/api/client` (`hc<AppType>`). Endpoints so far: `GET /me`, `POST /actors`, `PATCH /actors/{id}`, `POST /actors/{id}/api-keys`, `DELETE /api-keys/{id}` (T-021), `GET /events` (T-022) and the batch 1 endpoints below (T-062); later tasks add the rest of API-020. Automation users: see `docs/api-usage.md`. Custom endpoints check `can(actor, capability)` from `@git-migrator/auth` and write their `AuditEvent` in the mutation's transaction.

## Error behaviour (ADR-0202)

Every 4xx and 5xx under `/api/v1` is `application/problem+json`: handlers throw `ProblemError`, other `HTTPException`s are mapped by status, and a middleware rewrites any remaining non-problem error (malformed JSON, wrong content type). On `/api/model/*` an operation the facade does not expose (also inside `$transaction/sequential`) is a 404 problem, every 5xx body is a generic `internal_error` problem, and failed database calls are logged as class, reason, model and SQLSTATE only (`safeErrorFields`, wired through `createDb({ onError })`). `PATCH /actors/{id}` refuses (409 `last_admin`) a change that would leave no enabled admin; it serializes Actor changes with an advisory lock under READ COMMITTED, and a serialization failure or deadlock that still occurs is a 409 `conflict`.

## Events and SSE (JOB-060, ADR-0270)

`GET /api/v1/events?topics=migration:<id>,run:<id>,list:migrations,quota` streams `text/event-stream`. `createEventHub` (`src/events.ts`) fans the events of the process's one `LISTEN gm_events` connection (`createEventListener` in `@git-migrator/db`) out to the streams: each stream keeps at most 64 queued frames (a burst past that becomes one `resync`; a client that reads nothing for 60 s is dropped), ends after about 10 minutes (+-20%) so the client is authenticated again, and is cleaned up on disconnect. Heartbeats stop while the listener is down. At most 16 streams per Actor (`owner`) and 2,000 per process. `run.log` is coalesced to 4 per second per Run. Frames: `event: gm` (`{ type, ids, at, topics }`, only the topics the client named), `event: heartbeat` (with a `: heartbeat` comment, every 15 s), `event: resync` (events may have been missed; refetch all). Either limit answers 429 `too_many_streams`. `createApiApp({ events })` requires the hub; the process owner builds it and closes it on shutdown. Disabling an Actor or revoking a key calls `events.closeOwner(actorId)`.

Publish with `publishEvent(pool, event)` or, inside a ZenStack transaction, `publishEventIn(tx, event)` (both from `@git-migrator/db`); the pure event types and `topicsForEvent` are in `@git-migrator/core`.

## Batch 1: reads and commands (T-062, ADR-0330 to ADR-0332)

`src/batch1.ts` (`createBatch1`, mounted by `createV1` with `.route`): `POST /inventory/refresh` and `POST /migrations/{id}/analyze` (operator; enqueue and answer 202, de-duplicated by `inventory-<endpointId>` and `analysis-<migrationId>`, audited), `GET /dashboard`, `GET /quota`, `GET /capability-matrix`, `GET /migrations/{id}/diff` (viewer) and `POST /routes/{id}/naming/preview` (operator; writes nothing).

- `ApiDeps.services` carries the collaborators these need: `jobs` (a producer-only `JobRuntime`), `quota` and `registry`. The web process builds them in `apps/web/src/server/api.ts`. An endpoint whose service is missing answers 503 `not_ready`.
- `src/redact.ts` redacts Facet data for the diff: strings under sensitive keys, webhook URLs and URL credentials; booleans, numbers and secret names stay (ADR-0331).
- The quota ETA is `backlog x avgCallsPerAnalysis / backgroundRatePerSecond`; the backlog is the Endpoint's queued background analyses (ADR-0332).
- The naming preview takes the target's name limits from `registry.repositoryNameLimits`, so it needs no connection.

## Identity and Group mapping (AUTH-050, T-084)

`src/mapping/` holds the mapping endpoints (decisions in ADR-0320):

| Endpoint | |
|---|---|
| `GET /routes`, `GET /routes/{id}/identity-mappings` (`status`, `q`, cursor), `GET /routes/{id}/group-mappings`, `GET /routes/{id}/target-identities` | reads for the mapping pages (`read`) |
| `POST /routes/{id}/identity-mappings/{mappingId}/{confirm\|exclude\|unmap}` | `decideMappings`; exclusion needs `reason` |
| `POST /routes/{id}/identity-mappings/import[?dryRun=true]` | CSV `source,target,action` as `text/csv`; validated in full, reported per row, applied only when every row is valid |
| `POST /routes/{id}/group-mappings/{mappingId}/{confirm\|rename}` | `decideMappings` |

`csv.ts` parses and checks rows (pure), `resolve.ts` resolves them against Identities (pure), `expected-differences.ts` builds the eight `identity_excluded` patterns of an exclusion, `service.ts` runs the decisions inside one transaction under a per-Route advisory lock, with audit events, and `stale.ts` (`markRouteAnalysesStale`) marks the Route's Analyses stale on every write (swap for T-061's `markAnalysesStale` when it lands). Cells echoed in reports are neutralized against spreadsheet formulas (`neutralizeCell`).
