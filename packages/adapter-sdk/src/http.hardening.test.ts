import { type BucketSpec, bucketKey } from '@git-migrator/quota';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdapterError } from './errors.ts';
import { isTestEnvironment } from './host-allowlist.ts';
import {
  type Classifier,
  type LeaseGate,
  ProviderHttpClient,
  type ProviderHttpClientOptions,
  parseRetryAfter,
  type RawCaptureInput,
} from './http.ts';
import { noopLogger } from './logger.ts';
import { paginateCursor, paginateLinks, parseLinkHeader } from './pagination.ts';

const KEY = bucketKey('ep', 'acct', 'core');
const BUCKET: BucketSpec = { key: KEY, limit: 100, windowSeconds: 3600 };
const classify: Classifier = () => ({ endpoint: 'e', buckets: [BUCKET] });

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function client(
  replies: Response[],
  options: Partial<ProviderHttpClientOptions> = {},
): { client: ProviderHttpClient; fetchFn: ReturnType<typeof vi.fn> } {
  const queue = [...replies];
  const fetchFn = vi.fn(async () => queue.shift() ?? json(500, {}));
  return {
    fetchFn,
    client: new ProviderHttpClient({
      provider: 'acme',
      endpointId: 'ep',
      baseUrl: 'http://127.0.0.1:9/api/',
      classify,
      authorize: async () => ({
        headers: { authorization: 'Bearer abcdefgh' },
        secrets: ['abcdefgh'],
      }),
      quota: {
        acquire: async () => ({ granted: true, at: new Date(), buckets: [] }),
        recordFeedback: async () => {},
        recordRateLimited: async () => new Date(),
        recordSecondaryLimit: async () => new Date(),
        adjust: async () => {},
      },
      logger: noopLogger,
      fetch: fetchFn as unknown as typeof fetch,
      environment: 'production',
      sleep: async () => {},
      ...options,
    }),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Retry-After parsing', () => {
  const now = new Date('2026-01-01T00:00:00Z');

  it('[ADP-060] accepts non-negative integers and clamps them to 24 h', () => {
    expect(parseRetryAfter('0', now)).toBe(0);
    expect(parseRetryAfter(' 30 ', now)).toBe(30);
    expect(parseRetryAfter('99999999', now)).toBe(86_400);
  });

  it('[ADP-060] rejects negatives, decimals, signs, units and free text', () => {
    for (const bad of ['-5', '1.5', '+3', '10s', '', 'soon', '1e3', '0x10']) {
      expect(parseRetryAfter(bad, now)).toBeUndefined();
    }
  });

  it('[ADP-060] accepts IMF-fixdate, RFC 850 and asctime dates, and gives at least 1 s for the past', () => {
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:02:00 GMT', now)).toBe(120);
    expect(parseRetryAfter('Thursday, 01-Jan-26 00:02:00 GMT', now)).toBe(120);
    expect(parseRetryAfter('Thu Jan  1 00:02:00 2026', now)).toBe(120);
    expect(parseRetryAfter('Thu, 01 Jan 2020 00:00:00 GMT', now)).toBe(1);
    expect(parseRetryAfter('Thu, 01 Jan 2099 00:00:00 GMT', now)).toBe(86_400);
  });

  it('[ADP-060] rejects date formats outside the three HTTP forms', () => {
    expect(parseRetryAfter('2026-01-01T00:02:00Z', now)).toBeUndefined();
    expect(parseRetryAfter('January 1, 2026 00:02:00', now)).toBeUndefined();
    expect(parseRetryAfter('Thu, 32 Foo 2026 00:00:00 GMT', now)).toBeUndefined();
  });
});

describe('Link parsing and pagination hardening', () => {
  it('[ADP-060] parses a hostile 16 KB header in linear time', () => {
    const hostile = `<${'a'.repeat(4000)}${'; x'.repeat(2000)}${'"'.repeat(2000)}${','.repeat(2000)}`;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      parseLinkHeader(hostile);
      parseLinkHeader('<'.repeat(16_000));
      parseLinkHeader(`<u>;${' ;'.repeat(8000)}`);
      best = Math.min(best, performance.now() - started);
    }
    expect(best).toBeLessThan(50);
  });

  it('[ADP-060] still reads rel values with quoted commas and several relations', () => {
    const links = parseLinkHeader('<u1>; title="a, b"; rel="next last", <u2>; rel=prev');
    expect(links).toEqual({ next: 'u1', last: 'u1', prev: 'u2' });
  });

  it('[ADP-060] detects a link loop after normalising query order and fragments', async () => {
    const run = async () => {
      for await (const _ of paginateLinks({
        fetchPage: async () => 1,
        next: (() => {
          const links = ['/r?b=2&a=1', '/r?a=1&b=2#frag'];
          return () => links.shift();
        })(),
      })) {
        // drain
      }
    };
    await expect(run()).rejects.toThrow(/repeated/);
  });

  it('[ADP-060] a link back to the first request is a loop', async () => {
    const run = async () => {
      for await (const _ of paginateLinks({
        firstUrl: 'https://h.test/r?a=1&b=2',
        fetchPage: async () => 1,
        next: () => 'https://h.test/r?b=2&a=1',
      })) {
        // drain
      }
    };
    await expect(run()).rejects.toThrow(/repeated/);
  });

  it('[ADP-060] the default page cap is 1000 and callers may raise it', async () => {
    let n = 0;
    let pages = 0;
    const run = async (maxPages?: number) => {
      n = 0;
      pages = 0;
      for await (const _ of paginateLinks({
        fetchPage: async () => 1,
        next: () => (n++ < 1500 ? `/r?p=${n}` : undefined),
        ...(maxPages !== undefined ? { maxPages } : {}),
      })) {
        pages++;
      }
    };
    await expect(run()).rejects.toThrow(/within 1000 pages/);
    expect(pages).toBe(1000);
    await run(5000);
    expect(pages).toBe(1501);
    let c = 0;
    await expect(
      (async () => {
        for await (const _ of paginateCursor({
          fetchPage: async () => ({ items: [], nextCursor: `c${c++}` }),
        })) {
          // drain
        }
      })(),
    ).rejects.toThrow(/within 1000 pages/);
  });
});

describe('ProviderHttpClient base URL confinement', () => {
  it('[ADP-060] refuses same-origin URLs outside the base path and dot-dot escapes', async () => {
    const { client: c, fetchFn } = client([json(200, {})]);
    await expect(c.get('http://127.0.0.1:9/other/x')).rejects.toMatchObject({ code: 'invalid' });
    await expect(c.get('/../other/x')).rejects.toMatchObject({ code: 'invalid' });
    await expect(c.get('http://127.0.0.1:9/api/../other')).rejects.toMatchObject({
      code: 'invalid',
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('[ADP-060] refuses URLs with userinfo, and a base URL with userinfo', async () => {
    const { client: c, fetchFn } = client([json(200, {})]);
    await expect(c.get('http://u:p@127.0.0.1:9/api/x')).rejects.toMatchObject({
      code: 'invalid',
      retryable: false,
    });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(() => client([], { baseUrl: 'http://u:p@127.0.0.1:9/api/' })).toThrow(/credentials/);
  });

  it('[ADP-060] refuses a redirect that leaves the base path', async () => {
    const { client: c } = client([
      new Response(null, { status: 302, headers: { location: '/elsewhere' } }),
    ]);
    await expect(c.get('/x')).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('ProviderHttpClient credentials and configuration errors', () => {
  it('[ADP-061] wraps an authorize failure as unauthorized with a stripped message and cause', async () => {
    const secret = 'sup3r-secret-token';
    const { client: c, fetchFn } = client([json(200, {})], {
      authorize: async () => {
        throw new Error(`vault said no for ${secret}`);
      },
      tokenShapes: [/sup3r-[a-z0-9-]+/g],
    });
    const error = (await c.get('/x').catch((e: unknown) => e)) as AdapterError;
    expect(error).toBeInstanceOf(AdapterError);
    expect(error.code).toBe('unauthorized');
    expect(JSON.stringify([error.message, String((error.cause as Error).message)])).not.toContain(
      secret,
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('[ADP-061] an authorize network failure is transient and retried', async () => {
    let calls = 0;
    const { client: c } = client([json(200, { ok: 1 })], {
      authorize: async () => {
        if (calls++ === 0) throw new TypeError('fetch failed');
        return { headers: {} };
      },
    });
    expect((await c.get('/x')).body).toEqual({ ok: 1 });
    expect(calls).toBe(2);
  });

  it('[ADP-061] an AdapterError from authorize passes through', async () => {
    const original = new AdapterError({ code: 'forbidden', provider: 'acme', message: 'no' });
    const { client: c } = client([], {
      authorize: async () => {
        throw original;
      },
    });
    await expect(c.get('/x')).rejects.toBe(original);
  });

  it('[ADP-061] refuses a declared secret that is too short to scrub', async () => {
    const { client: c, fetchFn } = client([json(200, {})], {
      authorize: async () => ({ headers: {}, secrets: ['ab'] }),
    });
    await expect(c.get('/x')).rejects.toMatchObject({ code: 'invalid' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('[ADP-060] a request class with an in-flight cap but no LeaseGate is an invalid configuration', async () => {
    const { client: c, fetchFn } = client([json(200, {})], {
      classify: () => ({
        endpoint: 'e',
        buckets: [BUCKET],
        concurrency: { bucketKey: KEY, cap: 2 },
      }),
    });
    await expect(c.get('/x')).rejects.toMatchObject({ code: 'invalid', retryable: false });
    expect(fetchFn).not.toHaveBeenCalled();
    const leases: LeaseGate = { acquire: async () => 1n, release: async () => {} };
    const ok = client([json(200, {})], {
      classify: () => ({
        endpoint: 'e',
        buckets: [BUCKET],
        concurrency: { bucketKey: KEY, cap: 2 },
      }),
      leases,
    });
    expect((await ok.client.get('/x')).status).toBe(200);
  });
});

describe('ProviderHttpClient response size and capture', () => {
  function stream(chunks: number, size: number, pulled: { n: number }): Response {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled.n++;
        if (pulled.n > chunks) controller.close();
        else controller.enqueue(new Uint8Array(size).fill(97));
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });
  }

  it('[ADP-060] stops reading a body that exceeds the limit without buffering the rest', async () => {
    const pulled = { n: 0 };
    const { client: c } = client([stream(10_000, 1024, pulled)], { maxResponseBytes: 8 * 1024 });
    await expect(c.get('/x')).rejects.toMatchObject({ code: 'invalid', retryable: false });
    expect(pulled.n).toBeLessThan(50);
  });

  it('[ADP-060] rejects on a declared Content-Length over the limit before reading', async () => {
    const { client: c } = client(
      [new Response('x', { status: 200, headers: { 'content-length': '999999' } })],
      { maxResponseBytes: 1000 },
    );
    await expect(c.get('/x')).rejects.toMatchObject({ code: 'invalid' });
  });

  it('[ADP-060] reads a body within the limit', async () => {
    const pulled = { n: 0 };
    const { client: c } = client([stream(3, 100, pulled)], { maxResponseBytes: 1000 });
    expect(((await c.get('/x')).body as string).length).toBe(300);
  });

  it('[ADP-061] truncates a captured JSON document over the limit and redacts form bodies', async () => {
    const saved: RawCaptureInput[] = [];
    const capture = {
      save: async (input: RawCaptureInput) => {
        saved.push(input);
        return 'id';
      },
    };
    const huge = json(200, {
      rows: Array.from({ length: 60_000 }, (_, i) => ({ i, pad: 'x'.repeat(20) })),
    });
    const form = new Response('password=hunter2&access_token=abc&grant_type=x', {
      status: 200,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const { client: c } = client([huge, form], { capture });
    await c.get('/a', { capture: true });
    await c.get('/b', { capture: true });
    expect(saved[0]?.body).toMatchObject({ truncated: true });
    const params = new URLSearchParams(saved[1]?.body as string);
    expect(params.get('password')).toBe('[REDACTED]');
    expect(params.get('access_token')).toBe('[REDACTED]');
    expect(params.get('grant_type')).toBe('x');
  });

  it('[ADP-061] adapter token shapes are scrubbed from captures and error text', async () => {
    const saved: RawCaptureInput[] = [];
    const { client: c } = client([json(200, { note: 'see prov_zzzzzzzzzzzzzzzzzzzzzzzzzz' })], {
      capture: {
        save: async (input) => {
          saved.push(input);
          return 'id';
        },
      },
      tokenShapes: [/\bprov_[A-Za-z0-9]{20,}\b/g],
    });
    await c.get('/a', { capture: true });
    expect(JSON.stringify(saved)).not.toContain('prov_');
  });
});

describe('test environment detection', () => {
  it('[TST-006] a runner counts as the test environment when GM_ENVIRONMENT is unset', () => {
    expect(isTestEnvironment(undefined, { VITEST: 'true' })).toBe(true);
    expect(isTestEnvironment(undefined, { NODE_ENV: 'test' })).toBe(true);
    expect(isTestEnvironment(undefined, { NODE_ENV: 'production' })).toBe(false);
    expect(isTestEnvironment('production', { VITEST: 'true' })).toBe(false);
    expect(isTestEnvironment('test', {})).toBe(true);
  });

  it('[TST-006] with VITEST set and GM_ENVIRONMENT unset, a non-loopback host is refused', () => {
    vi.stubEnv('GM_ENVIRONMENT', '');
    expect(() =>
      client([], { baseUrl: 'https://api.provider.example/', environment: undefined }),
    ).toThrow(/allowlist/);
  });
});
