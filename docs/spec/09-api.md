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

- **Model data:** ZenStack-generated TanStack Query hooks (`@zenstackhq/tanstack-query`) against `/api/model`.
- **Custom endpoints:** the Hono typed client (`hc<AppType>`), exported from `packages/api/client`.
- **External automation:** the OpenAPI document. The ZenStack RPC protocol is documented by linking to ZenStack's RPC handler docs in `docs/api-usage.md` (written by T-062).

## When to add a custom endpoint (API-010)

Use the ZenStack RPC API whenever policy-guarded CRUD over models is enough. A custom `/api/v1` endpoint is required when an operation:

1. changes lifecycle state or other privileged fields (DOM-011);
2. enqueues jobs or touches a provider;
3. spans multiple models with domain rules (state machine, Expected Difference creation, audit); or
4. returns computed data not stored as a model.

**API-011** Custom endpoints validate input and output with Zod, and errors use RFC 9457 `application/problem+json` with `type` URIs `https://git-migrator.invalid/problems/<code>`. List endpoints use cursor pagination (`cursor`, `limit` ≤ 200). Every 4xx and 5xx under `/api/v1` is `application/problem+json`, including those from framework code (`bad_request` 400, `unsupported_media_type` 415). The RPC mount answers an operation it does not expose with 404, and every 5xx with a generic `internal_error` that carries no internal message (ADR-0202).

**API-012 RPC write allow-list.** All models are default-deny for writes through RPC (DOM-005). The only RPC writes permitted are:

- `Wave`: create, update, delete (operator).
- `Migration.waveId`: update (operator).
- `NamingRule`, `WebhookAllowlistEntry`, `Overlay`: create, update, delete (admin). The server marks affected Analyses stale via a ZenStack after-mutation hook.
- `ManualTask.note`: update (operator).

Primary keys are immutable through RPC.

Everything else is read-only through RPC, including Actor, ApiKey, mappings, invitations, Expected Differences and ManualTask status, and changes only through `/api/v1`. API keys' `hash` is denied for **read** to every role, admin included, because no AUTH-020 row grants it; key verification (AUTH-040) reads it with the server-only client. RawResponse bodies are denied for read to viewers (ADR-0122).

## Custom endpoints (API-020)

All are under `/api/v1`. The required role is shown in brackets.

| Method & path | Body / query | Effect |
|---|---|---|
| `POST /inventory/refresh` [operator] | `{endpointId?}` | Enqueue inventory |
| `POST /migrations/{id}/analyze` [operator] | — | Enqueue interactive analysis |
| `POST /migrations/{id}/runs` [operator] | `{kind, options?, confirm?}` | Create a Run (LIF-040 to LIF-043). 409 if one is active. 422 if readiness disallows it (for example `migrate` on non-ready). |
| `POST /runs/{id}/cancel` [operator] | — | Cooperative cancel. The Run checks for cancellation between steps. |
| `POST /migrations/{id}/complete` [operator] | `{reason}` | LIF-075 |
| `DELETE /migrations/{id}/complete` [operator] | — | Revoke |
| `POST /migrations/{id}/tasks/{taskId}/{done\|reopen\|dismiss}` [operator] | `{note?}` | Updates the task. Triggers parity. |
| `POST /migrations/{id}/expected-differences` [operator] | `{facetKey, path, note}` | `manual_accepted` |
| `DELETE /expected-differences/{id}` [operator] | — | Revoke (sets `revokedAt`) |
| `POST /migrations/{id}/drift/accept` [operator] | `{note}` | Accept all current drift diffs (LIF-065) |
| `POST /migrations/bulk` [operator] | `{ids? , filter?, action, waveId?}` | LIF-090. Returns `{accepted:[], skipped:[{id, reason}]}`. |
| `POST /routes/{id}/endpoint-migration/analyze` · `/runs` [operator] | as above | LIF-080 |
| `POST /routes/{id}/identity-mappings/{mappingId}/{confirm\|exclude\|unmap}` [operator] | `{targetIdentityId?, reason?}` | AUTH-050 |
| `POST /routes/{id}/identity-mappings/import` [operator] | CSV text | AUTH-050 step 3. `?dryRun=true` validates only. |
| `POST /routes/{id}/group-mappings/{mappingId}/{confirm\|rename}` [operator] | `{targetGroupId?, plannedSlug?}` | |
| `POST /routes/{id}/invitation-batches` [operator] | `{identityIds? , all?}` | Create a draft with a seat preview |
| `POST /invitation-batches/{id}/items/{itemId}/{select\|deselect}` [operator] | `{reason?}` | AUTH-060 step 3 |
| `POST /invitation-batches/{id}/approve` [operator] | — | Approve and enqueue sending |
| `POST /routes/{id}/naming/preview` [operator] | `{rule}` | Names and collisions for the rule |
| `GET /migrations/{id}/diff` [viewer] | `?facetKey` | Latest ParityResult and Snapshots side by side |
| `GET /quota` [viewer] | — | JOB-047 |
| `GET /capability-matrix` [viewer] | — | Facet × source → target fidelity from registry capabilities. Returns `{adapters, rows, ceiling: "static"}`: one row per Facet in dependency order, one cell per ordered pair of distinct adapters with `fidelity`, `read`, `write`, `override` and per-field `{path, source, target, fidelity}` (ADR-0260). |
| `GET /dashboard` [viewer] | — | Aggregated counts (UI-020) |
| `POST /actors` [admin] | `{displayName, role}` | Create a service Actor |
| `PATCH /actors/{id}` [admin] | `{disabled?, role?}` | `role` is only allowed for service Actors. 409 `last_admin` if the change would leave no enabled admin Actor (service Actors count). 409 `conflict` for self-disable and for a serialization failure. 422 for an empty body. Actor changes run one at a time. |
| `POST /actors/{id}/api-keys` [admin] | `{name, expiresAt?}` | Returns the key once. 422 unless `expiresAt` is in the future. |
| `DELETE /api-keys/{id}` [admin] | — | Revoke |
| `GET /events` [viewer] | `?topics=` | SSE (JOB-060). 1 to 50 topics; an unknown topic is 422 `validation_failed`. 429 `too_many_streams` with `Retry-After: 5` over the stream limits. |

Each endpoint has an integration test that covers its role requirement (403 for insufficient role) and its main success path (API-021).
