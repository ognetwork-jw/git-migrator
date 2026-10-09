# ADR-0332: Dashboard and quota views

- Status: accepted (spec updated)
- Date: 2026-10-09
- Task: T-062
- Affects: API-020, UI-020, JOB-047, JOB-020, JOB-040

## Context

`GET /dashboard` is "Aggregated counts (UI-020)" and `GET /quota` points at JOB-047: per bucket the limit, used in window, pool split, `blockedUntil`, the background backlog and an ETA. UI-020 names what the page shows but not the response; JOB-047 does not say how a backlog that belongs to an Endpoint is assigned to buckets (a bucket key is `<endpointId>:<accountKey>:<resourceGroup>`, a queued analysis names none of those).

## Decision

- **Dashboard.** `{generatedAt, routes, waves, recentRuns}`. Per active (not retired) Route: `total`, `byStatus` and `byReadiness` over its repository-scope Migrations (a Migration without readiness counts as `unanalyzed`), and the endpoint Migration's id, status and readiness (UI-020 "Endpoint migration status"). Per Wave: its repository Migrations by status. The last 20 Runs. At most 200 Waves are listed (by name) and `wavesTruncated` says more exist. Counts are database `groupBy` aggregates, so the cost does not grow with the number of repositories. Quota gauges are not repeated here: the page calls `GET /quota`.
- **Quota.** `snapshot()` of the quota service, per bucket: key parts, `limit`, `effectiveLimit`, `windowSeconds`, `used`, the pool split (`backgroundLimit`, `usedBackground`, `usedInteractive`), `remaining`, `resetAt`, `blockedUntil`, `nearLimit`, `backgroundRatePerSecond`, and the two derived values below. Dates are ISO strings.
- **Backlog.** Waiting, delayed and prioritized jobs of the `analysis-background` queue (at most 10,000 are read, as the feeder does; active jobs already spent their calls), grouped by the source Endpoint of their Migration's Route. Every bucket of that Endpoint reports the Endpoint's backlog, because an analysis spends calls in several resource groups and accounts and the queue cannot say which. The calls per analysis are the Route's `avgCallsPerAnalysis` (30 when unset), averaged over the queued analyses.
- **Totals.** `backlogTotal` comes from the queue's job counts (the whole queue); the per-Endpoint split reads at most 10,000 jobs, and `backlogTruncated` is true when the queue is longer, so the bucket backlogs and ETAs are partial.
- **ETA.** `backlog x avgCallsPerAnalysis / backgroundRatePerSecond` through `estimateBackgroundEtaSeconds`, in seconds; 0 when nothing is queued and `null` when the bucket has no background capacity.
- **Authorization.** `read` (viewer) for both.

## Alternatives

- Compute the dashboard from `findMany` in the client: loads every Migration and breaks with thousands of repositories.
- Split the backlog across buckets by the share of their free capacity: invents a precision the data does not have.
