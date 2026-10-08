# @git-migrator/observability

Logging, tracing and metrics for every entrypoint (DEP-050): the pino JSON logger with secret redaction, the Prometheus registry and metrics server, and the OpenTelemetry tracing setup.

Status: implemented by T-004. Decisions are recorded in [ADR-0052](../../docs/adr/0052-log-redaction.md) (redaction), [ADR-0053](../../docs/adr/0053-metrics-registry.md) (metrics) and [ADR-0054](../../docs/adr/0054-tracing-export-policy.md) (tracing).

Declared internal dependencies (ARC-012, checked by `pnpm lint`): none.

## Logging

```ts
import { createLogger } from '@git-migrator/observability';

const log = createLogger({ level: config.observability.logLevel, service: 'worker' });
const runLog = log.child({ component: 'run-executor', runId, migrationId });
runLog.info({ steps: 4 }, 'run started');
```

- One JSON object per line on standard output, with `level`, `time` (ISO 8601), `msg`, `service`, `traceId` (when a span is active) and the bound fields such as `component`, `runId`, `migrationId` and `jobId` (DEP-050).
- Every value is scrubbed before it is written: the message, the arguments, the bound fields of `child()` loggers and nested objects. See [ADR-0052](../../docs/adr/0052-log-redaction.md) for the rules.
- An `Error` is written under `err` (type, scrubbed message and stack). When the call has no message, the error message becomes `msg`.
- `redactValue` and `redactString` are exported for code that formats text for other destinations.

Redacted, by structure first: the whole value of `Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key` and `X-Auth-Token` lines; the value of any key whose name contains a secret word (`password`, `token`, `secret`, `credential`, `api_key`, `sig`, `code`, `session`, …), in `key=value`, quoted and escaped JSON forms, and query strings; `Bearer`, `Basic` and `Digest` credentials; private key blocks (to their END marker); JWTs and known token shapes; URL userinfo.

Percent-encoded text is scrubbed as written and then at up to three decoded levels, each decoded from the level before it after that level was scrubbed, so decoding can only add redactions (the chained scrub). Encoded quotes (`%22`), escaped quotes at any JSON depth (`\"`, `\\\"`) and Unicode or encoded spaces are understood.

Positional arguments after the message (`log.info('tok %s', value)`) are written as `[REDACTED]`. Pass values as fields instead. Strings longer than 64 KiB are cut before scanning. See [ADR-0052](../../docs/adr/0052-log-redaction.md).

Never log a credential on purpose. Redaction is the second line of defence; provider clients must not place credentials in logged values.

## Metrics

```ts
import { createMetrics, startMetricsServer } from '@git-migrator/observability';

const { registry, metrics } = createMetrics();
metrics.runsTotal.inc({ kind: 'migrate', status: 'succeeded' });
const server = await startMetricsServer({ registry, port: config.metrics.port });
```

`createMetrics` registers the Node default metrics and the DEP-050 metrics:

| Metric | Type | Labels |
|---|---|---|
| `gm_provider_requests_total` | counter | `provider`, `endpoint`, `bucket`, `status` (ADP-060) |
| `gm_provider_request_duration_seconds` | histogram | `provider`, `endpoint`, `bucket`, `status` (ADP-060) |
| `gm_quota_used` | gauge | `bucket`, `pool` (`background` or `interactive`) |
| `gm_quota_limit` | gauge | `bucket` |
| `gm_runs_total` | counter | `kind`, `status` |
| `gm_run_duration_seconds` | histogram | `kind` |
| `gm_migrations` | gauge | `route`, `status`, `readiness` |
| `gm_queue_jobs` | gauge | `queue`, `state` |

`startMetricsServer` serves `GET /metrics` on its own port (default 9464, DEP-050). Other paths return 404 and other methods return 405. Call `close()` on shutdown. The API never serves metrics (AUTH-020).

The Helm chart's NetworkPolicy must restrict port 9464 to the metrics scraper; the endpoint has no authentication of its own.

## Tracing

```ts
import { startTracing } from '@git-migrator/observability';

const tracing = startTracing({
  serviceName: config.observability.serviceName,
  otlpEndpoint: config.observability.otlpEndpoint,
  instrumentations: [bullmqInstrumentation], // optional: the job runtime adds its own (T-028)
});
// on shutdown:
await tracing.shutdown();
```

- Call `startTracing` once, before servers and queues start, so the HTTP and PostgreSQL instrumentations can patch their modules.
- HTTP server and outgoing HTTP and PostgreSQL are instrumented. BullMQ job instrumentation is passed in through `instrumentations` by the job runtime (T-028, ADR-0054).
- Spans are exported over OTLP/HTTP to `<otlpEndpoint>/v1/traces` only when `otlpEndpoint` is set. Without it, spans are created in memory (so logs still carry `traceId`) and discarded.
- Metrics and logs are never sent through OpenTelemetry. `OTEL_*` exporter variables are not read.

## Layout

- `src/redact.ts`: string and value scrubbing, and the pino `redact` paths.
- `src/logger.ts`: `createLogger`, the pino configuration and the argument scrub.
- `src/metrics.ts`: the `prom-client` registry and the DEP-050 metrics.
- `src/metrics-server.ts`: `GET /metrics` on its own port.
- `src/tracing.ts`: the OpenTelemetry Node SDK configuration and lifecycle.
