/** The workspace package name (ARC-011). */
export const PACKAGE_NAME = '@git-migrator/observability';

export { createLogger, type Logger, type LoggerOptions, type LogSink } from './logger.ts';
export {
  createMetrics,
  type GmMetrics,
  type MetricRecorders,
  type MetricsRegistry,
} from './metrics.ts';
export {
  type MetricsServer,
  type MetricsServerOptions,
  startMetricsServer,
} from './metrics-server.ts';
export {
  isSensitiveKey,
  REDACT_PATHS,
  REDACTED,
  redactString,
  redactValue,
} from './redact.ts';
export {
  createTraceSdkOptions,
  type NodeSdkOptions,
  otlpTracesUrl,
  startTracing,
  type TracingHandle,
  type TracingOptions,
} from './tracing.ts';
