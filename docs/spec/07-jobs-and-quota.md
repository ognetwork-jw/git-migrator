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
- **JOB-014** Each process creates **one** `pg.Pool` (with `search_path` including `bullmq`) and passes it as `connection` to every Queue and Worker it constructs, because BullMQ builds its backend from that option and each backend uses the pool without owning it. QueueEvents are not used. The pool holds `workers + 4` connections (each Worker keeps one for its blocking `LISTEN`), so connection usage stays bounded. T-028 measures the resulting connections per process and records the exact formula in `docs/deployment.md`.
- **JOB-012 Concurrency** per pod comes from config:
  - `worker.standard.concurrency.runs` (default 4)
  - `.analysis` (default 8), applied to each of the two analysis queues so that a saturated background pool never starves interactive analyses
  - `.inventory` (2)
  - `.parity` (4)
  - `worker.large.concurrency.runs` (default 1)

  Provider quota is the real throttle (JOB-040).
- **JOB-013** Failed jobs use BullMQ `attempts: 3` with exponential backoff, except `run.execute`, which manages its own step retries (`attempts: 1`; LIF-042). The backoff starts at 5 s. A job with no registered processor, or whose payload is invalid on processing, fails without retry (ADR-0210).

## Size classes and scratch (JOB-015)

- `sizeClass = large` when `sizeBytes > sizeClass.largeThresholdBytes` (default 5 GiB) or when size is unknown and the last known LFS bytes exceed the same threshold.
- Scratch directory: `$GM_SCRATCH_DIR/<runId>` (default `/scratch`). It is removed in `finally`, and `maintenance.scratch-cleanup` removes directories older than 24 h at startup and hourly. The scratch volume is per pod, so every worker pod cleans on its own timer (the job name stays registered for manual use), and a job removes only its own subdirectory. Credential directories (`.gm-askpass-*`) are swept only when no session of the process owns them and they are older than 10 minutes (ADR-0211, ADR-0240).
- **Disk precheck before `git.prepare`:** estimated need is `sizeBytes × 2.2 + lfsBytes`. The estimate is `ceil(sizeBytes × 2.2) + lfsBytes` in integer arithmetic, and space already reserved by other Runs of the same process but not yet written is subtracted from free space. If `statfs` free space is lower, the job is delayed 10 minutes. After 6 delays the Run fails with `scratch.insufficient`, and the UI suggests the large class.

## Inventory (JOB-030)

- Lists all Namespaces, Repositories, Identities and Groups per Endpoint, using paged list endpoints with field filtering and the maximum page size.
- Upserts records by `(endpointId, providerId)`. Repositories not seen during a complete pass become `presence = missing`, and their Migrations become `source_missing`.
- Creates missing Migrations (DOM-014).
- Marks Analyses stale when the provider timestamp (`Repository.providerUpdatedAt`, from Bitbucket `updated_on`) or the `fullPath` changed, and, for a Route's Migrations, when a mapping change makes a principal resolve differently.
- One pass per Endpoint lists everything under a per-Endpoint lock, and a second pass for the same Endpoint is skipped. Endpoint Migrations are created first, so they exist even when the provider is down. A pass that is interrupted marks nothing missing.
- `source_missing` and `source_present` are level-triggered from `Repository.presence` on every pass. While a Migration is `running`, the event is deferred and sent again by the next pass after the Run finishes.
- A pass that lists zero Namespaces or zero Repositories while present Repositories exist upserts what it saw but marks nothing missing, and reports `suspicious`.
- Identities and Groups are never deleted. Writes that depend on a read are conditional, so an operator decision or a started Run made meanwhile survives (ADR-0280).
- Runs every `schedules.inventory` (default 6 h) and on demand ("Refresh" button, `POST /api/v1/inventory/refresh`).

## Analysis feeder (JOB-020, JOB-022)

The scheduler leader runs `analysis.feeder` every minute. It enqueues background analyses so that the *background pool* of each source bucket stays busy without exceeding it. The rule is: enqueue `min(freeBackgroundCapacity / avgCallsPerAnalysis, maxBatch)` jobs per source Endpoint per tick, with `maxBatch` = 50. `freeBackgroundCapacity` per account is the tightest bucket's `max(0, backgroundLimit - used)` (0 while blocked or clamped), summed over accounts, minus the mean cost of every waiting or delayed background analysis (active ones are already in the ledger). An Endpoint with no bucket yet gets one first batch.

Candidates are picked in this priority order, while their Route's `avgCallsPerAnalysis` fits the remaining budget:

1. Endpoint Migrations that are due: never analyzed, stale, or analyzed before the newest `lastInventoriedAt` of either Endpoint.
2. Wave members never analyzed.
3. Wave members stale.
4. Never analyzed.
5. Stale (oldest `analysisStaleAt` first).

A Migration whose `analysisRetryAt` is in the future is not a candidate. Each failed analysis job records `analysisFailureCount` + 1 and `analysisRetryAt` = now + 5 min doubled per earlier failure, capped at 6 h (database clock). BullMQ retries of one job count once. A successful or skipped Analysis clears the markers. Marking stale clears the retry time but keeps the count. A fault no retry fixes (retired Endpoint, unresolved target namespace) fails without retry.

The feeder never selects Migrations in `running`, `verified`, `manually_completed`, `rolled_back` or `source_missing`. Drift checks cover verified ones. The feeder also enqueues the endpoint Migration analysis of each Route after every completed inventory.

`avgCallsPerAnalysis` is a `Route` column starting at 30, updated after each Analysis as an exponential moving mean (weight 0.1) of the provider requests it made.

## Quota (JOB-040 … JOB-047)

- **JOB-040 Buckets.** A bucket key is `<endpointId>:<accountKey>:<resourceGroup>`.
  - `accountKey` identifies whose limit is consumed. Bitbucket measures per **user ID**, so two tokens of the same Atlassian account share one bucket. Each Bitbucket credential config declares `accountId`.
  - The adapter classifies each request into a resource group.
- **JOB-041 Sliding-window ledger.** Every request records a `QuotaEvent(bucketKey, pool, at)`. To acquire, a transaction:
  1. takes `pg_advisory_xact_lock(hash(bucketKey))`;
  2. counts events in `[now − window, now]`, where `now` is the database clock read after the lock is held, so clock skew between pods cannot over-grant (ADR-0180);
  3. grants if `count < effectiveLimit`, where `effectiveLimit = floor(limit × safetyFactor)`, with `quota.safetyFactor` defaulting to 0.95.

  `count` is **all** events in the window, background and interactive together. A **background** request is granted only while `count < floor(effectiveLimit × quota.backgroundShare)` (default 0.9). An **interactive** request is granted while `count < effectiveLimit`. Interactive work therefore always has at least 10% headroom.

  A request counted in two resource groups (for example `raw-files` and `repository-data`) acquires both buckets in the same transaction, taking advisory locks in ascending bucket-key order to prevent deadlock. It is granted only if both grant.

  **Git commands** don't go through `ProviderHttpClient`. The `git` package pre-acquires units in the `git` bucket before each command: `ls-remote` 1, `fetch`/`clone` 3, `push` 3 per attempt (a retry spends again), and LFS 1 per 100 objects not yet transferred. LFS batch API calls made by `git-lfs` count here too.
- **JOB-042 Credential selection.** Among an Endpoint's credentials, pick the one whose bucket has the most free capacity for the needed pool and resource group, and use it for the whole job. A git push of one Run uses one credential throughout.
- **JOB-043 Bitbucket limits (no headers).** User-scoped API tokens get no rate-limit headers, so buckets are tracked **only** locally, from Atlassian's documented limits. Rolling 1-hour window, per user ID:

  | Resource group | Requests matched | Limit / hour |
  |---|---|---|
  | `repository-data` | `/2.0/repositories/**` and **any other** `/2.0` or `/1.0` path not listed below | 1,000 |
  | `webhooks` | listing, adding or removing hooks (repository or workspace) | 1,000 |
  | `raw-files` | `/2.0/repositories/*/*/src/**` file downloads, `/downloads` file fetches | 5,000 (also counted in `repository-data`) |
  | `app-properties` | `/properties/**` | 2,000 |
  | `git` | each git smart-HTTP request (ls-remote, fetch, push = one each) | 60,000 |

  Values come from config (`endpoints[].quota.overrides`), so updated Atlassian numbers need no code change. Scaled limits (access tokens on 100+ seat workspaces) are out of scope for user API tokens. If the response headers `X-RateLimit-Limit` or `X-RateLimit-NearLimit` ever appear, the adapter MUST honor them: update `limitPerWindow`, and treat `NearLimit: true` as "≤ 20% remaining" by clamping the background pool to 0 until the window advances. The clamp affects only the background pool; it never lowers the local count (ADR-0180).
- **JOB-044 429 handling.**
  - Honor `Retry-After` when present.
  - Otherwise set `QuotaState.blockedUntil = oldestEventInWindow + window`. For Bitbucket that is at least 60 s.
  - The job calls `moveToDelayed(blockedUntil)` and does not sleep.
  - In-flight requests that hit 429 do not count as successful; they still count in the ledger.
- **JOB-045 GitHub.**
  - Primary limits are read from `x-ratelimit-limit/remaining/reset/resource` and stored in `QuotaState`, one bucket per `resource` (`core`, `graphql`, …).
  - With `used = limit − remaining`, the same pool rule as JOB-041 applies: background only while `used < limit × safetyFactor × backgroundShare`, interactive while `used < limit × safetyFactor`.
  - Reported usage is a floor, never a replacement: `used = max(local sliding count, (limit − remaining) + events acquired since the reporting request)`. Feedback can only make the service more conservative. The adapter passes the acquire time of the request whose response carried the headers; the service caps it at its own clock, and caps a reported reset at one window ahead. Requests acquired earlier and still in flight may be under-counted, bounded by the concurrency cap and the safety margin (ADR-0180).
  - GraphQL requests pre-acquire an estimate of 1 point and reconcile with the reported cost afterwards.
  - Secondary limits are tracked locally:
    - ≤ `github.maxConcurrentRequests` (default 10) in flight per installation across all pods. This is enforced by a Postgres lease table `quota_lease(bucket_key, holder, expires_at)`: a row is inserted per in-flight request with a 60 s expiry, and the insert is refused when the count of unexpired rows reaches the cap;
    - content-creating requests (POST/PATCH/PUT/DELETE) ≤ 80 per minute and ≤ 500 per hour, as separate buckets.
  - A 403/429 with a secondary-limit message waits `retry-after`, or 60 s doubled per consecutive hit (cap 15 min).
- **JOB-046 Pruning.** `maintenance.prune` (every 10 minutes) deletes `QuotaEvent` rows older than 2 × the longest window, and expired `quota_lease` rows. Raw responses and Snapshot and Analysis retention (DATA-020) are pruned by the same job once per hour in each process, in chunks of 1,000 rows. A Snapshot or Analysis that is protected (a Run, or a Migration's latest) is re-checked in the deleting statement (ADR-0211).
- **JOB-047 Visibility.** `GET /api/v1/quota` returns, per bucket: limit, used in window, pool split, `blockedUntil`, the background backlog (pending analyses) and an ETA (`backlog × avgCallsPerAnalysis ÷ background rate`). The same values are exported as Prometheus gauges.

## Schedules (JOB-050)

The leader registers BullMQ job schedulers from config. The leader holds a Postgres advisory lock through a dedicated connection; only `standard` and `all` workers take part, and `large` workers never lead. The leader re-reconciles its schedulers every 5 minutes, because endpoint Migrations are created by inventory after start-up, and removes schedulers no longer wanted (ADR-0211).

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

- Workers and API handlers publish domain events with `NOTIFY gm_events, '<json>'`. The payload is ≤ 7,000 bytes: `{ type, ids, at }`. Types include `migration.updated`, `run.updated`, `run.log`, `task.updated`, `inventory.progress`, `quota.updated`, `invitation.updated`. `ids` is an object keyed by kind (`migration`, `run`, `task`, `endpoint`, `invitation`), each value matching `^[A-Za-z0-9_-]{1,64}$`; larger payloads are refused.
- Each web pod holds one dedicated `LISTEN gm_events` connection and fans out to SSE subscribers.
- `GET /api/v1/events?topics=migration:<id>,run:<id>,list:migrations,quota` filters by topic (1 to 50). Topics are `quota`, `list:migrations`, `list:runs`, `list:tasks`, `list:repositories`, `list:invitations` and `<kind>:<id>`; a Run change also reaches `migration:<id>` when `ids.migration` is set. Events carry IDs only, so any role with `read` may subscribe. Clients invalidate the matching TanStack Query keys and refetch through ZenStack or the API, so permissions are enforced on refetch.
- Every 15 s the server sends the comment `: heartbeat` and a named `heartbeat` event, because scripts cannot see comments; the client's 45 s watchdog resets on the named event. Clients reconnect with backoff, and switch to **polling** every 10 s if no event or heartbeat arrives for 45 s, or if `EventSource` is unavailable. They return to SSE after a successful reconnect (Q24).
- `run.log` events are coalesced to at most 4 per second per Run: the first goes out at once, and later ones in the next 250 ms are merged into one trailing event.
- **Gaps.** When the listener's connection is lost and re-established, and on every successful connect, the hub sends `event: resync` to every stream and clients invalidate every topic they show. While the listener is not connected, no heartbeats are sent, so clients fall back to polling. The listener checks its connection every 30 s.
- **Bounds.** A stream queues at most 64 frames; a burst past that is replaced by one `resync`. A client that reads nothing for 60 s while frames wait is dropped. A process serves at most 2,000 streams and one Actor at most 16 (429 `too_many_streams`). A stream ends after 10 minutes ±20%, and the client reconnects with jittered backoff and is authenticated again. Disabling an Actor or revoking a key ends its streams on the handling process at once and on other pods within that lifetime (ADR-0270).
