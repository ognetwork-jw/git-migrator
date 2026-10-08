# 07 — Jobs, Workers, Quota and Events

## Queues (JOB-010)

BullMQ runs with its PostgreSQL backend in schema `bullmq`, registered process-wide via `setDefaultBackendFactory(createPostgresBackend)`. It uses a dedicated `pg.Pool` whose `search_path` includes `bullmq`.

| Queue | Jobs | Consumed by |
|---|---|---|
| `inventory` | `inventory.endpoint`, `inventory.namespace` | worker-standard |
| `analysis-interactive` | `analysis.migration` (user-triggered) | worker-standard |
| `analysis-background` | `analysis.migration` (feeder) | worker-standard |
| `runs-standard` | `run.execute` for `sizeClass = standard`, all endpoint Runs, all non-git Runs (verify, rollback, source read-only) | worker-standard |
| `runs-large` | `run.execute` for `sizeClass = large` with git steps | worker-large |
| `parity` | `parity.migration`, `drift.sweep` | worker-standard |
| `maintenance` | `maintenance.prune`, `maintenance.scratch-cleanup`, `maintenance.run-reaper`, `analysis.feeder` | worker-standard (leader-scheduled) |

- **JOB-011** Job payloads are Zod-validated on enqueue and on processing. A payload carries IDs only, never secrets. Dedupe uses BullMQ's `deduplication: { id }` option (for example `analysis-<migrationId>`), not custom job IDs, so later enqueues after completion are never silently dropped. Every queue sets `removeOnComplete: { age: 86400 }` and `removeOnFail: { age: 604800 }`.
- **JOB-014** Each process creates **one** shared BullMQ PostgreSQL backend instance and passes it to every Queue, Worker and QueueEvents it constructs, so connection usage stays bounded. T-028 measures the resulting connections per process and records the exact formula in `docs/deployment.md`.
- **JOB-012 Concurrency** per pod comes from config:
  - `worker.standard.concurrency.runs` (default 4)
  - `.analysis` (default 8)
  - `.inventory` (2)
  - `.parity` (4)
  - `worker.large.concurrency.runs` (default 1)

  Provider quota is the real throttle (JOB-040).
- **JOB-013** Failed jobs use BullMQ `attempts: 3` with exponential backoff, except `run.execute`, which manages its own step retries (`attempts: 1`; LIF-042).

## Size classes and scratch (JOB-015)

- `sizeClass = large` when `sizeBytes > sizeClass.largeThresholdBytes` (default 5 GiB) or when size is unknown and the last known LFS bytes exceed the same threshold.
- Scratch directory: `$GM_SCRATCH_DIR/<runId>` (default `/scratch`). It is removed in `finally`, and `maintenance.scratch-cleanup` removes directories older than 24 h at startup and hourly.
- **Disk precheck before `git.prepare`:** estimated need is `sizeBytes × 2.2 + lfsBytes`. If `statfs` free space is lower, the job is delayed 10 minutes. After 6 delays the Run fails with `scratch.insufficient`, and the UI suggests the large class.

## Inventory (JOB-030)

- Lists all Namespaces, Repositories, Identities and Groups per Endpoint, using paged list endpoints with field filtering and the maximum page size.
- Upserts records by `(endpointId, providerId)`. Repositories not seen during a complete pass become `presence = missing`, and their Migrations become `source_missing`.
- Creates missing Migrations (DOM-014).
- Marks Analyses stale when the provider timestamp (`Repository.providerUpdatedAt`, from Bitbucket `updated_on`) changed.
- Runs every `schedules.inventory` (default 6 h) and on demand ("Refresh" button, `POST /api/v1/inventory/refresh`).

## Analysis feeder (JOB-020, JOB-022)

The scheduler leader runs `analysis.feeder` every minute. It enqueues background analyses so that the *background pool* of each source bucket stays busy without exceeding it. The rule is: enqueue `min(freeBackgroundCapacity / avgCallsPerAnalysis, maxBatch)` jobs.

Candidates are picked in this priority order:

1. Wave members never analyzed.
2. Wave members stale.
3. Never analyzed.
4. Stale (oldest `analysisStaleAt` first).

The feeder never selects Migrations in `running`, `verified`, `manually_completed`, `rolled_back` or `source_missing`. Drift checks cover verified ones. The feeder also enqueues the endpoint Migration analysis of each Route after every completed inventory.

`avgCallsPerAnalysis` is a rolling mean stored per Route, starting at 30.

## Quota (JOB-040 … JOB-047)

- **JOB-040 Buckets.** A bucket key is `<endpointId>:<accountKey>:<resourceGroup>`.
  - `accountKey` identifies whose limit is consumed. Bitbucket measures per **user ID**, so two tokens of the same Atlassian account share one bucket. Each Bitbucket credential config declares `accountId`.
  - The adapter classifies each request into a resource group.
- **JOB-041 Sliding-window ledger.** Every request records a `QuotaEvent(bucketKey, pool, at)`. To acquire, a transaction:
  1. takes `pg_advisory_xact_lock(hash(bucketKey))`;
  2. counts events in `[now − window, now]`;
  3. grants if `count < effectiveLimit`, where `effectiveLimit = floor(limit × safetyFactor)`, with `quota.safetyFactor` defaulting to 0.95.

  `count` is **all** events in the window, background and interactive together. A **background** request is granted only while `count < floor(effectiveLimit × quota.backgroundShare)` (default 0.9). An **interactive** request is granted while `count < effectiveLimit`. Interactive work therefore always has at least 10% headroom.

  A request counted in two resource groups (for example `raw-files` and `repository-data`) acquires both buckets in the same transaction, taking advisory locks in ascending bucket-key order to prevent deadlock. It is granted only if both grant.

  **Git commands** don't go through `ProviderHttpClient`. The `git` package pre-acquires units in the `git` bucket before each command: `ls-remote` 1, `fetch`/`clone` 3, `push` 3 per batch, and LFS 1 per 100 objects. LFS batch API calls made by `git-lfs` count here too.
- **JOB-042 Credential selection.** Among an Endpoint's credentials, pick the one whose bucket has the most free capacity for the needed pool and resource group, and use it for the whole job. A git push of one Run uses one credential throughout.
- **JOB-043 Bitbucket limits (no headers).** User-scoped API tokens get no rate-limit headers, so buckets are tracked **only** locally, from Atlassian's documented limits. Rolling 1-hour window, per user ID:

  | Resource group | Requests matched | Limit / hour |
  |---|---|---|
  | `repository-data` | `/2.0/repositories/**` and **any other** `/2.0` or `/1.0` path not listed below | 1,000 |
  | `webhooks` | listing, adding or removing hooks (repository or workspace) | 1,000 |
  | `raw-files` | `/2.0/repositories/*/*/src/**` file downloads, `/downloads` file fetches | 5,000 (also counted in `repository-data`) |
  | `app-properties` | `/properties/**` | 2,000 |
  | `git` | each git smart-HTTP request (ls-remote, fetch, push = one each) | 60,000 |

  Values come from config (`endpoints[].quota.overrides`), so updated Atlassian numbers need no code change. Scaled limits (access tokens on 100+ seat workspaces) are out of scope for user API tokens. If the response headers `X-RateLimit-Limit` or `X-RateLimit-NearLimit` ever appear, the adapter MUST honor them: update `limitPerWindow`, and treat `NearLimit: true` as "≤ 20% remaining" by clamping the background pool to 0 until the window advances.
- **JOB-044 429 handling.**
  - Honor `Retry-After` when present.
  - Otherwise set `QuotaState.blockedUntil = oldestEventInWindow + window`. For Bitbucket that is at least 60 s.
  - The job calls `moveToDelayed(blockedUntil)` and does not sleep.
  - In-flight requests that hit 429 do not count as successful; they still count in the ledger.
- **JOB-045 GitHub.**
  - Primary limits are read from `x-ratelimit-limit/remaining/reset/resource` and stored in `QuotaState`, one bucket per `resource` (`core`, `graphql`, …).
  - With `used = limit − remaining`, the same pool rule as JOB-041 applies: background only while `used < limit × safetyFactor × backgroundShare`, interactive while `used < limit × safetyFactor`.
  - GraphQL requests pre-acquire an estimate of 1 point and reconcile with the reported cost afterwards.
  - Secondary limits are tracked locally:
    - ≤ `github.maxConcurrentRequests` (default 10) in flight per installation across all pods. This is enforced by a Postgres lease table `quota_lease(bucket_key, holder, expires_at)`: a row is inserted per in-flight request with a 60 s expiry, and the insert is refused when the count of unexpired rows reaches the cap;
    - content-creating requests (POST/PATCH/PUT/DELETE) ≤ 80 per minute and ≤ 500 per hour, as separate buckets.
  - A 403/429 with a secondary-limit message waits `retry-after`, or 60 s doubled per consecutive hit (cap 15 min).
- **JOB-046 Pruning.** `maintenance.prune` (every 10 minutes) deletes `QuotaEvent` rows older than 2 × the longest window, and expired `quota_lease` rows. Raw responses and Snapshot and Analysis retention (DATA-020) are pruned by the same job once per hour.
- **JOB-047 Visibility.** `GET /api/v1/quota` returns, per bucket: limit, used in window, pool split, `blockedUntil`, the background backlog (pending analyses) and an ETA (`backlog × avgCallsPerAnalysis ÷ background rate`). The same values are exported as Prometheus gauges.

## Schedules (JOB-050)

The leader registers BullMQ job schedulers from config:

| Key | Default | Job |
|---|---|---|
| `schedules.inventory` | every 6 h | `inventory.endpoint` per Endpoint |
| `schedules.analysisFeeder` | every 1 min | `analysis.feeder` |
| `schedules.analysisStaleAfter` | 7 d | (threshold, not a job; LIF-021) |
| `schedules.runRequiresAnalysisWithin` | 24 h | (threshold, not a job; LIF-021) |
| `schedules.drift` | every 24 h | `drift.sweep` (enqueues `parity.migration` per eligible Migration, spread across the interval) |
| `schedules.endpointParity` | every 24 h | `parity.migration` for endpoint Migrations |
| `schedules.prune` | every 10 min | `maintenance.prune` (JOB-046, DATA-020) |
| `schedules.runReaper` | every 1 min | `maintenance.run-reaper` (LIF-046) |
| `schedules.scratchCleanup` | every 1 h | `maintenance.scratch-cleanup` (all worker pods, not only the leader) |

## Events and SSE (JOB-060)

- Workers and API handlers publish domain events with `NOTIFY gm_events, '<json>'`. The payload is ≤ 7,000 bytes: `{ type, ids, at }`. Types include `migration.updated`, `run.updated`, `run.log`, `task.updated`, `inventory.progress`, `quota.updated`, `invitation.updated`.
- Each web pod holds one dedicated `LISTEN gm_events` connection and fans out to SSE subscribers.
- `GET /api/v1/events?topics=migration:<id>,run:<id>,list:migrations,quota` filters by topic. Events carry IDs only. Clients invalidate the matching TanStack Query keys and refetch through ZenStack or the API, so permissions are enforced on refetch.
- Heartbeat comment every 15 s. Clients reconnect with backoff, and switch to **polling** every 10 s if no event or heartbeat arrives for 45 s, or if `EventSource` is unavailable. They return to SSE after a successful reconnect (Q24).
- `run.log` events are coalesced to at most 4 per second per Run.
