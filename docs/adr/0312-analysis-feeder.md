# ADR-0312: Analysis feeder

- Status: accepted (spec updated)
- Date: 2026-10-08
- Task: T-061
- Affects: JOB-020, JOB-022, JOB-040, JOB-041, JOB-011, JOB-047

## Context

JOB-020 gives the rule `min(freeBackgroundCapacity / avgCallsPerAnalysis, maxBatch)` but not what "free capacity" is when an Endpoint has several buckets and accounts, what `maxBatch` is, how already queued analyses are accounted for, or when the endpoint Migration is analyzed.

## Decision

- **Free capacity of a source Endpoint.** From `QuotaService.snapshot()`: for each bucket of the Endpoint, `max(0, backgroundLimit - used)`, and 0 while the bucket is blocked or clamped by a near-limit signal. Per account (credentials of one account share buckets) the tightest bucket counts, because an analysis touches several resource groups and the narrowest one limits it; the accounts' values are summed (JOB-040: independent limits, JOB-042 picks the freest). The adapter's resource groups are not named, so this is conservative.
- **Unknown capacity.** An Endpoint with no bucket yet gets one first batch (`maxBatch x` the largest Route mean). The analyses create the buckets, and the next tick reads real numbers.
- **Backlog.** Background analyses that are waiting or delayed (read from the `analysis-background` queue, at most 10,000) have not spent their calls yet, so their cost (the Route mean each) is subtracted from the capacity, known or not. Active ones are not charged: their calls are already in the ledger as they make them (charging them too would count them twice); they are still never candidates again. Otherwise a full queue would keep growing every minute. A pending Migration is never a candidate again; the dedupe id `analysis-<migrationId>` is the second guard (JOB-011).
- **`maxBatch`** is 50 per Endpoint per tick, a code constant (`DEFAULT_MAX_BATCH`; `FeederDeps.maxBatch` overrides it in tests). The spec names it without a config key.
- **Candidates**, in this order: endpoint Migrations that are due, wave members never analyzed, wave members stale, never analyzed (oldest first), stale (oldest `analysisStaleAt` first). Statuses `running`, `verified`, `manually_completed`, `rolled_back` and `source_missing` and repositories whose source is not `present` are never selected (JOB-022). An endpoint Migration is due when it was never analyzed, is stale, or is older than the newest `lastInventoriedAt` of either Endpoint ("after every completed inventory", JOB-020), so no hook into the inventory job is needed.
- **Failures.** An `AnalysisError` (a fault no retry fixes: retired Endpoint, unresolved target namespace, invalid naming default, unregistered provider) is raised as `UnrecoverableError`, so BullMQ makes no further attempts, and every such check runs before the first provider call. The handler records the attempt **before** it runs, on the first attempt of a job: `analysisFailureCount` + 1, `analysisFailedAt` = now and `analysisRetryAt` = now + 5 minutes doubled per earlier failure, capped at 6 hours (all database clock). BullMQ retries of the same job do not count again. When the job's last attempt fails, `analysisFailedAt` and `analysisRetryAt` are restamped from that moment, so a slow failing attempt does not shorten its own backoff; the start marker stays for a worker that dies. A shutdown interruption takes the recorded attempt back (count - 1, and the timestamps cleared when it was the first). A successful Analysis clears all three, and an Analysis that is skipped (missing, retired) clears them too, so what stays is a job that failed or whose worker died, and a deterministic crash backs off like any other failure. The feeder filters `analysisRetryAt IS NULL OR <= now` in SQL, so Migrations in a long backoff cannot crowd out healthy ones. Anything that marks the Route stale (the staleness trigger, `syncConfig`, `markAnalysesStale`) clears `analysisFailedAt` and `analysisRetryAt` so a fix is tried at once, but **keeps `analysisFailureCount`**: the next failure resumes at the previous backoff step and only a success resets it.
- **One clock.** The feeder compares stale marks, failure times and "analyzed before the last inventory" with the database clock; `Analysis.createdAt`, the staleness triggers and, now, `Repository.lastInventoriedAt` (inventory reads the database clock unless a test clock is injected) are all written with it.
- **Spending.** Candidates are taken in order while their Route's `avgCallsPerAnalysis` fits in the remaining budget and fewer than `maxBatch` are picked. Enqueue goes through `JobRuntime.enqueueAnalysis(id, 'background')` (background queue, dedupe id).
- The handler replaces the placeholder of ADR-0212; `maintenance.ts` no longer lists `analysis.feeder` as pending.

## Alternatives

- Per-resource-group accounting: needs the classifier of each adapter, which the host cannot see (ADR-0281).
- A database counter of queued analyses: duplicates what the queue knows.

## Affected requirements

JOB-011, JOB-020, JOB-022, JOB-040, JOB-041, JOB-047.
