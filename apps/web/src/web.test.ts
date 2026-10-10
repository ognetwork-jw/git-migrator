import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import {
  CLOSE_STEP_TIMEOUT_MS,
  createShutdown,
  DRAIN_MS,
  PRE_STOP_MS,
  prepareNextHandler,
  SHUTDOWN_DEADLINE_MS,
  STANDALONE_DIR,
  startWebServer,
  TERMINATION_GRACE_MS,
} from './web.ts';

const repoRoot = join(import.meta.dirname, '..', '..', '..');

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
  it('[DEP-002] serves its request handler, including /api/healthz, on the requested port', async () => {
    const server = await startWebServer({
      handler: getRequestListener(app().fetch),
      port: 0,
      host: '127.0.0.1',
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/healthz`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'ok' });
    } finally {
      await server.close(1000);
    }
  });

  it('[DEP-002] rejects when the port is taken', async () => {
    const first = await startWebServer({
      handler: getRequestListener(app().fetch),
      port: 0,
      host: '127.0.0.1',
    });
    try {
      await expect(
        startWebServer({
          handler: getRequestListener(app().fetch),
          port: first.port,
          host: '127.0.0.1',
        }),
      ).rejects.toThrow(/EADDRINUSE/);
    } finally {
      await first.close(1000);
    }
  });

  it('[DEP-030] close lets an in-flight request finish, then stops listening', async () => {
    const server = await startWebServer({
      handler: getRequestListener(app().fetch),
      port: 0,
      host: '127.0.0.1',
    });
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
    const server = await startWebServer({
      handler: getRequestListener(stream.fetch),
      port: 0,
      host: '127.0.0.1',
    });
    const response = await fetch(`http://127.0.0.1:${server.port}/api/events`);
    const reader = response.body?.getReader();
    await reader?.read();
    const started = Date.now();
    await server.close(100);
    expect(Date.now() - started).toBeLessThan(3000);
    await reader?.cancel().catch(() => undefined);
  });
});

/**
 * A stand-in for the standalone output of `next build`: `server.js`, the build's configuration in
 * `.next/required-server-files.json`, and a `next` package in the traced `node_modules` that records
 * how it was called. The real build is exercised by the image smoke test (deploy/docker/smoke.sh).
 */
const FAKE_NEXT = `
module.exports = function next(options) {
  const calls = (globalThis.__gmFakeNext = {
    options,
    standaloneConfig: process.env.__NEXT_PRIVATE_STANDALONE_CONFIG,
    manualSignals: process.env.NEXT_MANUAL_SIG_HANDLE,
    prepared: false,
    closed: false,
  });
  return {
    prepare: async () => { calls.prepared = true; },
    getRequestHandler: () => async (req, res) => {
      if (req.url === '/boom') throw new Error('boom');
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<title>git-migrator</title>' + req.url);
    },
    close: async () => { calls.closed = true; },
  };
};
`;

interface FakeNextCalls {
  options: Record<string, unknown>;
  standaloneConfig: string | undefined;
  manualSignals: string | undefined;
  prepared: boolean;
  closed: boolean;
}

describe('Next.js standalone server (DEP-002)', () => {
  let dir: string;
  const saved = {
    config: process.env.__NEXT_PRIVATE_STANDALONE_CONFIG,
    signals: process.env.NEXT_MANUAL_SIG_HANDLE,
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gm-standalone-'));
    mkdirSync(join(dir, '.next'));
    mkdirSync(join(dir, 'node_modules', 'next'), { recursive: true });
    writeFileSync(join(dir, 'server.js'), '');
    writeFileSync(
      join(dir, '.next', 'required-server-files.json'),
      JSON.stringify({ version: 1, config: { output: 'standalone', distDir: './.next' } }),
    );
    writeFileSync(
      join(dir, 'node_modules', 'next', 'package.json'),
      JSON.stringify({ name: 'next', main: 'index.js' }),
    );
    writeFileSync(join(dir, 'node_modules', 'next', 'index.js'), FAKE_NEXT);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of [
      ['__NEXT_PRIVATE_STANDALONE_CONFIG', saved.config],
      ['NEXT_MANUAL_SIG_HANDLE', saved.signals],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete (globalThis as { __gmFakeNext?: unknown }).__gmFakeNext;
  });

  const calls = (): FakeNextCalls =>
    (globalThis as unknown as { __gmFakeNext: FakeNextCalls }).__gmFakeNext;

  it('[DEP-002] the image runs the standalone server that next build writes for apps/web', () => {
    expect(STANDALONE_DIR.replaceAll('\\', '/')).toMatch(
      /apps\/web\/\.next\/standalone\/apps\/web$/,
    );
  });

  it('[DEP-002] loads the standalone build with its own configuration and serves the UI through it', async () => {
    const errors: unknown[] = [];
    const next = await prepareNextHandler({
      dir,
      hostname: '127.0.0.1',
      port: 3000,
      onError: (error) => errors.push(error),
    });
    expect(calls().prepared).toBe(true);
    expect(calls().options).toMatchObject({
      dev: false,
      dir,
      hostname: '127.0.0.1',
      port: 3000,
      conf: { output: 'standalone', distDir: './.next' },
    });
    // The configuration of the build, as server.js passes it; signals stay with the entrypoint.
    expect(JSON.parse(calls().standaloneConfig ?? '{}')).toEqual({
      output: 'standalone',
      distDir: './.next',
    });
    expect(calls().manualSignals).toBe('true');

    const server = await startWebServer({ handler: next.handler, port: 0, host: '127.0.0.1' });
    try {
      const page = await fetch(`http://127.0.0.1:${server.port}/signin`);
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toMatch(/^text\/html/);
      expect(await page.text()).toBe('<title>git-migrator</title>/signin');
      // A handler failure is reported and answered with 500, not left hanging.
      const failed = await fetch(`http://127.0.0.1:${server.port}/boom`);
      expect(failed.status).toBe(500);
      expect(errors).toHaveLength(1);
    } finally {
      await server.close(1000);
    }
    await next.close();
    expect(calls().closed).toBe(true);
  });

  it('[DEP-002] refuses to start without a standalone build', async () => {
    rmSync(join(dir, 'server.js'));
    await expect(prepareNextHandler({ dir, hostname: '127.0.0.1', port: 3000 })).rejects.toThrow(
      /no Next\.js standalone build/,
    );
  });
});

describe('web shutdown (DEP-030)', () => {
  const quietLog = () => ({ warn: vi.fn(), error: vi.fn() });
  const exited = () => {
    let resolve: (code: number) => void = () => undefined;
    const code = new Promise<number>((r) => {
      resolve = r;
    });
    return { code, exit: vi.fn((c: number) => resolve(c)) };
  };

  it('[DEP-030] the deadline fits the chart: grace period minus preStop minus 2 s', () => {
    const values = parse(
      readFileSync(join(repoRoot, 'deploy/helm/git-migrator/values.yaml'), 'utf8'),
    );
    const template = readFileSync(
      join(repoRoot, 'deploy/helm/git-migrator/templates/deployment-web.yaml'),
      'utf8',
    );
    expect(TERMINATION_GRACE_MS).toBe(values.web.terminationGracePeriodSeconds * 1000);
    const preStop = Number(template.match(/command: \["sleep", "(\d+)"\]/)?.[1]);
    expect(PRE_STOP_MS).toBe(preStop * 1000);
    expect(SHUTDOWN_DEADLINE_MS).toBe(TERMINATION_GRACE_MS - PRE_STOP_MS - 2_000);
    // The drain and the bounded close steps start before the deadline cuts them.
    expect(DRAIN_MS + CLOSE_STEP_TIMEOUT_MS).toBeLessThan(SHUTDOWN_DEADLINE_MS);
  });

  it('[DEP-030] runs the steps in order and exits 0', async () => {
    const order: string[] = [];
    const { code, exit } = exited();
    const stop = createShutdown({
      deadlineMs: 5_000,
      exit,
      log: quietLog(),
      steps: ['http', 'next', 'api'].map((name) => ({
        name,
        run: async () => {
          order.push(name);
        },
      })),
    });
    stop();
    stop(); // a second signal does not start a second shutdown
    expect(await code).toBe(0);
    expect(order).toEqual(['http', 'next', 'api']);
    expect(exit).toHaveBeenCalledOnce();
  });

  it('[DEP-030] a step that hangs is abandoned after its timeout and the rest still run', async () => {
    const log = quietLog();
    const { code, exit } = exited();
    const ran: string[] = [];
    createShutdown({
      deadlineMs: 5_000,
      exit,
      log,
      steps: [
        { name: 'tracing', run: () => new Promise(() => undefined), timeoutMs: 50 },
        { name: 'api', run: async () => void ran.push('api'), timeoutMs: 50 },
      ],
    })();
    expect(await code).toBe(0);
    expect(ran).toEqual(['api']);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ step: 'tracing' }),
      'shutdown step timed out',
    );
  });

  it('[DEP-030] the deadline exits 0 even while a step without a timeout is still open', async () => {
    const log = quietLog();
    const { code, exit } = exited();
    const started = Date.now();
    createShutdown({
      deadlineMs: 100,
      exit,
      log,
      // An SSE stream that outlives everything.
      steps: [{ name: 'http', run: () => new Promise(() => undefined) }],
    })();
    expect(await code).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    expect(log.warn).toHaveBeenCalledWith(
      { deadlineMs: 100 },
      'shutdown deadline reached; exiting',
    );
  });

  it('[DEP-030] a failed step is logged, the rest still run, and the exit status is 1', async () => {
    const log = quietLog();
    const { code, exit } = exited();
    const ran: string[] = [];
    createShutdown({
      deadlineMs: 5_000,
      exit,
      log,
      steps: [
        { name: 'next', run: () => Promise.reject(new Error('boom')) },
        { name: 'api', run: async () => void ran.push('api') },
      ],
    })();
    expect(await code).toBe(1);
    expect(ran).toEqual(['api']);
    expect(log.error).toHaveBeenCalledOnce();
  });
});
