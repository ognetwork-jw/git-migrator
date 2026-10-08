# ADR-0054: Tracing starts without export; OTLP export only when configured

- Status: agent-decided
- Date: 2026-10-08
- Affects: DEP-050, JOB-010

## Context

DEP-050 says the OpenTelemetry Node SDK exports "only when `observability.otlpEndpoint` is set", and that HTTP server, outgoing HTTP, pg and BullMQ jobs are instrumented. The SDK's defaults would export metrics and logs over OTLP, and would read `OTEL_*_EXPORTER` variables. Also, when no span processor is configured, the SDK registers no tracer provider, so no trace ids exist for log correlation (DEP-050 `traceId`).

BullMQ tracing is provided by an optional peer of `bullmq` (`bullmq-otel`, listed as an optional peer in ADR-0002). The job runtime is task T-028, which is not started.

## Decision

- **Always start the SDK** with the HTTP and PostgreSQL instrumentations, so trace ids exist and logs can carry `traceId` in every environment.
- **Export only when `otlpEndpoint` is non-empty.** The exporter is an OTLP/HTTP trace exporter with URL `<endpoint>/v1/traces` (trailing slashes removed).
- **Without an endpoint, spans go to an in-process processor that discards them.** A blank endpoint counts as unset.
- **Metrics and logs are never exported through OpenTelemetry.** `metricReaders` and `logRecordProcessors` are passed as empty arrays, which stops the SDK from creating default OTLP readers. Metrics are served by `prom-client` (ADR-0053) and logs go to stdout (ADR-0052).
- **Environment variables are not read** for exporters, because the spec names the one switch (`observability.otlpEndpoint`). Passing explicit processors means `OTEL_TRACES_EXPORTER` has no effect.
- **BullMQ instrumentation is deferred to T-028.** DEP-050 names it. T-028 installs `bullmq-otel` (an optional peer of `bullmq`, see ADR-0002) with its own pin, and T-028's acceptance requires it. This package does not install it. `startTracing` takes an `instrumentations` option, so T-028 passes its BullMQ instrumentation in without changing this module.
- **Caller instrumentations** are added after HTTP and PostgreSQL through the `instrumentations` option.
- **`protobufjs` build is deliberately disabled.** `pnpm-workspace.yaml` sets `allowBuilds: { protobufjs: false }`, because the OTLP log exporter depends on it and pnpm 12 would otherwise refuse a frozen install. Traces use OTLP/HTTP JSON, so protobuf is never used. Do not change this to `true`.
- **Shutdown** returns a handle whose `shutdown()` flushes spans. The entrypoints call it on SIGTERM.

## Alternatives

- Start the SDK only with an endpoint: no trace ids in logs without a collector. Rejected.
- Use `getNodeAutoInstrumentations()`: instruments file system, DNS and other modules that DEP-050 does not list, adding overhead and noise. Rejected.
- Honor `OTEL_*` variables: a second switch that could export without the config. Rejected.

## Affected requirements

DEP-050 (tracing, export condition, BullMQ instrumentation via T-028), JOB-010 (job runtime), ARC-030.
