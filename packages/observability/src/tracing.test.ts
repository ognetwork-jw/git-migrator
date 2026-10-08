import { trace } from '@opentelemetry/api';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTraceSdkOptions,
  otlpTracesUrl,
  startTracing,
  type TracingHandle,
} from './tracing.ts';

let handle: TracingHandle | undefined;

afterEach(async () => {
  await handle?.shutdown();
  handle = undefined;
});

describe('OpenTelemetry tracing (DEP-050)', () => {
  it('[DEP-050] exports nothing when no OTLP endpoint is configured', () => {
    const options = createTraceSdkOptions({ serviceName: 'git-migrator', otlpEndpoint: '' });
    expect(options.traceExporter).toBeUndefined();
    expect(options.spanProcessors).toHaveLength(1);
  });

  it('[DEP-050] treats a blank endpoint as not configured', () => {
    const options = createTraceSdkOptions({ serviceName: 'git-migrator', otlpEndpoint: '   ' });
    expect(options.traceExporter).toBeUndefined();
    expect(options.spanProcessors).toHaveLength(1);
  });

  it('[DEP-050] exports spans with an OTLP/HTTP exporter when an endpoint is configured', () => {
    const options = createTraceSdkOptions({
      serviceName: 'git-migrator',
      otlpEndpoint: 'http://otel.internal:4318/',
    });
    expect(options.traceExporter).toBeDefined();
    expect(options.spanProcessors).toBeUndefined();
  });

  it('[DEP-050] instruments HTTP and PostgreSQL, and sends no metrics or logs through OpenTelemetry', () => {
    const options = createTraceSdkOptions({ serviceName: 'git-migrator' });
    const names = (options.instrumentations ?? [])
      .flat()
      .map((instrumentation) => instrumentation.instrumentationName);
    expect(names).toEqual(
      expect.arrayContaining([
        '@opentelemetry/instrumentation-http',
        '@opentelemetry/instrumentation-pg',
      ]),
    );
    expect(options.metricReaders).toEqual([]);
    expect(options.logRecordProcessors).toEqual([]);
  });

  it('[DEP-050] adds the caller instrumentations after HTTP and PostgreSQL', () => {
    const extra = {
      instrumentationName: 'test-extra',
      enable() {},
      disable() {},
      setTracerProvider() {},
      setMeterProvider() {},
      setConfig() {},
      getConfig() {
        return {};
      },
      instrumentationVersion: '0',
      moduleName: 'x',
    };
    const options = createTraceSdkOptions({
      serviceName: 'git-migrator',
      instrumentations: [extra as never],
    });
    const names = (options.instrumentations ?? [])
      .flat()
      .map((instrumentation) => instrumentation.instrumentationName);
    expect(names.at(-1)).toBe('test-extra');
    expect(names).toContain('@opentelemetry/instrumentation-pg');
  });

  it('[DEP-050] appends the OTLP traces path to the collector base URL once', () => {
    expect(otlpTracesUrl('http://otel:4318')).toBe('http://otel:4318/v1/traces');
    expect(otlpTracesUrl('http://otel:4318/')).toBe('http://otel:4318/v1/traces');
    expect(otlpTracesUrl('https://collector.example/base///')).toBe(
      'https://collector.example/base/v1/traces',
    );
  });

  it('[DEP-050] creates trace ids locally when nothing is exported', async () => {
    handle = startTracing({ serviceName: 'git-migrator-test' });
    const span = trace.getTracer('tracing-test').startSpan('probe');
    const { traceId } = span.spanContext();
    span.end();
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(traceId).not.toBe('0'.repeat(32));
  });

  it('[DEP-050] shutdown resolves once the SDK is stopped', async () => {
    handle = startTracing({ serviceName: 'git-migrator-test' });
    await expect(handle.shutdown()).resolves.toBeUndefined();
    handle = undefined;
  });
});
