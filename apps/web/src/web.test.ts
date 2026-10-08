import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { startWebServer } from './web.ts';

function app(): Hono {
  const hono = new Hono();
  hono.get('/api/healthz', (c) => c.json({ status: 'ok' }));
  hono.get('/api/slow', async (c) => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return c.text('done');
  });
  return hono;
}

describe('web entrypoint server', () => {
  it('[DEP-002] serves the Hono app, including /api/healthz, on the requested port', async () => {
    const server = await startWebServer({ fetch: app().fetch, port: 0, host: '127.0.0.1' });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/healthz`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'ok' });
    } finally {
      await server.close(1000);
    }
  });

  it('[DEP-030] close lets an in-flight request finish, then stops listening', async () => {
    const server = await startWebServer({ fetch: app().fetch, port: 0, host: '127.0.0.1' });
    const pending = fetch(`http://127.0.0.1:${server.port}/api/slow`);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await server.close(5000);
    const response = await pending;
    expect(await response.text()).toBe('done');
    await expect(fetch(`http://127.0.0.1:${server.port}/api/healthz`)).rejects.toThrow();
  });

  it('[DEP-030] close cuts a connection that outlives the drain period', async () => {
    const stream = new Hono();
    stream.get('/api/events', () => {
      const body = new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode('x')) });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    });
    const server = await startWebServer({ fetch: stream.fetch, port: 0, host: '127.0.0.1' });
    const response = await fetch(`http://127.0.0.1:${server.port}/api/events`);
    const reader = response.body?.getReader();
    await reader?.read();
    const started = Date.now();
    await server.close(100);
    expect(Date.now() - started).toBeLessThan(3000);
    await reader?.cancel().catch(() => undefined);
  });
});
