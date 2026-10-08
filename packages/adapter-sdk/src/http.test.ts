import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type BucketSpec, bucketKey, type QuotaFeedback } from '@git-migrator/quota';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdapterError } from './errors.ts';
import {
  type Classifier,
  type Interpreter,
  type LeaseGate,
  ProviderHttpClient,
  type ProviderHttpClientOptions,
  type ProviderTelemetry,
  parseRetryAfter,
  type QuotaGate,
  type RawCaptureInput,
  type RawCaptureSink,
} from './http.ts';
import { noopLogger } from './logger.ts';

const SECRET = 'tok-s3cr3t-value-123';
const KEY = bucketKey('ep', 'acct', 'core');
const BUCKET: BucketSpec = { key: KEY, limit: 100, windowSeconds: 3600 };
const GRANT_AT = new Date('2026-01-01T00:00:00Z');

type Reply = Response | Error;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function fakeQuota(overrides: Partial<QuotaGate> = {}) {
  const calls = {
    acquire: [] as { buckets: readonly BucketSpec[]; pool: string }[],
    feedback: [] as QuotaFeedback[],
    rateLimited: [] as {
      bucketKey: string;
      retryAfterSeconds?: number;
      minBlockSeconds?: number;
    }[],
    secondary: [] as { bucketKey: string; retryAfterSeconds?: number }[],
    adjust: [] as { bucketKey: string; pool: string; delta: number }[],
  };
  const quota: QuotaGate = {
    acquire: async (buckets, pool) => {
      calls.acquire.push({ buckets, pool });
      return { granted: true, at: GRANT_AT, buckets: [] };
    },
    recordFeedback: async (feedback) => {
      calls.feedback.push(feedback);
    },
    recordRateLimited: async (input) => {
      calls.rateLimited.push(input);
      return new Date(Date.now() + (input.retryAfterSeconds ?? 60) * 1000);
    },
    recordSecondaryLimit: async (input) => {
      calls.secondary.push(input);
      return new Date(Date.now() + (input.retryAfterSeconds ?? 60) * 1000);
    },
    adjust: async (bucketKey, pool, delta) => {
      calls.adjust.push({ bucketKey, pool, delta });
    },
    ...overrides,
  };
  return { quota, calls };
}

const classify: Classifier = ({ path }) => ({
  endpoint: path.startsWith('/repos') ? 'repos' : 'other',
  buckets: [BUCKET],
});

function setup(
  replies: Reply[],
  options: Partial<ProviderHttpClientOptions> = {},
  quotaOverrides: Partial<QuotaGate> = {},
) {
  const { quota, calls } = fakeQuota(quotaOverrides);
  const requests: { url: string; method: string; headers: Headers; body: unknown }[] = [];
  const sleeps: number[] = [];
  const queue = [...replies];
  const fetchFn = vi.fn(async (input: URL | string | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body,
    });
    const next = queue.shift();
    if (next === undefined) throw new Error('no reply queued');
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  const client = new ProviderHttpClient({
    provider: 'acme',
    endpointId: 'ep',
    baseUrl: 'http://127.0.0.1:9/api/',
    classify,
    authorize: async () => ({ headers: { authorization: `Bearer ${SECRET}` }, secrets: [SECRET] }),
    quota,
    logger: noopLogger,
    fetch: fetchFn,
    environment: 'production',
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 1,
    now: () => new Date(),
    ...options,
  });
  return { client, calls, requests, sleeps, fetchFn };
}

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  vi.unstubAllEnvs();
});

describe('ProviderHttpClient quota', () => {
  it('[ADP-060] acquires the classified buckets in the request pool before sending and sends credentials', async () => {
    const { client, calls, requests } = setup([json(200, { ok: true })], { pool: 'interactive' });
    const response = await client.request({ path: '/repos/x' });
    expect(response.body).toEqual({ ok: true });
    expect(response.grantedAt).toBe(GRANT_AT);
    expect(calls.acquire).toEqual([{ buckets: [BUCKET], pool: 'interactive' }]);
    expect(requests[0]?.url).toBe('http://127.0.0.1:9/api/repos/x');
    expect(requests[0]?.headers.get('authorization')).toBe(`Bearer ${SECRET}`);
  });

  it('[ADP-060] lets a request override the pool, and defaults to background', async () => {
    const a = setup([json(200, {})]);
    await a.client.get('/repos/x');
    expect(a.calls.acquire[0]?.pool).toBe('background');
    const b = setup([json(200, {})]);
    await b.client.get('/repos/x', { pool: 'interactive' });
    expect(b.calls.acquire[0]?.pool).toBe('interactive');
  });

  it('[ADP-060] acquires quota again for every retry attempt', async () => {
    const { client, calls } = setup([json(503, {}), json(503, {}), json(200, { ok: 1 })]);
    await client.get('/repos/x');
    expect(calls.acquire).toHaveLength(3);
  });

  it('[ADP-060] a denied acquire throws rate_limited with retryAt and never sends', async () => {
    const retryAt = new Date(Date.now() + 90_000);
    const { client, fetchFn } = setup(
      [],
      {},
      {
        acquire: async () => ({ granted: false, reason: 'limit', bucketKey: KEY, retryAt }),
      },
    );
    const error = await client.get('/repos/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdapterError);
    expect(error).toMatchObject({ code: 'rate_limited', retryable: true, retryAt });
    expect((error as AdapterError).retryAfterMs).toBeGreaterThan(80_000);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('[ADP-060] passes the grant stamp as observedSince with adapter feedback', async () => {
    const interpret: Interpreter = () => ({
      feedback: [{ bucketKey: KEY, limit: 5000, windowSeconds: 3600, remaining: 4990 }],
    });
    const { client, calls } = setup([json(200, {})], { interpret });
    await client.get('/repos/x');
    expect(calls.feedback).toEqual([
      {
        bucketKey: KEY,
        limit: 5000,
        windowSeconds: 3600,
        remaining: 4990,
        observedSince: GRANT_AT,
      },
    ]);
  });

  it('[ADP-060] keeps an observedSince that the adapter supplies', async () => {
    const earlier = new Date('2025-12-31T23:59:00Z');
    const interpret: Interpreter = () => ({
      feedback: [{ bucketKey: KEY, limit: 10, windowSeconds: 60, observedSince: earlier }],
    });
    const { client, calls } = setup([json(200, {})], { interpret });
    await client.get('/repos/x');
    expect(calls.feedback[0]?.observedSince).toBe(earlier);
  });

  it('[ADP-060] a failing feedback or adjust call does not fail the response', async () => {
    const interpret: Interpreter = () => ({
      feedback: [{ bucketKey: KEY, limit: 10, windowSeconds: 60 }],
      adjust: [{ bucketKey: KEY, delta: 2 }],
    });
    const { client } = setup(
      [json(200, { fine: true })],
      { interpret },
      {
        recordFeedback: async () => {
          throw new Error('db down');
        },
        adjust: async () => {
          throw new Error('db down');
        },
      },
    );
    expect((await client.get('/repos/x')).body).toEqual({ fine: true });
  });

  it('[ADP-060] reconciles a cost estimate through adjust in the request pool', async () => {
    const interpret: Interpreter = () => ({ adjust: [{ bucketKey: KEY, delta: 4 }] });
    const { client, calls } = setup([json(200, {})], { interpret, pool: 'interactive' });
    await client.get('/repos/x');
    expect(calls.adjust).toEqual([{ bucketKey: KEY, pool: 'interactive', delta: 4 }]);
  });
});

describe('ProviderHttpClient retry matrix', () => {
  it.each([408, 500, 502, 503, 504])(
    '[ADP-060] HTTP %i is transient: retried up to 5 attempts, then a transient AdapterError',
    async (status) => {
      const { client, fetchFn, sleeps } = setup(Array.from({ length: 5 }, () => json(status, {})));
      const error = await client.get('/repos/x').catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'transient', retryable: true });
      expect(fetchFn).toHaveBeenCalledTimes(5);
      expect(sleeps).toHaveLength(4);
    },
  );

  it('[ADP-060] a network error is transient and retried', async () => {
    const { client, fetchFn } = setup([new TypeError('fetch failed'), json(200, { ok: 1 })]);
    expect((await client.get('/repos/x')).body).toEqual({ ok: 1 });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('[ADP-060] gives up after 5 network errors with a transient error', async () => {
    const { client, fetchFn } = setup(Array.from({ length: 5 }, () => new TypeError('boom')));
    await expect(client.get('/repos/x')).rejects.toMatchObject({ code: 'transient' });
    expect(fetchFn).toHaveBeenCalledTimes(5);
  });

  it.each([
    [400, 'invalid'],
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [409, 'conflict'],
    [410, 'not_found'],
    [422, 'invalid'],
    [451, 'blocked_by_provider'],
  ])('[ADP-050] HTTP %i maps to %s and is not retried', async (status, code) => {
    const { client, fetchFn } = setup([json(status, { message: 'no' })]);
    const error = await client.get('/repos/x').catch((e: unknown) => e);
    expect(error).toMatchObject({
      code,
      retryable: false,
      provider: 'acme',
      request: { method: 'GET', status },
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('[ADP-060] 429 is not retried in process and blocks every bucket via the quota service', async () => {
    const second: BucketSpec = {
      key: bucketKey('ep', 'acct', 'raw'),
      limit: 10,
      windowSeconds: 60,
    };
    const { client, fetchFn, calls, sleeps } = setup([json(429, {}, { 'retry-after': '120' })], {
      classify: () => ({ endpoint: 'repos', buckets: [BUCKET, second], minBlockSeconds: 60 }),
    });
    const error = (await client.get('/repos/x').catch((e: unknown) => e)) as AdapterError;
    expect(error).toMatchObject({ code: 'rate_limited', retryable: true });
    expect(error.retryAfterMs).toBeGreaterThan(110_000);
    expect(error.retryAt).toBeInstanceOf(Date);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
    expect(calls.rateLimited.map((c) => c.bucketKey)).toEqual([KEY, second.key]);
    expect(calls.rateLimited[0]).toMatchObject({ retryAfterSeconds: 120, minBlockSeconds: 60 });
  });

  it('[ADP-060] 429 without Retry-After leaves the wait to the quota service', async () => {
    const { client, calls } = setup([json(429, {})]);
    await expect(client.get('/repos/x')).rejects.toMatchObject({ code: 'rate_limited' });
    expect(calls.rateLimited[0]?.retryAfterSeconds).toBeUndefined();
  });

  it('[ADP-060] a secondary limit reported by the adapter is not retried and uses the secondary path', async () => {
    const interpret: Interpreter = ({ status }) =>
      status === 403 ? { signal: { kind: 'secondary-limit', retryAfterSeconds: 30 } } : undefined;
    const { client, fetchFn, calls } = setup([json(403, { message: 'slow down' })], { interpret });
    await expect(client.get('/repos/x')).rejects.toMatchObject({
      code: 'rate_limited',
      retryable: true,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(calls.secondary).toEqual([
      { bucketKey: KEY, limit: 100, windowSeconds: 3600, retryAfterSeconds: 30 },
    ]);
    expect(calls.rateLimited).toEqual([]);
  });

  it('[ADP-060] a primary limit on a 403 is recognised through the interpret hook', async () => {
    const interpret: Interpreter = ({ status }) =>
      status === 403 ? { signal: { kind: 'rate-limited' } } : undefined;
    const { client, calls } = setup([json(403, {})], { interpret });
    await expect(client.get('/repos/x')).rejects.toMatchObject({ code: 'rate_limited' });
    expect(calls.rateLimited).toHaveLength(1);
  });

  it('[ADP-060] backoff is exponential with full jitter, base 1 s, cap 60 s', async () => {
    const replies = Array.from({ length: 9 }, () => json(503, {}));
    const max = setup(replies, { random: () => 1, retry: { attempts: 9 } });
    await max.client.get('/repos/x').catch(() => undefined);
    expect(max.sleeps).toEqual([1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000]);
    const half = setup(
      Array.from({ length: 5 }, () => json(503, {})),
      { random: () => 0.5 },
    );
    await half.client.get('/repos/x').catch(() => undefined);
    expect(half.sleeps).toEqual([500, 1000, 2000, 4000]);
    const zero = setup(
      Array.from({ length: 5 }, () => json(503, {})),
      { random: () => 0 },
    );
    await zero.client.get('/repos/x').catch(() => undefined);
    expect(zero.sleeps).toEqual([0, 0, 0, 0]);
  });

  it('[ADP-060] honours a custom retry policy', async () => {
    const { client, fetchFn, sleeps } = setup([json(500, {}), json(500, {}), json(500, {})], {
      retry: { attempts: 2, baseMs: 10, capMs: 15 },
    });
    await expect(client.get('/repos/x')).rejects.toMatchObject({ code: 'transient' });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([10]);
  });

  it('[ADP-060] retry:false sends once even for a transient failure', async () => {
    const { client, fetchFn } = setup([json(503, {}), json(200, {})]);
    await expect(
      client.request({ path: '/repos/x', method: 'POST', retry: false }),
    ).rejects.toMatchObject({
      code: 'transient',
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('[ADP-060] an aborted request is not retried and the abort reason propagates', async () => {
    const controller = new AbortController();
    const reason = new Error('stop');
    const { client, fetchFn } = setup([], {});
    (fetchFn as unknown as { mockImplementation: (f: () => never) => void }).mockImplementation(
      () => {
        controller.abort(reason);
        throw new DOMException('aborted', 'AbortError');
      },
    );
    await expect(client.request({ path: '/repos/x', signal: controller.signal })).rejects.toThrow(
      /aborted/,
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('[ADP-050] an interpreter can override the error code and message', async () => {
    const interpret: Interpreter = () => ({ code: 'unsupported', message: 'not on this plan' });
    const { client } = setup([json(404, {})], { interpret });
    const error = (await client.get('/repos/x').catch((e: unknown) => e)) as AdapterError;
    expect(error.code).toBe('unsupported');
    expect(error.message).toContain('not on this plan');
  });

  it('[ADP-060] parses Retry-After as seconds or an HTTP date', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('120', now)).toBe(120);
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:01:30 GMT', now)).toBe(90);
    expect(parseRetryAfter('Wed, 31 Dec 2025 00:00:00 GMT', now)).toBe(1);
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });
});

describe('ProviderHttpClient requests and responses', () => {
  it('[ADP-060] resolves relative paths under the base path and adds query parameters', async () => {
    const { client, requests } = setup([json(200, {})]);
    await client.get('repos/x', { query: { page: 2, q: 'a b', skip: undefined, flag: true } });
    expect(requests[0]?.url).toBe('http://127.0.0.1:9/api/repos/x?page=2&q=a+b&flag=true');
  });

  it('[ADP-060] classifies the path relative to the base URL, without the query', async () => {
    const seen: string[] = [];
    const { client } = setup([json(200, {})], {
      classify: ({ path }) => {
        seen.push(path);
        return { endpoint: 'e', buckets: [BUCKET] };
      },
    });
    await client.get('/repos/x', { query: { a: 1 } });
    expect(seen).toEqual(['/repos/x']);
  });

  it('[ADP-060] sends JSON bodies with a content type and raw bodies untouched', async () => {
    const { client, requests } = setup([json(201, { id: 1 }), json(200, {})]);
    const created = await client.request({ method: 'post', path: '/repos', json: { name: 'n' } });
    expect(created.status).toBe(201);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.body).toBe('{"name":"n"}');
    expect(requests[0]?.headers.get('content-type')).toBe('application/json');
    await client.request({
      method: 'PUT',
      path: '/raw',
      body: 'abc',
      headers: { 'content-type': 'text/plain' },
    });
    expect(requests[1]?.body).toBe('abc');
    expect(requests[1]?.headers.get('content-type')).toBe('text/plain');
  });

  it('[ADP-060] returns undefined for an empty body and text for non-JSON', async () => {
    const { client } = setup([
      new Response(null, { status: 204 }),
      new Response('plain', { status: 200, headers: { 'content-type': 'text/plain' } }),
      new Response('{oops', { status: 200, headers: { 'content-type': 'application/json' } }),
    ]);
    expect((await client.get('/a')).body).toBeUndefined();
    expect((await client.get('/b')).body).toBe('plain');
    expect((await client.get('/c')).body).toBe('{oops');
  });

  it('[ADP-060] accepts an absolute URL on the same origin (pagination links)', async () => {
    const { client, requests } = setup([json(200, {})]);
    await client.get('http://127.0.0.1:9/api/repos?page=2');
    expect(requests[0]?.url).toBe('http://127.0.0.1:9/api/repos?page=2');
  });

  it('[ADP-060] refuses an absolute URL on another origin so credentials cannot leak', async () => {
    const { client, fetchFn } = setup([json(200, {})]);
    await expect(client.get('http://evil.test/steal')).rejects.toMatchObject({ code: 'invalid' });
    await expect(client.get('//evil.test/steal')).rejects.toMatchObject({ code: 'invalid' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('[ADP-060] follows a same-origin redirect for a read without using up a retry', async () => {
    const { client, requests } = setup([
      new Response(null, { status: 301, headers: { location: '/api/repos/renamed' } }),
      json(200, { ok: 1 }),
    ]);
    expect((await client.get('/repos/x')).body).toEqual({ ok: 1 });
    expect(requests.map((r) => r.url)).toEqual([
      'http://127.0.0.1:9/api/repos/x',
      'http://127.0.0.1:9/api/repos/renamed',
    ]);
  });

  it('[ADP-060] refuses cross-origin redirects, redirected writes and redirect loops', async () => {
    const cross = setup([
      new Response(null, { status: 302, headers: { location: 'http://evil.test/x' } }),
    ]);
    await expect(cross.client.get('/repos/x')).rejects.toMatchObject({ code: 'invalid' });
    const write = setup([new Response(null, { status: 307, headers: { location: '/api/y' } })]);
    await expect(write.client.request({ method: 'POST', path: '/repos' })).rejects.toMatchObject({
      code: 'invalid',
    });
    const loop = setup(
      Array.from(
        { length: 8 },
        () => new Response(null, { status: 302, headers: { location: '/api/repos/x' } }),
      ),
    );
    await expect(loop.client.get('/repos/x')).rejects.toThrow(/Too many redirects/);
  });

  it('[ADP-060] a 3xx without Location is returned as an ordinary response', async () => {
    const { client } = setup([new Response(null, { status: 304 })]);
    expect((await client.get('/repos/x')).status).toBe(304);
  });

  it('[ADP-060] exposes provider and endpoint ids', () => {
    const { client } = setup([]);
    expect(client.provider).toBe('acme');
    expect(client.endpointId).toBe('ep');
  });
});

describe('ProviderHttpClient concurrency lease', () => {
  const concurrency = { bucketKey: bucketKey('ep', 'acct', 'inflight'), cap: 2 };
  const classifyLeased: Classifier = () => ({ endpoint: 'e', buckets: [BUCKET], concurrency });

  it('[ADP-060] takes a lease before acquiring and releases it after the request', async () => {
    const order: string[] = [];
    const leases: LeaseGate = {
      acquire: async (key, holder, cap) => {
        order.push(`lease:${key}:${cap}:${holder.startsWith('ep:')}`);
        return 7n;
      },
      release: async (id) => {
        order.push(`release:${id}`);
      },
    };
    const { client } = setup(
      [json(200, {})],
      { classify: classifyLeased, leases },
      {
        acquire: async () => {
          order.push('acquire');
          return { granted: true, at: GRANT_AT, buckets: [] };
        },
      },
    );
    await client.get('/x');
    expect(order).toEqual([`lease:${concurrency.bucketKey}:2:true`, 'acquire', 'release:7']);
  });

  it('[ADP-060] a refused lease is rate_limited, spends no quota and sends nothing', async () => {
    const leases: LeaseGate = { acquire: async () => undefined, release: vi.fn() };
    const { client, calls, fetchFn } = setup([], { classify: classifyLeased, leases });
    await expect(client.get('/x')).rejects.toMatchObject({
      code: 'rate_limited',
      retryAfterMs: 1000,
    });
    expect(calls.acquire).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(leases.release).not.toHaveBeenCalled();
  });

  it('[ADP-060] releases the lease when the request fails, and survives a failing release', async () => {
    const release = vi.fn(async () => {
      throw new Error('db down');
    });
    const leases: LeaseGate = { acquire: async () => 1n, release };
    const { client } = setup([json(404, {})], { classify: classifyLeased, leases });
    await expect(client.get('/x')).rejects.toMatchObject({ code: 'not_found' });
    expect(release).toHaveBeenCalledWith(1n);
  });
});

describe('ProviderHttpClient raw capture', () => {
  function sink() {
    const saved: RawCaptureInput[] = [];
    const capture: RawCaptureSink = {
      save: async (input) => {
        saved.push(input);
        return `raw-${saved.length}`;
      },
    };
    return { capture, saved };
  }

  it('[ADP-061] records the response with authorization, query secrets and secret fields stripped', async () => {
    const { capture, saved } = sink();
    const { client } = setup(
      [
        json(
          200,
          { name: 'r', token: 'abc', echoed: `value ${SECRET}`, nested: { password: 'p' } },
          { 'set-cookie': 'sid=1', 'x-ratelimit-remaining': '4' },
        ),
      ],
      { capture },
    );
    const response = await client.get('/repos/x', {
      capture: true,
      query: { access_token: SECRET, page: 1 },
    });
    expect(response.rawResponseId).toBe('raw-1');
    const row = saved[0] as RawCaptureInput;
    const text = JSON.stringify(row);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('sid=1');
    expect(text).not.toContain('"abc"');
    expect(row).toMatchObject({
      endpointId: 'ep',
      method: 'GET',
      status: 200,
      headers: { 'set-cookie': '[REDACTED]', 'x-ratelimit-remaining': '4' },
      body: {
        name: 'r',
        token: '[REDACTED]',
        echoed: 'value [REDACTED]',
        nested: { password: '[REDACTED]' },
      },
    });
    expect(row.url).toContain('page=1');
    expect(row.fetchedAt).toBeInstanceOf(Date);
    expect(response.url).not.toContain(SECRET);
  });

  it('[ADP-061] captures only when asked, and error responses are captured too', async () => {
    const { capture, saved } = sink();
    const { client } = setup([json(200, {}), json(404, { message: 'nope' })], { capture });
    expect((await client.get('/a')).rawResponseId).toBeUndefined();
    await expect(client.get('/b', { capture: true })).rejects.toMatchObject({ code: 'not_found' });
    expect(saved).toHaveLength(1);
    expect(saved[0]?.status).toBe(404);
  });

  it('[ADP-061] stores a marker instead of an oversized text body, and null for an empty one', async () => {
    const { capture, saved } = sink();
    const big = 'x'.repeat(1024 * 1024 + 1);
    const { client } = setup(
      [
        new Response(big, { status: 200, headers: { 'content-type': 'text/plain' } }),
        new Response(null, { status: 204 }),
      ],
      { capture },
    );
    await client.get('/a', { capture: true });
    await client.get('/b', { capture: true });
    expect(saved[0]?.body).toMatchObject({ truncated: true });
    const marker = saved[0]?.body as { bytes: number };
    expect(marker.bytes).toBeGreaterThanOrEqual(big.length);
    expect(saved[1]?.body).toBeNull();
  });

  it('[ADP-061] a failing sink does not fail the request and leaks nothing into the log', async () => {
    const warn = vi.fn();
    const capture: RawCaptureSink = {
      save: async () => {
        throw new Error(`insert failed for ${SECRET}`);
      },
    };
    const { client } = setup([json(200, { ok: 1 })], {
      capture,
      logger: { ...noopLogger, warn },
    });
    const response = await client.get('/a', { capture: true });
    expect(response.rawResponseId).toBeUndefined();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET);
  });

  it('[ADP-061] without a sink, capture is a no-op', async () => {
    const { client } = setup([json(200, {})]);
    expect((await client.get('/a', { capture: true })).rawResponseId).toBeUndefined();
  });
});

describe('ProviderHttpClient secrets in errors and logs', () => {
  it('[ADP-061] errors, causes and logs never carry the credential', async () => {
    const debug = vi.fn();
    const { client } = setup([new TypeError(`connect failed with ${SECRET}`), json(404, {})], {
      logger: { ...noopLogger, debug },
      retry: { attempts: 1 },
    });
    const network = (await client
      .get('/repos/x', { query: { access_token: SECRET } })
      .catch((e: unknown) => e)) as AdapterError;
    const notFound = (await client
      .get(`/repos/x?token=${SECRET}`)
      .catch((e: unknown) => e)) as AdapterError;
    for (const error of [network, notFound]) {
      expect(error.message).not.toContain(SECRET);
      expect(JSON.stringify(error.request)).not.toContain(SECRET);
      expect(String((error.cause as Error | undefined)?.message ?? '')).not.toContain(SECRET);
    }
    expect(JSON.stringify(debug.mock.calls)).not.toContain(SECRET);
  });

  it('[ADP-061] retry logs show the stripped URL only', async () => {
    const debug = vi.fn();
    const { client } = setup([json(503, {}), json(200, {})], { logger: { ...noopLogger, debug } });
    await client.get('/repos/x', { query: { access_token: SECRET } });
    const logged = JSON.stringify(debug.mock.calls);
    expect(logged).toContain('retrying');
    expect(logged).not.toContain(SECRET);
  });
});

describe('ProviderHttpClient telemetry', () => {
  function telemetry() {
    const requests: { labels: Record<string, string>; seconds: number }[] = [];
    const spans: { name: string; attributes: Record<string, unknown>; ended: unknown[] }[] = [];
    const sinkTelemetry: ProviderTelemetry = {
      recordRequest: (labels, seconds) => requests.push({ labels, seconds }),
      startSpan: (name, attributes) => {
        const span = { name, attributes: { ...attributes }, ended: [] as unknown[] };
        spans.push(span);
        return {
          setAttributes: (more) => Object.assign(span.attributes, more),
          end: (error) => span.ended.push(error),
        };
      },
    };
    return { sinkTelemetry, requests, spans };
  }

  it('[ADP-060] records the request metric with provider, endpoint, bucket and status, and ends the span', async () => {
    const { sinkTelemetry, requests, spans } = telemetry();
    const { client } = setup([json(200, {})], { telemetry: sinkTelemetry });
    await client.get('/repos/x');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.labels).toEqual({
      provider: 'acme',
      endpoint: 'repos',
      bucket: 'core',
      status: '200',
    });
    expect(requests[0]?.seconds).toBeGreaterThanOrEqual(0);
    expect(spans[0]).toMatchObject({
      name: 'provider.request',
      attributes: {
        provider: 'acme',
        endpoint: 'repos',
        bucket: 'core',
        method: 'GET',
        status: '200',
      },
      ended: [undefined],
    });
  });

  it('[ADP-060] labels failures: HTTP status, network_error and quota denial; spans end with a stripped error', async () => {
    const { sinkTelemetry, requests, spans } = telemetry();
    const { client } = setup([json(404, {}), new TypeError(`x ${SECRET}`)], {
      telemetry: sinkTelemetry,
      retry: { attempts: 1 },
    });
    await client.get('/repos/x').catch(() => undefined);
    await client.get('/repos/x').catch(() => undefined);
    const denied = setup(
      [],
      { telemetry: sinkTelemetry },
      {
        acquire: async () => ({
          granted: false,
          reason: 'pool',
          bucketKey: KEY,
          retryAt: new Date(Date.now() + 1000),
        }),
      },
    );
    await denied.client.get('/repos/x').catch(() => undefined);
    expect(requests.map((r) => r.labels.status)).toEqual(['404', 'network_error', 'denied_pool']);
    expect(JSON.stringify(spans)).not.toContain(SECRET);
    expect(spans.every((s) => s.ended.length === 1 && typeof s.ended[0] === 'string')).toBe(true);
  });

  it('[ADP-060] works without a span factory and with a bucket label override', async () => {
    const requests: Record<string, string>[] = [];
    const { client } = setup([json(200, {})], {
      telemetry: { recordRequest: (labels) => requests.push(labels) },
      classify: () => ({ endpoint: 'e', buckets: [BUCKET], bucketLabel: 'custom' }),
    });
    await client.get('/x');
    expect(requests[0]?.bucket).toBe('custom');
  });
});

describe('ProviderHttpClient test-environment host allowlist', () => {
  it('[TST-006] refuses a real provider base URL when GM_ENVIRONMENT=test', () => {
    vi.stubEnv('GM_ENVIRONMENT', 'test');
    const { quota } = fakeQuota();
    expect(
      () =>
        new ProviderHttpClient({
          provider: 'acme',
          endpointId: 'ep',
          baseUrl: 'https://api.provider.example/',
          classify,
          authorize: async () => ({ headers: {} }),
          quota,
          logger: noopLogger,
        }),
    ).toThrow(/allowlist/);
  });

  it('[TST-006] reads GM_ENVIRONMENT by default and allows loopback and listed fake hosts', async () => {
    vi.stubEnv('GM_ENVIRONMENT', 'test');
    const { quota } = fakeQuota();
    const fetchFn = vi.fn(async () => json(200, {})) as unknown as typeof fetch;
    const client = new ProviderHttpClient({
      provider: 'acme',
      endpointId: 'ep',
      baseUrl: 'http://fake.internal:8080/',
      classify,
      authorize: async () => ({ headers: {} }),
      quota,
      logger: noopLogger,
      fetch: fetchFn,
      testAllowedHosts: ['fake.internal'],
    });
    await client.get('/repos/x');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('[TST-006] does not apply the allowlist outside the test environment', () => {
    const { quota } = fakeQuota();
    expect(
      () =>
        new ProviderHttpClient({
          provider: 'acme',
          endpointId: 'ep',
          baseUrl: 'https://api.example.com/',
          classify,
          authorize: async () => ({ headers: {} }),
          quota,
          logger: noopLogger,
          environment: 'production',
        }),
    ).not.toThrow();
  });

  it('[TST-006] talks to a real loopback server in the test environment with the default fetch', async () => {
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/hop') {
        res.statusCode = 302;
        res.setHeader('location', '/api/final');
        res.end();
        return;
      }
      res.end(JSON.stringify({ auth: req.headers.authorization ?? null, url: req.url }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const { quota } = fakeQuota();
    const client = new ProviderHttpClient({
      provider: 'acme',
      endpointId: 'ep',
      baseUrl: `http://127.0.0.1:${port}/api`,
      classify,
      authorize: async () => ({ headers: { authorization: 'Bearer abcd' }, secrets: ['abcd'] }),
      quota,
      logger: noopLogger,
      environment: 'test',
    });
    const response = await client.get<{ auth: string; url: string }>('/hop');
    expect(response.body).toEqual({ auth: 'Bearer abcd', url: '/api/final' });
  });
});
