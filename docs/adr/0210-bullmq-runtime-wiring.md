# ADR-0210: BullMQ runtime wiring, shared pool and job tracing

- Status: agent-decided
- Date: 2026-10-08
- Task: T-028
- Affects: JOB-010, JOB-011, JOB-012, JOB-013, JOB-014, DEP-050, DATA-030

## Context

JOB-014 asks for "one shared BullMQ PostgreSQL backend instance" passed to every Queue, Worker and QueueEvents. In `bullmq` 6.3.11 a backend is built by each class from its `connection` option; there is no public way to hand an existing backend to a class. The `connection` option may be a `pg.Pool`, which every backend then uses without owning it (the caller ends it). ADR-0054 expected the job runtime to pass a BullMQ "instrumentation" to `startTracing`, but `bullmq-otel` is not an OpenTelemetry instrumentation: it is a `Telemetry` object given to each Queue and Worker.

## Decision

- **One `pg.Pool` per process is the shared backend resource.** `JobRuntime` creates it with `options: -c search_path=bullmq` (a pre-built pool cannot carry BullMQ's `schema` option, and BullMQ's default schema is `bullmq`), registers `createPostgresBackend` with `setDefaultBackendFactory`, and passes the pool as `connection` to every Queue and Worker. No QueueEvents are used (no caller waits for a job result). The runtime ends the pool on close.
- **Pool size is `workers + 4`.** Each Worker checks one client out of a caller-supplied pool for its blocking `LISTEN`; four more serve queries. Measured with all 7 Workers (the `all` role): 4 to 11 connections, never above the cap. The formula and per-process totals are in `docs/deployment.md`.
- **Tracing.** `bullmq-otel` 2.0.1 (an optional peer of `bullmq`, ADR-0002) is created with `enableMetrics: false` and passed as `telemetry` to every Queue and Worker. The enqueue span's context travels in the job, so the processing span is in the same trace (tested). `startTracing` needs no change; spans go wherever `startTracing` sent them (discarded without `observability.otlpEndpoint`, ADR-0054).
- **Retries.** `attempts: 3` with exponential backoff from 5 s on every queue except the two Run queues (`attempts: 1`). Finished jobs are kept 1 day, failed 7 days (JOB-011, JOB-013).
- **A job with no registered processor, or an invalid payload on processing, fails with `UnrecoverableError`**, so it is not retried.
- `msgpackr-extract` (an optional native accelerator of `msgpackr`, a `bullmq` dependency) has its install script disabled in `pnpm-workspace.yaml` (`allowBuilds`), like `protobufjs`; `msgpackr` falls back to JavaScript.

## Alternatives

- A config-object `connection` per class (BullMQ owns the pools): sets the schema itself but opens a pool per Queue and Worker, which JOB-014 forbids.
- Patching BullMQ to accept a backend instance: not maintainable.

## Affected requirements

JOB-010, JOB-011, JOB-012, JOB-013, JOB-014, DEP-050.
