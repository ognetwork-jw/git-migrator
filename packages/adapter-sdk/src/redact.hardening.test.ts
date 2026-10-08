import { bucketKey } from '@git-migrator/quota';
import { describe, expect, it, vi } from 'vitest';
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

describe('redaction runs in linear time', () => {
  const hostile: [string, string][] = [
    ['jwt prefix repeat', 'eyJ-'.repeat(MB / 4)],
    ['jwt dots', 'eyJaaaaa.'.repeat(MB / 9)],
    ['bearer repeat', 'Bearer '.repeat(MB / 7)],
    ['bearer spaces', `Bearer${' '.repeat(MB)}`],
    ['basic repeat', 'Basic a'.repeat(MB / 7)],
    ['token run', 'a'.repeat(MB)],
    ['key begin repeat', '-----BEGIN PRIVATE KEY-----'.repeat(MB / 27)],
    ['key begin spaces', `-----BEGIN ${'A '.repeat(MB / 2)}`],
    ['userinfo repeat', 'http://a:'.repeat(MB / 9)],
    ['userinfo long', `http://${'a'.repeat(MB)}`],
    ['dashes', '-'.repeat(MB)],
    ['dots', '.'.repeat(MB)],
  ];

  it.each(hostile)('[ADP-061] a 1 MB %s input is scrubbed in under 100 ms', (_name, text) => {
    expect(timed(() => stripText(text, { secrets: ['secret-value'] }))).toBeLessThan(100);
  });

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
