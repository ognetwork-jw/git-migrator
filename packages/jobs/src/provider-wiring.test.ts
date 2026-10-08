import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import { createLogger, createMetrics } from '@git-migrator/observability';
import { QuotaLeases, QuotaService } from '@git-migrator/quota';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createProviderEnvironment,
  createProviderTelemetry,
  createRawCaptureSink,
} from './provider-wiring.ts';
import { seedBasics } from './world.fixture.ts';

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase('gm_t028w_');
}, 120_000);
afterAll(async () => {
  await t?.drop();
}, 60_000);

describe('provider wiring', () => {
  it('[ADP-061] saves stripped raw captures into RawResponse and returns the id', async () => {
    const world = await seedBasics(t.db.privileged);
    const sink = createRawCaptureSink(t.db.privileged);
    const fetchedAt = new Date('2026-10-08T10:00:00Z');
    const id = await sink.save({
      endpointId: world.sourceEndpointId,
      method: 'GET',
      url: 'https://api.test/2.0/repositories/acme/r',
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: { name: 'r', nested: [1, 2] },
      fetchedAt,
    });
    const empty = await sink.save({
      endpointId: world.sourceEndpointId,
      method: 'HEAD',
      url: 'https://api.test/x',
      status: 204,
      headers: {},
      body: undefined,
      fetchedAt,
    });
    const rows = await t.db.pool.query(
      'SELECT * FROM app.raw_response WHERE id = ANY($1) ORDER BY method',
      [[id, empty]],
    );
    expect(rows.rows).toHaveLength(2);
    const [get, head] = rows.rows;
    expect(get).toMatchObject({
      endpoint_id: world.sourceEndpointId,
      method: 'GET',
      status: 200,
      body: { name: 'r', nested: [1, 2] },
    });
    expect(get.fetched_at.toISOString()).toBe(fetchedAt.toISOString());
    expect(head.body).toBeNull();
  }, 60_000);

  it('[ADP-060] maps provider telemetry onto the metric recorders and the tracer', () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const { registry, recorders } = createMetrics();
    const telemetry = createProviderTelemetry(recorders, provider.getTracer('test'));
    const labels = {
      provider: 'p',
      endpoint: 'repos.get',
      bucket: 'repository-data',
      status: '200',
    };
    telemetry.recordRequest(labels, 0.25);

    const ok = telemetry.startSpan?.('provider.request', { 'gm.endpoint': 'repos.get' });
    ok?.setAttributes({ 'http.status_code': 200 });
    ok?.end();
    const bad = telemetry.startSpan?.('provider.request', {});
    bad?.end('stripped message');

    const [first, second] = exporter.getFinishedSpans();
    expect(first?.attributes).toMatchObject({
      'gm.endpoint': 'repos.get',
      'http.status_code': 200,
    });
    expect(first?.status.code).not.toBe(SpanStatusCode.ERROR);
    expect(second?.status).toMatchObject({
      code: SpanStatusCode.ERROR,
      message: 'stripped message',
    });
    return registry.metrics().then((text) => {
      expect(text).toContain(
        'gm_provider_requests_total{provider="p",endpoint="repos.get",bucket="repository-data",status="200"} 1',
      );
      expect(text).toContain('gm_provider_request_duration_seconds_count');
    });
  });

  it('[ADP-060] defaults to the global tracer', () => {
    expect(() =>
      createProviderTelemetry(createMetrics().recorders).startSpan?.('x', {}),
    ).not.toThrow();
    expect(trace.getTracer('x')).toBeDefined();
  });

  it('[JOB-045] builds the adapter environment from the quota and lease services', async () => {
    const { recorders } = createMetrics();
    const quota = new QuotaService({ pool: t.db.pool, metrics: recorders });
    const leases = new QuotaLeases({ pool: t.db.pool });
    const logger = createLogger({ level: 'silent' });
    const environment = createProviderEnvironment({
      quota,
      leases,
      db: t.db.privileged,
      recorders,
      logger,
      environment: 'test',
      testAllowedHosts: ['127.0.0.1'],
    });
    expect(environment.quota).toBe(quota);
    expect(environment.leases).toBe(leases);
    expect(environment.capture).toBeDefined();
    expect(environment.telemetry).toBeDefined();
    expect(environment.environment).toBe('test');
    expect(environment.testAllowedHosts).toEqual(['127.0.0.1']);
    const grant = await environment.quota.acquire(
      [{ key: 'e:a:repository-data', limit: 10, windowSeconds: 3600 }],
      'interactive',
    );
    expect(grant.granted).toBe(true);
    const bare = createProviderEnvironment({
      quota,
      leases,
      db: t.db.privileged,
      recorders,
      logger,
    });
    expect(bare.environment).toBeUndefined();
  }, 60_000);
});
