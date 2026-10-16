import { bucketKey } from '@git-migrator/quota';
import { describe, expect, inject, it, vi } from 'vitest';
import { ProviderHttpClient, type QuotaGate } from './http.ts';
import { noopLogger } from './logger.ts';
import {
  isSensitiveKey,
  REDACTED,
  stripBody,
  stripHeaders,
  stripText,
  stripUrl,
} from './redact.ts';

const MB = 1024 * 1024;

/** Wall-clock budgets scale with GM_TEST_TIME_FACTOR (ADR-0507). */
const budget = (ms: number): number => ms * inject('timeFactor');

/** Best of three, so a busy machine does not turn a linear scan into a flaky failure. */
function timed(run: () => unknown): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 3; i++) {
    const started = performance.now();
    run();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

/** Linear time gives about 4 for four times the input; quadratic gives about 16. */
const MAX_GROWTH = 10;

/**
 * Times `scrub` on an input of a quarter of `size` and on one of `size`. Both measurements see the
 * same load, so their ratio says whether the scan is linear even on a busy machine. The pair is
 * measured again (three times at most) while it looks too slow, so one stall is not a failure
 * (ADR-0507).
 */
function growth(make: (size: number) => string, size: number, scrub: (text: string) => unknown) {
  const small = make(size / 4);
  const large = make(size);
  let ratio = Number.POSITIVE_INFINITY;
  let largeMs = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 3 && (ratio >= MAX_GROWTH || largeMs >= budget(500)); i++) {
    const smallMs = timed(() => scrub(small));
    const pairLargeMs = timed(() => scrub(large));
    // A floor keeps sub-millisecond timer noise on the small input from inflating the ratio.
    ratio = Math.min(ratio, pairLargeMs / Math.max(smallMs, 0.5));
    largeMs = Math.min(largeMs, pairLargeMs);
  }
  return { ratio, largeMs };
}

describe('redaction runs in linear time', () => {
  const hostile: [string, (size: number) => string][] = [
    ['jwt prefix repeat', (n) => 'eyJ-'.repeat(n / 4)],
    ['jwt dots', (n) => 'eyJaaaaa.'.repeat(n / 9)],
    ['bearer repeat', (n) => 'Bearer '.repeat(n / 7)],
    ['bearer spaces', (n) => `Bearer${' '.repeat(n)}`],
    ['basic repeat', (n) => 'Basic a'.repeat(n / 7)],
    ['token run', (n) => 'a'.repeat(n)],
    ['key begin repeat', (n) => '-----BEGIN PRIVATE KEY-----'.repeat(n / 27)],
    ['key begin spaces', (n) => `-----BEGIN ${'A '.repeat(n / 2)}`],
    ['userinfo repeat', (n) => 'http://a:'.repeat(n / 9)],
    ['userinfo long', (n) => `http://${'a'.repeat(n)}`],
    ['dashes', (n) => '-'.repeat(n)],
    ['dots', (n) => '.'.repeat(n)],
  ];

  it.each(hostile)(
    '[ADP-061] a 1 MB %s input is scrubbed in linear time, within 500 ms',
    (_name, make) => {
      const { ratio, largeMs } = growth(make, MB, (text) =>
        stripText(text, { secrets: ['secret-value'] }),
      );
      expect(ratio).toBeLessThan(MAX_GROWTH);
      expect(largeMs).toBeLessThan(budget(500));
    },
    30_000,
  );

  it('[ADP-061] cuts text over the scan limit before scanning', () => {
    const out = stripText('a'.repeat(3 * MB));
    expect(out.length).toBeLessThanOrEqual(MB);
  });

  it('[ADP-061] still redacts a JWT, a long token run and the remainder after it', () => {
    const jwt = 'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.c2lnbmF0dXJl';
    expect(stripText(`t=${jwt} end`)).toBe(`t=${REDACTED} end`);
  });
});

describe('declared secrets are scrubbed before shapes', () => {
  it('[ADP-061] a secret inside a Bearer token is removed whole, including punctuation', () => {
    const out = stripText('auth: Bearer abcd1234!xyz9876 done', { secrets: ['abcd1234!xyz9876'] });
    expect(out).not.toContain('xyz9876');
    expect(out).not.toContain('abcd1234');
  });

  it('[ADP-061] a 40-character secret is fully removed by a 36-character adapter shape too', () => {
    const secret = `tkn_${'a1B2c3D4e5'.repeat(3)}${'Zz9Yy8'}`;
    expect(secret).toHaveLength(40);
    const out = stripText(`value ${secret} end`, {
      secrets: [secret],
      shapes: [/\btkn_[A-Za-z0-9]{32}\b/g],
    });
    expect(out).toBe(`value ${REDACTED} end`);
  });
});

describe('sensitive keys', () => {
  it('[ADP-061] redacts pwd, sessionId, jwt, otp, sshKey, auth, pass and assertion fields', () => {
    const out = stripBody({
      pwd: 'a',
      sessionId: 'b',
      jwt: 'c',
      otp: 'd',
      sshKey: 'e',
      auth: 'f',
      pass: 'g',
      samlAssertion: 'h',
      author: 'octocat',
      footprint: 'x',
      passenger: 'y',
    }) as Record<string, string>;
    for (const key of [
      'pwd',
      'sessionId',
      'jwt',
      'otp',
      'sshKey',
      'auth',
      'pass',
      'samlAssertion',
    ]) {
      expect(out[key]).toBe(REDACTED);
    }
    expect(out.author).toBe('octocat');
    expect(out.footprint).toBe('x');
    expect(out.passenger).toBe('y');
  });

  it('[ADP-061] query and body rules share the word list; query adds key, sig and code', () => {
    expect(isSensitiveKey('session_id')).toBe(true);
    const url = stripUrl('https://h.test/x?session=1&jwt=2&key=3&sig=4&code=5&author=bob&page=2');
    for (const name of ['session', 'jwt', 'key', 'sig', 'code']) {
      expect(url).toContain(`${name}=${REDACTED}`);
    }
    expect(url).toContain('author=bob');
    expect(url).toContain('page=2');
    expect(stripBody({ key: 'variable-name', code: 'x' })).toEqual({
      key: 'variable-name',
      code: 'x',
    });
  });
});

describe('encoded secrets', () => {
  it('[ADP-061] a secret survives neither percent-encoding nor URLSearchParams serialisation', () => {
    const out = stripUrl('https://h.test/x?q=pa+ss%21word&other=1', { secrets: ['pa ss!word'] });
    expect(out).not.toContain('pa+ss');
    expect(out).not.toContain('ss%21word');
    expect(out).toContain('other=1');
    expect(stripText('a=pa%20ss%21word', { secrets: ['pa ss!word'] })).toBe(`a=${REDACTED}`);
  });
});

describe('response headers', () => {
  it('[ADP-061] scrubs declared secrets and shapes in ordinary header values', () => {
    const out = stripHeaders(
      new Headers({
        Warning: '199 - "token prov_zzzzzzzzzzzzzzzzzzzzzzzzzz"',
        'X-Trace': 'abc hunter22 def',
        'Content-Type': 'application/json',
      }),
      { secrets: ['hunter22'], shapes: [/\bprov_[A-Za-z0-9]{20,64}\b/g] },
    );
    expect(out.warning).not.toContain('prov_');
    expect(out['x-trace']).toBe(`abc ${REDACTED} def`);
    expect(out['content-type']).toBe('application/json');
  });

  it('[ADP-061] strips Link and Location as URLs', () => {
    const out = stripHeaders(
      new Headers({
        Link: '<https://h.test/r?access_token=abc12345&page=2>; rel="next", <https://h.test/r?s=hunter22>; rel="last"',
        Location: 'https://u:p@h.test/y?code=zzz&a=1',
      }),
      { secrets: ['hunter22'] },
    );
    expect(out.link).not.toMatch(/abc12345|hunter22/);
    expect(out.link).toContain('page=2');
    expect(out.link).toContain('rel="next"');
    expect(out.location).not.toMatch(/u:p|zzz/);
    expect(out.location).toContain('a=1');
  });
});

describe('Basic and Bearer shapes', () => {
  it('[ADP-061] leaves ordinary words alone', () => {
    for (const text of [
      'Basic authentication required',
      'Bearer authentication is needed',
      'Basic information about the repository',
    ]) {
      expect(stripText(text)).toBe(text);
    }
  });

  it('[ADP-061] redacts credential-looking values', () => {
    expect(stripText('Authorization: Basic dXNlcjpwYXNz')).toBe(`Authorization: ${REDACTED}`);
    expect(stripText('Bearer abc.def-123_xyz')).toBe(REDACTED);
    expect(stripText('Bearer 12345678')).toBe(REDACTED);
    expect(stripText('Basic dXNlcjpwYXNzd29yZA==')).toBe(REDACTED);
  });
});

describe('authorize runs before quota', () => {
  const key = bucketKey('ep', 'acct', 'core');
  function build(authorize: () => Promise<{ headers: Record<string, string> }>) {
    const acquire = vi.fn(async () => ({ granted: true as const, at: new Date(), buckets: [] }));
    const quota: QuotaGate = {
      acquire,
      recordFeedback: async () => {},
      recordRateLimited: async () => new Date(),
      recordSecondaryLimit: async () => new Date(),
      adjust: async () => {},
    };
    const fetchFn = vi.fn(async () => new Response('{}', { status: 200 }));
    const client = new ProviderHttpClient({
      provider: 'acme',
      endpointId: 'ep',
      baseUrl: 'http://127.0.0.1:9/api/',
      classify: () => ({
        endpoint: 'e',
        buckets: [{ key, limit: 10, windowSeconds: 60 }],
      }),
      authorize,
      quota,
      logger: noopLogger,
      fetch: fetchFn as unknown as typeof fetch,
      environment: 'production',
      sleep: async () => {},
    });
    return { client, acquire, fetchFn };
  }

  it('[ADP-060] a failing authorize acquires no quota and sends nothing', async () => {
    const { client, acquire, fetchFn } = build(async () => {
      throw new Error('vault down');
    });
    await expect(client.get('/x')).rejects.toMatchObject({ code: 'unauthorized' });
    expect(acquire).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('[ADP-060] a TypeError bug in authorize is unauthorized and is not retried', async () => {
    let calls = 0;
    const { client } = build(async () => {
      calls++;
      throw new TypeError("Cannot read properties of undefined (reading 'token')");
    });
    await expect(client.get('/x')).rejects.toMatchObject({
      code: 'unauthorized',
      retryable: false,
    });
    expect(calls).toBe(1);
  });

  it('[ADP-060] a system error code or a fetch failure in authorize is transient and retried', async () => {
    let calls = 0;
    const { client } = build(async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
      if (calls === 2) throw new TypeError('fetch failed');
      return { headers: {} };
    });
    expect((await client.get('/x')).status).toBe(200);
    expect(calls).toBe(3);
  });
});
