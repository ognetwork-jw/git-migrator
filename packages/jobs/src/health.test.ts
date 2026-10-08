import { afterEach, describe, expect, it } from 'vitest';
import { HEALTH_PORT, type HealthServer, startHealthServer } from './health.ts';

let server: HealthServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('worker health server', () => {
  it('[DEP-030] listens on port 8081 by default', () => {
    expect(HEALTH_PORT).toBe(8081);
  });

  it('[DEP-030] answers /healthz with 200 and /readyz 503 until the workers started', async () => {
    let ready = false;
    server = await startHealthServer({ port: 0, host: '127.0.0.1', ready: () => ready });
    const base = `http://127.0.0.1:${server.port}`;
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/readyz`)).status).toBe(503);
    ready = true;
    const response = await fetch(`${base}/readyz?x=1`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ready\n');
  });

  it('[DEP-030] answers 404 for other paths and 405 for other methods', async () => {
    server = await startHealthServer({ port: 0, host: '127.0.0.1', ready: () => true });
    const base = `http://127.0.0.1:${server.port}`;
    expect((await fetch(`${base}/metrics`)).status).toBe(404);
    expect((await fetch(`${base}/healthz`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${base}/healthz`, { method: 'HEAD' })).status).toBe(200);
  });
});
