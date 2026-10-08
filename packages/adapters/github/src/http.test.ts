import { AdapterError, bucketKey } from '@git-migrator/adapter-sdk';
import { describe, expect, it } from 'vitest';
import { cacheKey, InstallationTokenCache, signAppJwt } from './auth.ts';
import { parseConfig } from './config.ts';
import { all, keyPair, setup } from './harness.test.ts';
import { createClassifier, createInterpreter, endpointLabel, TOKEN_SHAPES } from './http.ts';

const opts = {
  endpointId: 'gh',
  accountKey: 'acct',
  config: { maxConcurrentRequests: 10, quotaOverrides: {} },
  leases: true,
};

function headers(h: Record<string, string>) {
  return new Headers(h);
}

describe('App token caching', () => {
  it('[JOB-045] signs an RS256 JWT with iat 60 s back and at most 10 minutes of life', () => {
    const { privateKey } = keyPair();
    const now = new Date('2026-01-01T00:10:00Z');
    const jwt = signAppJwt(7, privateKey, now);
    const claims = JSON.parse(Buffer.from(jwt.split('.')[1] as string, 'base64url').toString());
    expect(JSON.parse(Buffer.from(jwt.split('.')[0] as string, 'base64url').toString()).alg).toBe(
      'RS256',
    );
    expect(claims.iss).toBe('7');
    expect(claims.iat).toBe(now.getTime() / 1000 - 60);
    expect(claims.exp - now.getTime() / 1000).toBeLessThanOrEqual(600);
  });

  it('[JOB-045] a bad key is unauthorized and never echoed', () => {
    try {
      signAppJwt(7, 'not a key SECRETVALUE', new Date());
      expect.unreachable();
    } catch (error) {
      expect((error as AdapterError).code).toBe('unauthorized');
      expect((error as Error).message).not.toContain('SECRETVALUE');
    }
  });

  it('[JOB-045] caches until 5 minutes before expiry, then refreshes', async () => {
    let clock = new Date('2026-01-01T00:00:00Z');
    const cache = new InstallationTokenCache(() => clock);
    let minted = 0;
    const mint = async () => {
      minted += 1;
      return { token: `ghs_token${minted}`, expiresAt: new Date(clock.getTime() + 3600_000) };
    };
    expect((await cache.get('k', mint)).token).toBe('ghs_token1');
    clock = new Date(clock.getTime() + 54 * 60_000);
    expect((await cache.get('k', mint)).token).toBe('ghs_token1');
    clock = new Date(clock.getTime() + 2 * 60_000);
    expect((await cache.get('k', mint)).token).toBe('ghs_token2');
    cache.invalidate('k');
    expect((await cache.get('k', mint)).token).toBe('ghs_token3');
  });

  it('[JOB-045] is single-flight per installation and does not cache failures', async () => {
    const cache = new InstallationTokenCache();
    let minted = 0;
    const mint = async () => {
      minted += 1;
      await new Promise((r) => setTimeout(r, 5));
      return { token: 'ghs_abcdef', expiresAt: new Date(Date.now() + 3600_000) };
    };
    const tokens = await Promise.all(Array.from({ length: 8 }, () => cache.get('a', mint)));
    expect(minted).toBe(1);
    expect(new Set(tokens.map((t) => t.token)).size).toBe(1);
    let failures = 0;
    const bad = async () => {
      failures += 1;
      throw new Error('boom');
    };
    await expect(cache.get('b', bad)).rejects.toThrow('boom');
    await expect(cache.get('b', bad)).rejects.toThrow('boom');
    expect(failures).toBe(2);
  });

  it('[JOB-045] the cache key holds a digest, not the private key', () => {
    expect(cacheKey('https://api.github.com', 1, 2, 'PEMSECRET')).not.toContain('PEMSECRET');
  });

  it('[JOB-045] the connection mints one installation token for many requests and shares it across connects', async () => {
    const h = await setup();
    await h.conn.inventory.listNamespaces();
    await h.conn.inventory.getRepository(h.repo('nope'));
    await h.conn.inventory.findRepository(h.org, 'nope');
    const mints = h.requests.filter((r) => r.url.includes('/access_tokens'));
    expect(mints).toHaveLength(1);
  });

  it('[JOB-045] git credentials come from the cached token', async () => {
    const h = await setup();
    const a = await h.conn.git.credential(h.repo('r'));
    const b = await h.conn.git.credential(h.repo('r'));
    expect(a.username).toBe('x-access-token');
    expect(a.password).toBe(b.password);
    expect(a.password.startsWith('ghs_')).toBe(true);
    expect(a.expiresAt).toBeInstanceOf(Date);
    expect(h.conn.git.remoteUrl(h.repo('r'))).toBe('http://localhost:4020/acme/r.git');
  });
});

describe('config', () => {
  it('[JOB-045] treats appId and installationId 0 as unset (ADR-0051)', () => {
    expect(() => parseConfig({ org: 'acme', appId: 0, installationId: 5 })).toThrow(AdapterError);
    expect(() => parseConfig({ org: 'acme', appId: 3, installationId: 0 })).toThrow(
      /not configured/,
    );
    expect(parseConfig({ org: 'acme', appId: 3, installationId: 5 }).gitBaseUrl).toBe(
      'https://github.com',
    );
  });

  it('[JOB-045] rejects unknown options', () => {
    expect(() => parseConfig({ org: 'acme', appId: 3, installationId: 5, surprise: 1 })).toThrow(
      AdapterError,
    );
  });
});

describe('classifier', () => {
  const classify = createClassifier(opts);

  it('[JOB-045] reads charge core; writes also charge the 80/min and 500/h buckets', () => {
    const read = classify({ method: 'GET', path: '/repos/acme/r' });
    expect(read.buckets.map((b) => b.key)).toEqual([bucketKey('gh', 'acct', 'core')]);
    const write = classify({ method: 'PUT', path: '/repos/acme/r/collaborators/x' });
    expect(write.buckets.map((b) => [b.key.split(':')[2], b.limit, b.windowSeconds])).toEqual([
      ['core', 5000, 3600],
      ['content-minute', 80, 60],
      ['content-hour', 500, 3600],
    ]);
  });

  it('[JOB-045] GraphQL has its own resource', () => {
    const c = classify({ method: 'POST', path: '/graphql' });
    expect(c.buckets.map((b) => b.key.split(':')[2])).toEqual(['graphql']);
  });

  it('[JOB-045] every request carries the in-flight cap lease (default 10)', () => {
    expect(classify({ method: 'GET', path: '/orgs/acme' }).concurrency).toEqual({
      bucketKey: bucketKey('gh', 'acct', 'concurrent'),
      cap: 10,
    });
    const noLeases = createClassifier({ ...opts, leases: false });
    expect(noLeases({ method: 'GET', path: '/orgs/acme' }).concurrency).toBeUndefined();
  });

  it('[JOB-043] quota overrides replace the default limits', () => {
    const c = createClassifier({
      ...opts,
      config: { maxConcurrentRequests: 3, quotaOverrides: { core: 100 } },
    });
    expect(c({ method: 'GET', path: '/x' }).buckets[0]?.limit).toBe(100);
    expect(c({ method: 'GET', path: '/x' }).concurrency?.cap).toBe(3);
  });

  it('[ADP-060] endpoint labels are low-cardinality', () => {
    expect(endpointLabel('GET', '/repos/acme/some-repo/keys')).toBe('repos.keys.get');
    expect(endpointLabel('PUT', '/repos/acme/r/collaborators/bob')).toBe(
      'repos.collaborators.:id.put',
    );
    expect(endpointLabel('GET', '/orgs/acme/teams/x/members')).toBe('orgs.teams.:id.members.get');
  });

  it('[JOB-045] requests hold a lease and acquire the content buckets through the client', async () => {
    const h = await setup();
    h.fake.state.addRepository('acme', { name: 'r', private: true });
    h.quota.calls.acquire.length = 0;
    await h.conn.refs.setDefaultBranch(h.repo('r'), 'main').catch(() => undefined);
    await h.ctx.http.request({
      method: 'PATCH',
      path: '/repos/acme/r',
      json: { description: 'x' },
    });
    const patch = h.quota.calls.acquire.at(-1);
    expect(patch?.keys.map((k) => k.split(':')[2])).toEqual([
      'core',
      'content-minute',
      'content-hour',
    ]);
    expect(patch?.pool).toBe('interactive');
    expect(h.leases.log.acquired.length).toBeGreaterThan(0);
    expect(h.leases.log.released).toBe(h.leases.log.acquired.length);
  });
});

describe('interpret', () => {
  const interpret = createInterpreter({
    endpointId: 'gh',
    accountKey: 'acct',
    config: { quotaOverrides: {} },
    now: () => new Date(1_000_000 * 1000),
  });
  const res = (
    status: number,
    h: Record<string, string>,
    body: unknown = {},
    path = '/repos/x',
  ) => ({
    status,
    headers: headers(h),
    body,
    method: 'GET',
    path,
    grantedAt: new Date(),
  });

  it('[JOB-045] parses x-ratelimit-* with the resource into fixed-window feedback', () => {
    const out = interpret(
      res(200, {
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '900',
        'x-ratelimit-reset': '1003600',
        'x-ratelimit-resource': 'graphql',
      }),
    );
    expect(out?.feedback).toEqual([
      {
        bucketKey: bucketKey('gh', 'acct', 'graphql'),
        limit: 5000,
        windowSeconds: 3600,
        remaining: 900,
        nearLimit: true,
        resetAt: new Date(1003600 * 1000),
        fixedWindow: true,
      },
    ]);
  });

  it('[JOB-045] does not call it near the limit with plenty left', () => {
    const out = interpret(
      res(200, { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4000' }),
    );
    expect(out?.feedback?.[0]?.nearLimit).toBe(false);
    expect(out?.feedback?.[0]?.bucketKey).toBe(bucketKey('gh', 'acct', 'core'));
  });

  it('[JOB-045] ignores malformed headers', () => {
    expect(
      interpret(res(200, { 'x-ratelimit-limit': 'lots', 'x-ratelimit-resource': 'a b' })),
    ).toBeUndefined();
  });

  it('[JOB-045] a secondary limit is classified, with retry-after', () => {
    const out = interpret(
      res(403, { 'retry-after': '42' }, { message: 'You have exceeded a secondary rate limit.' }),
    );
    expect(out?.signal).toEqual({ kind: 'secondary-limit', retryAfterSeconds: 42 });
  });

  it('[JOB-045] a secondary limit without retry-after leaves the wait to the quota service', () => {
    const out = interpret(res(429, {}, { message: 'secondary rate limit' }));
    expect(out?.signal).toEqual({ kind: 'secondary-limit' });
  });

  it('[JOB-045] an exhausted primary limit waits until x-ratelimit-reset', () => {
    const out = interpret(
      res(
        403,
        { 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '60', 'x-ratelimit-reset': '1000120' },
        { message: 'API rate limit exceeded' },
      ),
    );
    expect(out?.signal).toEqual({ kind: 'rate-limited', retryAfterSeconds: 120 });
  });

  it('[ADP-050] a plain 403 is forbidden, not a limit', () => {
    const out = interpret(res(403, {}, { message: 'Resource not accessible by integration' }));
    expect(out?.signal).toBeUndefined();
    expect(out?.code).toBe('forbidden');
  });

  it('[FAC-DKY-002] a 422 "already in use" is a conflict', () => {
    const out = interpret(
      res(
        422,
        {},
        { message: 'Validation Failed', errors: [{ message: 'key is already in use' }] },
      ),
    );
    expect(out?.code).toBe('conflict');
  });

  it('[JOB-045] GraphQL cost is reconciled and mutations charge the content buckets', () => {
    const cost = interpret(res(200, {}, { data: { rateLimit: { cost: 4 } } }, '/graphql'));
    expect(cost?.adjust).toEqual([{ bucketKey: bucketKey('gh', 'acct', 'graphql'), delta: 3 }]);
    const mutation = interpret(
      res(200, {}, { data: { createBranchProtectionRule: {} } }, '/graphql'),
    );
    expect(mutation?.adjust?.map((a) => a.bucketKey.split(':')[2])).toEqual([
      'content-minute',
      'content-hour',
    ]);
  });

  it('[ADP-061] a 401 drops the cached token', () => {
    let dropped = 0;
    const i = createInterpreter({
      endpointId: 'gh',
      accountKey: 'acct',
      config: { quotaOverrides: {} },
      onUnauthorized: () => {
        dropped += 1;
      },
    });
    i(res(401, {}, { message: 'Bad credentials' }));
    expect(dropped).toBe(1);
  });
});

describe('through the client', () => {
  it('[JOB-045] records feedback with the grant stamp for each response', async () => {
    const h = await setup();
    await all(undefined);
    await h.conn.inventory.listNamespaces();
    const fb = h.quota.calls.feedback.at(-1);
    expect(fb?.fixedWindow).toBe(true);
    expect(fb?.limit).toBeGreaterThan(0);
  });

  it('[JOB-045] a secondary limit is recorded as such and surfaces as rate_limited', async () => {
    const h = await setup();
    h.fake.state.config.forced = { requests: 1, retryAfterSeconds: 42 };
    await expect(h.conn.inventory.listNamespaces()).rejects.toMatchObject({
      code: 'rate_limited',
      retryable: true,
    });
    expect(h.quota.calls.secondary.at(-1)?.retryAfterSeconds).toBe(42);
  });

  it('[JOB-045] a primary limit is recorded as rate-limited', async () => {
    const h = await setup({ config: { primary: { limits: { core: 1 } } } });
    await h.conn.inventory.listNamespaces();
    await expect(h.conn.inventory.listNamespaces()).rejects.toMatchObject({ code: 'rate_limited' });
    expect(h.quota.calls.rateLimited.length).toBe(1);
  });

  it('[ADP-061] provider token shapes are scrubbed', () => {
    const text = 'x ghs_abcdefghijklmnopqrstuvwxyz0123 y github_pat_11ABCDEFG0abcdefghij_klmnop';
    let out = text;
    for (const shape of TOKEN_SHAPES) out = out.replace(shape, '[R]');
    expect(out).toBe('x [R] y [R]');
  });

  it('[ADP-061] token shapes are linear on hostile input', () => {
    const hostile = `ghp_${'a'.repeat(1_000_000)}`;
    const started = performance.now();
    for (const shape of TOKEN_SHAPES) hostile.replace(shape, '[R]');
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
