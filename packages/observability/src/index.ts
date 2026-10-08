/** The workspace package name (ARC-011). */
export const PACKAGE_NAME = '@git-migrator/observability';

export { createLogger, type Logger, type LoggerOptions, type LogSink } from './logger.ts';
export { REDACT_PATHS, REDACTED, redactString, redactValue } from './redact.ts';
export {
  createTraceSdkOptions,
  type NodeSdkOptions,
  otlpTracesUrl,
  startTracing,
  type TracingHandle,
  type TracingOptions,
} from './tracing.ts';
