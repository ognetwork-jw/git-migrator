# @git-migrator/quota

Rate-limit buckets, sliding-window ledger and credential selection (JOB-040 to JOB-047). Provider-neutral: adapters parse their provider's headers and pass plain numbers in (ADR-0180).

Internal dependencies (ARC-012): `@git-migrator/db`, `@git-migrator/core`. Metrics go through a structural `QuotaMetricsSink`, which `MetricRecorders` from `packages/observability` satisfies.

## API

- `bucketKey(endpointId, accountKey, resourceGroup)` builds `<endpointId>:<accountKey>:<resourceGroup>` (JOB-040). Credentials of one account pass the same `accountKey` and share the bucket.
- `new QuotaService({ pool, tuning?, metrics?, now? })`, with `pool` being `DbHandle.pool`:
  - `acquire(buckets, 'background' | 'interactive')` takes the advisory locks (ascending key order), counts the window, and records one `QuotaEvent` per unit, all buckets or none (JOB-041). A denial carries `reason` (`blocked`, `pool`, `limit`) and `retryAt` for `moveToDelayed` (JOB-044).
  - `recordFeedback(...)`: provider-reported limit, remaining, reset, near-limit, `fixedWindow` and `observedSince` (JOB-043, JOB-045). Reported use is a floor under the local sliding count. Adapters MUST pass `observedSince`: the `at` stamp that `acquire` returned for the request whose response carried the report. The floor can under-count requests acquired before that request and still in flight, by at most the number in flight on the bucket (bounded by the JOB-045 concurrency cap and the safety margin).
  - `recordRateLimited(...)` (429, JOB-044), `recordSecondaryLimit(...)` (JOB-045), `adjust(bucket, pool, delta)` (GraphQL cost reconcile).
  - `freeCapacity`, `snapshot`, `exportMetrics` (JOB-047); `prune` (JOB-046).
- `QuotaLeases`: cross-pod in-flight cap on `quota_lease` (JOB-045).
- `selectCredential(quota, candidates, pool)` picks the credential with the most free capacity (JOB-042).
- `estimateBackgroundEtaSeconds` for the quota API (JOB-047).

Time comes from the database clock, read after the lock is held. The `now` option is a test seam only.

Defaults: `safetyFactor` 0.95, `backgroundShare` 0.9. A bucket's configured limit comes from the adapter (`endpoints[].quota.overrides`, JOB-043).

Tests run against a throw-away Postgres database (`@git-migrator/db/testing`) in the unit tier.
