# 09 — API

## Composition (API-001)

One Hono app (`packages/api`) is mounted in Next.js at `apps/web/app/api/[[...route]]/route.ts` (Node.js runtime, using Hono's Next.js `handle` adapter). It contains:

| Path | Purpose |
|---|---|
| `/api/auth/*` | Better Auth handler |
| `/api/model/*` | ZenStack RPC API: `createHonoHandler` + `RPCApiHandler`, with `getClient` returning the policy-enforcing client bound via `$setAuth(actor)` |
| `/api/v1/*` | Custom endpoints, defined with `@hono/zod-openapi`. OpenAPI 3.1 document at `/api/v1/openapi.json`. |
| `/api/v1/events` | SSE (JOB-060) |
| `/api/healthz` | Liveness: process up. No DB access. |
| `/api/readyz` | Readiness: DB reachable (`select 1`) and config loaded |

No Next.js server actions are used (API-002). Next.js pages fetch data only through the clients described below.

## Clients (API-003)

- **Model data:** a thin hand-written RPC client in the web app (`findMany` with the arguments as JSON in `q`, `createRow`, `updateRow` with PUT, and `deleteRow`) against `/api/model`. There are no generated hooks (ADR-0360).
- **Custom endpoints:** the Hono typed client (`hc<AppType>`), exported from `packages/api/client`. The web app also uses its `apiRequest` helper (GET, POST, PATCH, PUT, DELETE; a 204 resolves to `undefined`), and the RPC client is built on it, so every refusal carries the problem `code`.
- **External automation:** the OpenAPI document. The ZenStack RPC protocol is documented by linking to ZenStack's RPC handler docs in `docs/api-usage.md` (written by T-062).

## When to add a custom endpoint (API-010)

Use the ZenStack RPC API whenever policy-guarded CRUD over models is enough. A custom `/api/v1` endpoint is required when an operation:

1. changes lifecycle state or other privileged fields (DOM-011);
2. enqueues jobs or touches a provider;
3. spans multiple models with domain rules (state machine, Expected Difference creation, audit); or
4. returns computed data not stored as a model.

The process that mounts the app injects the services the endpoints need: a producer-only job runtime, the quota service and the registry. A missing service, a queue outage or a lost database connection answers 503 `not_ready` with `Retry-After: 5` and no detail of the fault. A service is never silently skipped (ADR-0330, ADR-0415).

**API-011** Custom endpoints validate input and output with Zod, and errors use RFC 9457 `application/problem+json` with `type` URIs `https://git-migrator.invalid/problems/<code>`. List endpoints use cursor pagination (`cursor`, `limit` ≤ 200). Every 4xx and 5xx under `/api/v1` is `application/problem+json`, including those from framework code (`bad_request` 400, `unsupported_media_type` 415). The RPC mount answers an operation it does not expose with 404, and every 5xx with a generic `internal_error` that carries no internal message (ADR-0202). Domain codes beside the generic ones:
- 409: `run_active`, `run_not_permitted`, `revoke_first`, `last_admin`.
- 422: `readiness_required`, `confirmation_required`.
- 503: `not_ready`, `busy`.

Each code has a UI text (ADR-0320, ADR-0370, ADR-0415).

**API-012 RPC write allow-list.** All models are default-deny for writes through RPC (DOM-005). The only RPC writes permitted are:

- `Wave`: create, update, delete (operator).
- `Migration.waveId`: update (operator).
- `NamingRule`, `WebhookAllowlistEntry`: create, update, delete (admin). The server marks every Migration of the Route stale through a database trigger, not a policy-client hook (the Actor cannot write `Migration`).

`Overlay` is read-only through RPC for every role, admin included. The RPC mount has no per-model validation hook, so it cannot meet DOM-003. Overlays are written only through `/api/v1/overlays` (API-020), and the staleness trigger fires there as well (ADR-0362).
- `ManualTask.note`: update (operator).

Primary keys are immutable through RPC.

Everything else is read-only through RPC, including Actor, ApiKey, mappings, invitations, Expected Differences and ManualTask status, and changes only through `/api/v1`. API keys' `hash` is denied for **read** to every role, admin included, because no AUTH-020 row grants it; key verification (AUTH-040) reads it with the server-only client. RawResponse bodies are denied for read to viewers (ADR-0122).

## Custom endpoints (API-020)

All are under `/api/v1`. The required role is shown in brackets.

| Method & path | Body / query | Effect |
|---|---|---|
| `POST /inventory/refresh` [operator] | `{endpointId?}` | Enqueue inventory. 202 `{endpoints}`. Without a body every `active` Endpoint, sources and targets; an unknown Endpoint is 404, a retired one 409. Deduplicated per Endpoint (ADR-0330). |
| `POST /migrations/{id}/analyze` [operator] | — | Enqueue interactive analysis. 202 `{migrationId, queue}`, also when deduplicated. 409 `conflict` for `source_missing`; every other status is accepted (ADR-0330). |
| `POST /migrations/{id}/runs` [operator] | `{kind, options?, confirm?}` | Create a Run (LIF-040 to LIF-043). 409 if one is active. 422 if readiness disallows it (for example `migrate` on non-ready). Goes through the Run guard (DOM-010), then enqueues. If the enqueue fails and the Run could be cancelled, the answer is 503 `not_ready`; if a worker already started it, 202 (ADR-0415). |
| `POST /runs/{id}/cancel` [operator] | — | Cooperative cancel. The Run checks for cancellation between steps. 200 with `cancelled` or `requested` (LIF-046); 409 for a finished Run. |
| `POST /migrations/{id}/complete` [operator] | `{reason}` | LIF-075 |
| `DELETE /migrations/{id}/complete` [operator] | — | Revoke |
| `POST /migrations/{id}/tasks/{taskId}/{done\|reopen\|dismiss}` [operator] | `{note?}` | Updates the task. Triggers parity. `dismiss` MUST set `completedById` (LIF-020 step 6). Allowed moves and completion modes: LIF-006. |
| `POST /migrations/{id}/expected-differences` [operator] | `{facetKey, path, note}` | `manual_accepted`. The Facet must be registered and the path a valid pattern (422). An identical active record is 409. Marks the Migration stale (LIF-021). |
| `DELETE /expected-differences/{id}` [operator] | — | Revoke (sets `revokedAt`). Only `manual_accepted`, `lossy_accepted`, `overlay` and `unreadable_defaulted` records can be revoked; `identity_excluded`, `framework_mutation`, already revoked records and rows owned by a done `accept` task are 409. There is no edit: revoke and create (ADR-0415). |
| `POST /migrations/{id}/drift/accept` [operator] | `{note}` | Accept all current drift diffs (LIF-065) |
| `POST /migrations/bulk` [operator] | `{ids? , filter?, action, waveId?}` | LIF-090. Returns `{accepted:[], skipped:[{id, reason}]}`. At most 200 per request (422 above). |
| `POST /routes/{id}/endpoint-migration/analyze` · `/runs` [operator] | as above | LIF-080 |
| `GET /routes` [viewer] | — | Routes for the mapping pages (ADR-0320) |
| `GET /routes/{id}/identity-mappings` [viewer] | `?status&q&cursor&limit` | Mappings with source and target Identity and exclusion reason |
| `GET /routes/{id}/group-mappings` [viewer] | — | Group Mappings with member counts and a collision flag |
| `GET /routes/{id}/target-identities` [viewer] | `?q` | Target Identity search for "change target" |
| `POST /routes/{id}/identity-mappings/{mappingId}/{confirm\|exclude\|unmap}` [operator] | `{targetIdentityId?, reason?}` | AUTH-050 |
| `POST /routes/{id}/identity-mappings/import` [operator] | CSV text | AUTH-050 step 3. `?dryRun=true` validates only. |
| `POST /routes/{id}/group-mappings/{mappingId}/{confirm\|rename}` [operator] | `{targetGroupId?, plannedSlug?}` | |
| `GET /routes/{id}/invitation-candidates` [viewer] | — | AUTH-060 step 1 (ADR-0370) |
| `POST /routes/{id}/invitation-batches` [operator] | `{identityIds? , all?}` | Create a draft with a seat preview |
| `GET /invitation-batches` [viewer] | `?routeId&status&cursor` | Batch list |
| `GET /invitation-batches/{id}` [viewer] | `?status` | The batch with counts and a page of entries (with suggestions for `sent` entries) |
| `POST /invitation-batches/{id}/items/{itemId}/{select\|deselect}` [operator] | `{reason?}` | AUTH-060 step 3 |
| `POST /invitation-batches/{id}/items/{itemId}/revoke` [operator] | — | Enqueue the revoke step (AUTH-060 step 4) |
| `POST /invitation-batches/{id}/items/{itemId}/resolve` [operator] | `{outcome: invited\|not_invited}` | Settle an `unknown` entry (AUTH-060 step 4) |
| `POST /invitation-batches/{id}/approve` [operator] | `{expectedToken, expectedCount?}` | Approve and enqueue sending |
| `POST /routes/{id}/naming/preview` [operator] | `{rule}` | Names and collisions for the rule. `rule` is `{scope, scopeRef, pipeline \| override}`, exactly one of the last two (LIF-030). |
| `GET /migrations/{id}/diff` [viewer] | `?facetKey` | Latest ParityResult and Snapshots side by side. Per Facet of the latest Analysis (registry dependency order): source data, desired data and field decisions, target data, unreadable paths and fetch times, the newest ParityResult, and the active Expected Differences. An unknown `facetKey` is 422. Values under sensitive keys are `[REDACTED]`, but booleans, numbers and `null` stay; webhook URLs reduce to their origin; other strings are scrubbed. Raw responses, Snapshot hashes and raw response ids are never returned (ADR-0331). |
| `GET /quota` [viewer] | — | JOB-047 |
| `GET /capability-matrix` [viewer] | — | Facet × source → target fidelity from registry capabilities. Returns `{adapters, rows, ceiling: "static"}`: one row per Facet in dependency order, one cell per ordered pair of distinct adapters with `fidelity`, `read`, `write`, `override` and per-field `{path, source, target, fidelity}` (ADR-0260). |
| `GET /dashboard` [viewer] | — | Aggregated counts (UI-020): `{generatedAt, routes, waves, recentRuns}`. Per active Route: totals by status and by readiness (`unanalyzed` when unset) over repository Migrations, and the endpoint Migration's status and readiness. Per Wave (at most 200, by name, `wavesTruncated` beyond that): members by status. The last 20 Runs. Computed with database aggregates (ADR-0332). |
| `POST /overlays` [admin] | `{routeId, facetKey, data, enabled?}` | Create an Overlay, validated per LIF-048 (ADR-0362) |
| `PATCH /overlays/{id}` [admin] | `{data?, enabled?}` | Update an Overlay, validated per LIF-048 |
| `DELETE /overlays/{id}` [admin] | — | Delete an Overlay |
| `POST /actors` [admin] | `{displayName, role}` | Create a service Actor |
| `PATCH /actors/{id}` [admin] | `{disabled?, role?}` | `role` is only allowed for service Actors. 409 `last_admin` if the change would leave no enabled admin Actor (service Actors count). 409 `conflict` for self-disable and for a serialization failure. 422 for an empty body. Actor changes run one at a time. |
| `POST /actors/{id}/api-keys` [admin] | `{name, expiresAt?}` | Returns the key once. 422 unless `expiresAt` is in the future. |
| `DELETE /api-keys/{id}` [admin] | — | Revoke |
| `GET /events` [viewer] | `?topics=` | SSE (JOB-060). 1 to 50 topics; an unknown topic is 422 `validation_failed`. 429 `too_many_streams` with `Retry-After: 5` over the stream limits. |

Each endpoint has an integration test that covers its role requirement (403 for insufficient role) and its main success path (API-021).

Roles above are the minimum; handlers check the matching AUTH-020 capability through `can()`: runs, cancel and analyze need the run capability; complete and revoke need mark-complete; tasks and Expected Differences need the task capability; assign and remove in bulk need the Waves capability; invitation commands need the invitation capability; Overlays need the rules capability (ADR-0330, ADR-0362, ADR-0370, ADR-0407, ADR-0415).
