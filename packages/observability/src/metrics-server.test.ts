import { Registry } from 'prom-client';
import { afterEach, describe, expect, it } from 'vitest';
import { createMetrics } from './metrics.ts';
import { type MetricsServer, startMetricsServer } from './metrics-server.ts';

let server: MetricsServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start(): Promise<{ base: string; registry: Registry }> {
  const { registry, metrics } = createMetrics(new Registry());
  metrics.runsTotal.inc({ kind: 'migrate', status: 'succeeded' }, 2);
  server = await startMetricsServer({ registry, port: 0, host: '127.0.0.1' });
  return { base: `http://127.0.0.1:${server.port}`, registry };
}

describe('metrics server (DEP-050)', () => {
  it('[DEP-050] serves the Prometheus text format on /metrics', async () => {
    const { base } = await start();
    const response = await fetch(`${base}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    const body = await response.text();
    expect(body).toContain('gm_runs_total{kind="migrate",status="succeeded"} 2');
  });

  it('[DEP-050] accepts a query string on /metrics', async () => {
    const { base } = await start();
    expect((await fetch(`${base}/metrics?format=text`)).status).toBe(200);
  });

  it('[DEP-050] answers HEAD on /metrics without a body', async () => {
    const { base } = await start();
    const response = await fetch(`${base}/metrics`, { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
  });

  it('[DEP-050] returns 404 for every other path, so the API surface is not exposed here', async () => {
    const { base } = await start();
    const response = await fetch(`${base}/api/v1/quota`);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not found\n');
    expect((await fetch(`${base}/metricsx`)).status).toBe(404);
  });

  it('[DEP-050] returns 405 with an Allow header for methods other than GET and HEAD', async () => {
    const { base } = await start();
    const response = await fetch(`${base}/metrics`, { method: 'POST' });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
  });

  it('[DEP-050] returns 500 when the registry cannot produce output', async () => {
    const { registry } = createMetrics(new Registry());
    registry.metrics = () => Promise.reject(new Error('collector broke'));
    server = await startMetricsServer({ registry, port: 0, host: '127.0.0.1' });
    const response = await fetch(`http://127.0.0.1:${server.port}/metrics`);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('Metrics unavailable\n');
  });

  it('[DEP-050] reports the bound port and stops listening on close', async () => {
    const { base } = await start();
    const port = server?.port ?? 0;
    expect(port).toBeGreaterThan(0);
    await server?.close();
    server = undefined;
    await expect(fetch(`${base}/metrics`)).rejects.toThrow();
  });

  it('[DEP-050] rejects when the port is already in use', async () => {
    const first = await startMetricsServer({
      registry: new Registry(),
      port: 0,
      host: '127.0.0.1',
    });
    server = first;
    await expect(
      startMetricsServer({ registry: new Registry(), port: first.port, host: '127.0.0.1' }),
    ).rejects.toThrow(/EADDRINUSE/);
  });
});
