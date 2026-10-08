# ADR-0180: Quota service design

- Status: agent-decided
- Date: 2026-10-08
- Task: T-025
- Affects: JOB-040, JOB-041, JOB-042, JOB-043, JOB-044, JOB-045, JOB-046, JOB-047, DEP-050, GLO-002, ARC-012

## Context

JOB-040 to JOB-047 fix the ledger rules but leave open how provider feedback is stored in `QuotaState`, how consecutive secondary-limit hits are counted, how the quota package writes metrics when ARC-012 gives `quota` no edge to `observability`, and where header parsing lives. `QuotaState` has no spare column (the domain schema is normative), so the choices below fit the existing columns and internal companion rows.

## Decision

1. **Neutral feedback, no header parsing in `quota`.** `QuotaService.recordFeedback` takes numbers (`limit`, `windowSeconds`, `remaining`, `resetAt`, `observedSince`, `fixedWindow`, `nearLimit`). Adapters read their provider's headers (GLO-002) and call it. A bucket per provider `resource` is one bucket key per resource.
2. **Reported use is a floor, never a replacement.** The local sliding-window count (JOB-041) always applies. While a provider report is live (`resetAt` in the future), `used = max(slidingCount, (limit − remaining) + eventsSince(observedSince))`. Feedback can therefore only make the service more conservative. `QuotaState` holds the report's `limitPerWindow`, `windowSeconds`, `remaining` and `resetAt`; while it is live its limit replaces the configured one. Once `resetAt` passes, the configured limit is written back and `remaining` is cleared, so `quota.overrides` changes always take effect and reported use cannot linger.
3. **`observedSince`.** A granted `acquire` returns the database stamp it used (`AcquireResult.at`). The adapter passes the stamp of the request whose response carried the report as `observedSince`; events at or after it are added to the reported use. Adapters MUST pass it (follow-up for the adapter tasks). The service clamps `observedSince` to at most the database now under the lock, so a future value cannot hide earlier events, and `resetAt` to at most now + window + 60 s, so a far-future value cannot lock a bucket. The floor can still under-count requests that were acquired before the reporting request and are in flight when the report arrives, by at most the number of requests in flight on the bucket, which the concurrency cap (JOB-045) and the safety margin bound; no further machinery is built for this. Within one window, out-of-order reports keep the smallest `remaining` with the `observedSince` of the report that supplied it, a report without `remaining` keeps the stored live `remaining` and `observedSince` (feedback never makes the service less conservative), and a report whose `resetAt` is older than the stored one is ignored.
4. **Fixed windows.** A rolling window is never reset by feedback. When the adapter declares `fixedWindow: true`, events before `resetAt` stop counting once it passes (the provider's window really reset). While the report is live the sliding floor still applies.
5. **Near-limit clamp.** `nearLimit` is a background-only clamp with an expiry (`resetAt`, default now + window), "until the window advances" (JOB-043). It sets the background ceiling to 0, never touches `remaining` or the interactive count, survives later limit-only feedback, and is exposed as `BucketSnapshot.nearLimit` and `backgroundClampedUntil`. It lives with the fixed-window flag and `observedSince` in an internal companion row `<bucketKey>#feedback` (`limitPerWindow` = fixed flag, `resetAt` = observedSince, `blockedUntil` = clamp expiry).
6. **Secondary-limit counter.** Consecutive hits (JOB-045) are counted in an internal `QuotaState` row keyed `<bucketKey>#secondary-hits`: hit count in `limitPerWindow`, expiry (end of block + 15 min) in `resetAt`. A hit before expiry doubles the wait (60 s, 120 s, ... cap 15 min); `retry-after` wins when given, clamped to 15 min. A hit that arrives while a block is active keeps that block and does not raise the counter, so simultaneous responses count once. Bucket keys may not contain `#`; snapshots and the pruning window maximum ignore keys with `#`.
7. **429 without Retry-After.** `blockedUntil = max(oldestEventInWindow + window, now + minBlockSeconds)`; an empty window blocks one window. A given `Retry-After` is validated (finite, not negative) and clamped to 24 h. A block is never shortened (`GREATEST`).
8. **Units.** A request may cost several units (git commands, JOB-041): `count + units <= ceiling`. For one unit this is exactly `count < ceiling`.
9. **Metrics sink.** `quota` has no edge to `observability` in the ARC-012 table. `QuotaService` takes a structural `QuotaMetricsSink { setQuotaUsed, setQuotaLimit }`, which `MetricRecorders` satisfies, so the process wiring passes the observability recorders in. Gauges are updated on every acquire and by `exportMetrics()` (JOB-047).
10. **Pruning.** `QuotaService.prune()` deletes events older than 2 × the longest `windowSeconds` in `QuotaState` (3600 s when none) and expired leases. The job runtime (T-028) calls it from `maintenance.prune`.
11. **Locks and clock.** Advisory locks are `pg_advisory_xact_lock(hashtextextended('gm-quota:' || key, 0))`, taken one key at a time in ascending key order inside the transaction, with `lock_timeout` 10 s surfaced as the retryable `QuotaLockTimeoutError`. A connection whose rollback fails is destroyed, not returned to the pool. Every window start and event stamp uses the database `clock_timestamp()` read after the locks are held, so pods with skewed clocks agree. The `now` option of the services is a test seam only; production never passes it.
12. **Background ETA.** The backlog (pending analyses) is not known to `quota`. It exports `estimateBackgroundEtaSeconds` and `BucketSnapshot.backgroundRatePerSecond`; the API composes the response.
13. **Input checks.** Bucket keys must parse with `parseBucketKey` (so `#` is rejected). `acquire` throws on an empty list. `selectCredential` throws on a candidate with no buckets, because it would otherwise look infinitely free. Feedback and Retry-After numbers are validated like `BucketSpec`.

## Alternatives

- Treating reported use as a replacement for the ledger: rejected, because repeated near-limit reports then let far more than the limit through.
- A new `QuotaState` column for the near-limit flag and hit counter: rejected, because it changes the normative schema for a small gain.
- In-memory secondary-limit counters: rejected, because pods would disagree.
- Importing `observability` into `quota`: rejected, because ARC-012 forbids it.

## Consequences

Adapters (T-030, T-031, T-041, T-042) parse headers and call the neutral API, passing `observedSince`. The sliding count bounds each window at the effective limit; the reported floor adds a margin that can under-count only requests still in flight. After a declared fixed-window reset the sliding count is deliberately not applied to pre-reset events.
