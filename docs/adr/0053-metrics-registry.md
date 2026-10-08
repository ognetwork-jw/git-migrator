# ADR-0053: Prometheus registry, metric labels and the metrics server

- Status: accepted (spec updated)
- Date: 2026-10-08
- Affects: DEP-050, ADP-060, JOB-047, AUTH-020

## Context

DEP-050 names eight metrics (`gm_provider_requests_total`, `gm_provider_request_duration_seconds`, `gm_quota_used{bucket,pool}`, `gm_quota_limit{bucket}`, `gm_runs_total{kind,status}`, `gm_run_duration_seconds{kind}`, `gm_migrations{route,status,readiness}`, `gm_queue_jobs{queue,state}`) and the Node default metrics. The provider labels are given by ADP-060 (`docs/spec/04-adapter-contract.md`): `gm_provider_requests_total{provider,endpoint,bucket,status}`, and the duration metric is named there without a label list. DEP-050 gives no bucket layout. JOB-047 says the quota gauges are "the same values" as the quota API.

## Decision

- **Labels for provider metrics (ADP-060):** `provider` (the adapter type), `endpoint` (the configured Endpoint id), `bucket` (the quota bucket charged, JOB-040) and `status` (the HTTP status as text, typed as `${number}`). `gm_provider_request_duration_seconds` takes the same four labels, because ADP-060 names it without a label list and a histogram that differs from its counter could not be joined with it. Provider-native paths, repository names and HTTP methods are never labels. Endpoint ids and buckets are bounded by configuration and by the adapter's classifier, so cardinality is bounded.
- **Quota pools:** `pool` is typed `'background' | 'interactive'` (JOB-041). Bucket names are the quota service's resource group names.
- **Run kinds and statuses, route, readiness, queue and state** are the enumerations of the domain and BullMQ states. The registry does not validate them; callers use the enumerations.
- **Histogram buckets:** provider requests 50 ms to 30 s; runs 1 s to 4 h. These cover the observed ranges (a git push can take an hour).
- **Default metrics:** `collectDefaultMetrics` is registered on the same registry, so `process_*` and `nodejs_*` names come with the gm metrics.
- **Typed recorders.** prom-client's label arguments accept any string. Application code therefore writes metrics only through `MetricRecorders` (`recordProviderRequest`, `setQuotaUsed`, `setQuotaLimit`, `recordRun`, `setMigrations`, `setQueueJobs`). Pool is `'background' | 'interactive'`, and HTTP status is `${number}`; a value outside these types fails to compile, and the tests prove it with `@ts-expect-error`. The raw metrics stay readable for scraping and tests, not for writing.
- **Registry per process:** `createMetrics(registry?)` creates the metrics on the given registry. A second call on the same registry throws, because prom-client refuses duplicate names; this catches a double import early.
- **Server:** `startMetricsServer` is a plain `node:http` server on its own port (default 9464, bound on all interfaces so the scraper can reach the pod). It serves `GET /metrics` (and `HEAD`), returns 404 for every other path and 405 for other methods. It does not use Hono, so `observability` keeps no framework dependency, and the API never serves metrics (AUTH-020).

## Migration target and revisit trigger

prom-client `15.1.3` is kept (ADR-0002 pin). npm marks it deprecated. The replacement under review is `@prometheus-io/client` (currently `0.16.1`, pre-1.0). Revisit when `@prometheus-io/client` reaches 1.0 with a stable label API, or when prom-client has a security advisory without a fix. The migration is a separate task and needs its own ADR; the recorder API above is the seam that keeps the switch local to `metrics.ts`.

## Alternatives

- OpenTelemetry metrics through the OTLP exporter: DEP-050 says Prometheus, and a second metrics pipeline would double the export path. Rejected.
- Using the Hono app for `/metrics`: couples the metrics surface to the API process and its auth middleware. Rejected; the spec keeps metrics off the API.
- Summaries instead of histograms: cannot be aggregated across pods. Rejected.

## Affected requirements

DEP-050, ADP-060, JOB-047, AUTH-020.
