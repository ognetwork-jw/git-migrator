import { BullMQOtel } from 'bullmq-otel';

/**
 * BullMQ tracing (DEP-050, ADR-0054, ADR-0210). Pass the result as the `telemetry` option of every
 * Queue and Worker. Producers inject the trace context into the job, and workers continue it, so a
 * job's span is a child of the span that enqueued it. Spans go to whatever tracer provider the
 * process registered (`startTracing` in `packages/observability`); without an OTLP endpoint they
 * are discarded there. Only traces are produced: metrics stay with `prom-client` (ADR-0053).
 */
export function createBullmqTelemetry(serviceName = 'git-migrator'): BullMQOtel {
  return new BullMQOtel({ tracerName: serviceName, enableMetrics: false });
}
