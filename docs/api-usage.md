# Using the API from automation

git-migrator has two HTTP interfaces under one origin. Both authenticate the same way, both enforce the same roles, and both answer errors in a form a script can read.

| Interface | Path | Use it for |
|---|---|---|
| Model API (RPC) | `/api/model/*` | Policy-guarded reads of any model, and the few writes API-012 allows (Waves, naming rules, allowlist entries, Overlays, task notes). |
| Custom endpoints (v1) | `/api/v1/*` | Everything that changes lifecycle state, enqueues work, or returns computed data. Described by an OpenAPI 3.1 document at `/api/v1/openapi.json`. |
| Events | `/api/v1/events` | Server-sent events, so a script can wait for work instead of polling. |

Use the Model API to read data and v1 to act. The Model API cannot start an analysis, create a Run, or change a status; those are v1 commands.

## Credentials

Automation uses a service Actor with an API key.

1. An administrator creates the service Actor: `POST /api/v1/actors` with `{"displayName": "ci", "role": "operator"}`. The role is `viewer`, `operator` or `admin`.
2. The administrator issues a key: `POST /api/v1/actors/{id}/api-keys` with `{"name": "nightly", "expiresAt": "2027-01-01T00:00:00Z"}` (`expiresAt` is optional and must be in the future). The response carries the full key, `gm_...`, **once**. Store it in your secret store; it cannot be read again.
3. Send it on every request: `Authorization: Bearer gm_...`.

A key acts as its Actor with that Actor's role. Revoke it with `DELETE /api/v1/api-keys/{id}`, or disable the Actor with `PATCH /api/v1/actors/{id}`; both take effect on the next request. Keys are not accepted on `/api/auth/*`. Never put a key in a URL, a command line shown to other users, or a log.

| Role | May |
|---|---|
| `viewer` | Read everything except raw response bodies, Snapshot data, Analysis translations and the secret parameters of Plan items and tasks, which may hold webhook URLs with credentials (ADR-0503). `GET /api/v1/migrations/{id}/diff` shows Snapshots and the desired state redacted. |
| `operator` | Everything a viewer may, plus analyze, run, manage tasks and Waves, decide mappings and preview naming rules. |
| `admin` | Everything an operator may, plus naming rules, the webhook allowlist, Overlays, Actors and keys. |

A request without a valid credential is 401; a valid one with too low a role is 403.

## Model API (RPC)

Operations follow the pattern `/{model}/{operation}`, where `model` is the lower-camel model name (`migration`, `run`, `manualTask`, `wave`) and `operation` is one of `findMany`, `findUnique`, `findFirst`, `count`, `aggregate`, `groupBy`, `create`, `update`, `delete` and so on. The protocol and its query language (`where`, `include`, `select`, `orderBy`, `take`, `skip`, `cursor`) are the ZenStack RPC API; see [the ZenStack documentation of the RPC API handler](https://zenstack.dev/docs/service/api-handler/rpc) for the full contract.

- Reads are `GET` with the arguments as URL-encoded JSON in `q`: `GET /api/model/migration/findMany?q={"where":{"status":"analyzed"},"take":50}`. Responses are `{"data": ...}`. When values need rich types, a `meta.serialization` member describes them (SuperJSON); plain scripts can ignore it for strings, numbers and booleans.
- Writes are `POST`, `PUT`, `PATCH` or `DELETE` with a JSON body, for example `POST /api/model/wave/create` with `{"data": {"name": "wave-2"}}`.
- An operation or model the API does not expose is 404. Every model is read-only unless API-012 lists the write. A denied operation is 403, and a request that breaks a policy is answered without revealing why.

Paging with the Model API uses `take` and `cursor`, not the v1 envelope below.

## Custom endpoints (v1)

All v1 paths in this document are relative to `/api/v1`. Bodies are JSON with `content-type: application/json`; the largest body is 1 MiB.

### Reads

| Request | Role | Returns |
|---|---|---|
| `GET /dashboard` | viewer | Counts per Route by status and readiness, per Wave (`wavesTruncated` when over 200), the endpoint Migration's state, and the last 20 Runs. Quota gauges are not included: call `GET /quota`. |
| `GET /quota` | viewer | Per bucket: limit, used in the window, the background/interactive split, `blockedUntil`, the queued background analyses and the ETA in seconds to drain them, plus `backlogTotal` and `backlogTruncated` (true when the per-Endpoint split is partial). |
| `GET /capability-matrix` | viewer | `{adapters, rows, ceiling: "static"}`: per Facet, per ordered pair of adapters, the best fidelity the declared capabilities allow. A real analysis can be worse. |
| `GET /migrations/{id}/diff?facetKey=` | viewer | The latest Analysis per Facet: source Snapshot, desired state, target Snapshot, field decisions, the latest parity result and the active Expected Differences. Secret-looking values are replaced with `[REDACTED]` and hook URLs are cut to their origin. `facetKey` narrows to one Facet. |

### Commands

| Request | Role | Effect |
|---|---|---|
| `POST /inventory/refresh` | operator | Enqueue an inventory pass. Body `{"endpointId": "..."}` is optional; without it every active Endpoint is refreshed. Answers 202 `{"endpoints": [...]}`. 404 for an unknown Endpoint, 409 for a retired one. |
| `POST /migrations/{id}/analyze` | operator | Enqueue an interactive analysis. 202 `{"migrationId": "...", "queue": "analysis-interactive"}`. 409 when the Migration's source is missing. A running Migration may be analyzed. |
| `POST /routes/{id}/naming/preview` | operator | Evaluate a candidate naming rule against a Route without saving it. Body `{"rule": {"scope": "namespace" \| "repository", "scopeRef": "...", "pipeline": {...}}}`, or `"override": "name"` instead of `pipeline` at repository scope. Returns the planned names next to the current ones, collisions and findings, and takes `cursor` and `limit`. |

Commands that enqueue answer **202 Accepted**: the work is queued, not done. Asking twice does not queue twice (queued jobs are de-duplicated), so retrying a command after a timeout is safe. Watch the result with events, or poll the model (`migration`, `analysis`).

A script that triggers and waits for an analysis:

```sh
curl -sS -X POST -H "Authorization: Bearer $GM_KEY" "$GM_URL/api/v1/migrations/$ID/analyze"
# then either subscribe to events (below) or poll:
curl -sS -H "Authorization: Bearer $GM_KEY" \
  "$GM_URL/api/model/migration/findUnique?q=$(printf '{"where":{"id":"%s"},"select":{"latestAnalysisId":true,"analysisStaleAt":true}}' "$ID")"
```

### Pagination

List endpoints take `cursor` and `limit` (1 to 200, default 50) and return `{"items": [...], "nextCursor": "..." | null}`. Pass `nextCursor` back as `cursor` until it is `null`. Cursors are opaque; do not build or parse them.

### Errors (problem types)

Every 4xx and 5xx under `/api/v1` is `application/problem+json` (RFC 9457):

```json
{
  "type": "https://git-migrator.invalid/problems/forbidden",
  "title": "Insufficient role",
  "status": 403,
  "code": "forbidden",
  "detail": "requires the operate capability"
}
```

Branch on `code`, never on `title` or `detail`. A 422 `validation_failed` also lists `errors: [{path, message}]`.

| `code` | Status | Meaning |
|---|---|---|
| `bad_request` | 400 | Malformed request (for example invalid JSON). |
| `unauthenticated` | 401 | No valid session or API key. |
| `forbidden` | 403 | The role is too low. |
| `origin_not_allowed` | 403 | A browser session wrote from another origin. Not relevant to API keys. |
| `not_found` | 404 | Unknown path or object. |
| `conflict` | 409 | The state forbids it (for example analyzing a Migration whose source is missing). Retry only after the state changes. |
| `last_admin` | 409 | The change would leave no enabled administrator. |
| `payload_too_large` | 413 | Body over 1 MiB. |
| `unsupported_media_type` | 415 | Not `application/json`. |
| `validation_failed` | 422 | The body or query is invalid; see `errors`. |
| `too_many_streams` | 429 | Too many open event streams; honour `Retry-After`. |
| `internal_error` | 500 | A server fault. The body never carries internal detail; report the time and the request. |
| `not_ready` | 503 | The server is starting up, the queue or database is unreachable, or a service this endpoint needs is not configured. Retry after the `Retry-After` seconds, with backoff. |

The Model API answers an operation it does not expose with 404 and any server fault with 500 `internal_error`.

## Events (SSE)

`GET /events?topics=a,b,c` keeps a connection open and sends `text/event-stream`. Name 1 to 50 topics:

- `migration:<id>`, `run:<id>`, `task:<id>`, `endpoint:<id>`, `invitation:<id>` for one object;
- `quota`;
- `list:migrations`, `list:runs`, `list:tasks`, `list:repositories`, `list:invitations` for a whole list.

An unknown topic is 422. The frames are:

| Frame | Meaning |
|---|---|
| `event: gm` | `data: {"type", "ids", "at", "topics"}`. `type` is one of `migration.updated`, `run.updated`, `run.log`, `task.updated`, `inventory.progress`, `quota.updated`, `invitation.updated`. `ids` holds identifiers only. |
| `event: heartbeat` | Every 15 seconds. |
| `event: resync` | Events may have been missed (the stream was slow, or the server reconnected). Refetch everything you watch. |

Events never carry data: when one arrives, read the object again through the Model API or v1 (that is also where permissions are checked). A stream ends after about ten minutes so the credential is checked again; reconnect and refetch. There are at most 16 streams per Actor; beyond that, or over the per-process limit, the answer is 429 `too_many_streams` with `Retry-After: 5`.

```sh
curl -sSN -H "Authorization: Bearer $GM_KEY" \
  "$GM_URL/api/v1/events?topics=migration:$ID,list:runs"
```

## The OpenAPI document

`GET /api/v1/openapi.json` (any role) returns the OpenAPI 3.1 description of every v1 endpoint, with request and response schemas, security schemes and the problem schema. Generate a client from it, or load it into your tooling. The document describes v1 only; the Model API follows the RPC protocol linked above.

## Habits that keep automation safe

- Use the lowest role that does the job: a reporting script needs `viewer`.
- Give each integration its own key with an expiry, and rotate it.
- Treat 202 as "queued"; confirm the outcome with events or a read.
- Back off and retry on 429 and 503; do not retry other 4xx errors without changing the request.
- Do not log response bodies of the diff endpoint into shared systems unless you must; values are redacted, but the structure still describes your repositories.
