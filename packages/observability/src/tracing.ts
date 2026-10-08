import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { NodeSDK } from '@opentelemetry/sdk-node';

export interface TracingOptions {
  /** Written as the OpenTelemetry `service.name`. */
  readonly serviceName: string;
  /** Base URL of an OTLP/HTTP collector (`observability.otlpEndpoint`). Empty or absent: no export. */
  readonly otlpEndpoint?: string | undefined;
  /**
   * Further instrumentations, added after HTTP and PostgreSQL. The job runtime passes its BullMQ
   * instrumentation here (T-028, ADR-0054).
   */
  readonly instrumentations?: readonly NodeInstrumentation[] | undefined;
}

type NodeInstrumentation = NonNullable<NonNullable<NodeSdkOptions['instrumentations']>>[number];

export type NodeSdkOptions = NonNullable<ConstructorParameters<typeof NodeSDK>[0]>;

/** A span processor that keeps spans in memory only: trace ids exist, nothing is sent (ADR-0054). */
const discardSpans = {
  onStart(): void {},
  onEnd(): void {},
  forceFlush: (): Promise<void> => Promise.resolve(),
  shutdown: (): Promise<void> => Promise.resolve(),
};

/** The OTLP/HTTP traces URL for a collector base URL. */
export function otlpTracesUrl(endpoint: string): string {
  return `${endpoint.replace(/\/+$/, '')}/v1/traces`;
}

/**
 * The OpenTelemetry Node SDK configuration (DEP-050). HTTP server and outgoing HTTP, and PostgreSQL,
 * are instrumented. Spans are exported only when `otlpEndpoint` is set. Metrics and logs are never
 * exported through OpenTelemetry: `prom-client` serves metrics, and pino writes logs to stdout.
 * Environment variables such as `OTEL_TRACES_EXPORTER` are not read, so the exporter is always
 * the one this configuration names.
 */
export function createTraceSdkOptions(options: TracingOptions): NodeSdkOptions {
  const endpoint = options.otlpEndpoint?.trim() ?? '';
  const exporting = endpoint !== '';
  return {
    serviceName: options.serviceName,
    instrumentations: [
      new HttpInstrumentation(),
      new PgInstrumentation(),
      ...(options.instrumentations ?? []),
    ],
    metricReaders: [],
    logRecordProcessors: [],
    ...(exporting
      ? { traceExporter: new OTLPTraceExporter({ url: otlpTracesUrl(endpoint) }) }
      : { spanProcessors: [discardSpans] }),
  };
}

export interface TracingHandle {
  /** Flushes pending spans and stops the SDK. Call it on shutdown. */
  shutdown(): Promise<void>;
}

/**
 * Starts tracing for the process. Call it once, before the servers and queues start, so the
 * instrumentations can patch the modules they wrap.
 */
export function startTracing(options: TracingOptions): TracingHandle {
  const sdk = new NodeSDK(createTraceSdkOptions(options));
  sdk.start();
  return { shutdown: () => sdk.shutdown() };
}
