import { describe, expect, it } from 'vitest';
import { world } from './harness.ts';

const NOW = Date.parse('2026-10-08T12:00:00Z');

describe('primary rate limit', () => {
  it('[TST-011] sends x-ratelimit-* headers (not x-rate-limit-*) on every authenticated response', async () => {
    const w = world({ clock: () => NOW });
    const a = await w.call('GET', '/repos/acme/auto-ok');
    const b = await w.call('GET', '/repos/acme/nope');
    expect(a.headers.get('x-ratelimit-limit')).toBe('5000');
    expect(a.headers.get('x-ratelimit-remaining')).toBe('4999');
    expect(a.headers.get('x-ratelimit-used')).toBe('1');
    expect(a.headers.get('x-ratelimit-resource')).toBe('core');
    expect(a.headers.get('x-ratelimit-reset')).toBe(String(NOW / 1000 + 3600));
    expect(b.status).toBe(404);
    expect(b.headers.get('x-ratelimit-remaining')).toBe('4998');
    expect([...a.headers.keys()].filter((k) => k.startsWith('x-rate-limit'))).toEqual([]);
  });

  it('[TST-011] GET /rate_limit does not count against the limit and lists the resources', async () => {
    const w = world({ clock: () => NOW });
    await w.call('GET', '/orgs/acme');
    const r = await w.spec('/rate_limit', 'get', '/rate_limit', {}, 200);
    expect(r.body.resources.core).toMatchObject({ limit: 5000, used: 1, remaining: 4999 });
    expect(Object.keys(r.body.resources)).toEqual(
      expect.arrayContaining([
        'core',
        'graphql',
        'search',
        'code_search',
        'integration_manifest',
        'dependency_sbom',
        'copilot_usage_records',
      ]),
    );
    expect(r.body.rate).toEqual(r.body.resources.core);
    expect(r.headers.get('x-ratelimit-remaining')).toBe('4999');
    const again = await w.call('GET', '/rate_limit');
    expect(again.body.resources.core.used).toBe(1);
  });

  it('[JOB-045] exceeding the limit is a 403 with remaining 0 until the window resets', async () => {
    let now = NOW;
    const w = world({ clock: () => now, config: { primary: { limits: { core: 2 } } } });
    expect((await w.call('GET', '/orgs/acme')).status).toBe(200);
    expect((await w.call('GET', '/orgs/acme')).status).toBe(200);
    const over = await w.call('GET', '/orgs/acme');
    expect(over.status).toBe(403);
    expect(over.body.message).toMatch(/^API rate limit exceeded for installation ID \d+\.$/);
    expect(over.headers.get('x-ratelimit-remaining')).toBe('0');
    expect(over.headers.get('x-ratelimit-reset')).toBe(String(NOW / 1000 + 3600));
    expect(over.headers.get('retry-after')).toBeNull();
    // /rate_limit still works and shows the exhausted bucket
    expect((await w.call('GET', '/rate_limit')).body.resources.core.remaining).toBe(0);
    now += 3600_000;
    expect((await w.call('GET', '/orgs/acme', { token: w.fake.token() })).status).toBe(200);
  });

  it('[JOB-045] 429 variant and a shorter window are configurable', async () => {
    let now = NOW;
    const w = world({
      clock: () => now,
      config: { primary: { limits: { core: 1 }, status: 429, windowMs: 1000 } },
    });
    await w.call('GET', '/orgs/acme');
    const over = await w.call('GET', '/orgs/acme');
    expect(over.status).toBe(429);
    expect(over.headers.get('x-ratelimit-reset')).toBe(String(NOW / 1000 + 1));
    now += 1000;
    expect((await w.call('GET', '/orgs/acme')).status).toBe(200);
  });

  it('[TST-011] the default limit follows the doc formula: +50 per repository and member above 20, cap 12,500, 15,000 on Cloud', async () => {
    const w = world();
    const s = w.fake.state;
    for (let i = 0; i < 30; i++) s.addRepository('acme', { name: `r${i}` }); // 32 repos: +600
    expect(w.fake.limiter.limitFor(await authOf(w), 'core')).toBe(5600);
    for (let i = 0; i < 40; i++) s.addMember('acme', `u${i}`); // 42 members: +1100
    expect(w.fake.limiter.limitFor(await authOf(w), 'core')).toBe(6700);
    for (let i = 0; i < 200; i++) s.addRepository('acme', { name: `x${i}` });
    expect(w.fake.limiter.limitFor(await authOf(w), 'core')).toBe(12500);
    s.requireOrg('acme').plan.name = 'enterprise';
    expect(w.fake.limiter.limitFor(await authOf(w), 'core')).toBe(15000);
  });

  it('[TST-011] buckets are per installation', async () => {
    const w = world({ clock: () => NOW });
    const other = w.fake.state.addInstallation({ account: 'acme' });
    const t2 = w.fake.token({ installationId: other.id });
    await w.call('GET', '/orgs/acme');
    await w.call('GET', '/orgs/acme');
    expect(
      (await w.call('GET', '/orgs/acme', { token: t2 })).headers.get('x-ratelimit-remaining'),
    ).toBe('4999');
  });

  it('[TST-011] GraphQL has its own resource', async () => {
    const w = world({ clock: () => NOW });
    const res = await w.call('POST', '/graphql', {
      body: { query: '{ rateLimit { cost limit remaining used resetAt } }' },
    });
    expect(res.headers.get('x-ratelimit-resource')).toBe('graphql');
    expect(res.headers.get('x-ratelimit-remaining')).toBe('4999');
    expect(res.body.data.rateLimit).toMatchObject({
      cost: 1,
      limit: 5000,
      remaining: 4999,
      used: 1,
    });
    expect((await w.call('GET', '/rate_limit')).body.resources.graphql.used).toBe(1);
    expect((await w.call('GET', '/orgs/acme')).headers.get('x-ratelimit-remaining')).toBe('4999');
  });

  it('[TST-011] GraphQL primary limit exhaustion', async () => {
    const w = world({ config: { primary: { limits: { graphql: 1 } } } });
    const q = { query: '{ organization(login:"acme") { login } }' };
    expect((await w.call('POST', '/graphql', { body: q })).status).toBe(200);
    expect((await w.call('POST', '/graphql', { body: q })).status).toBe(403);
  });
});

async function authOf(w: ReturnType<typeof world>) {
  const { authenticate } = await import('./auth.ts');
  return authenticate(w.fake.state, `Bearer ${w.token}`);
}

describe('secondary rate limit', () => {
  it('[JOB-045] a forced secondary limit is a 403 with retry-after, then clears', async () => {
    const w = world();
    await w.call('POST', '/__config', {
      body: { forced: { requests: 2, retryAfterSeconds: 42 } },
      token: null,
    });
    const a = await w.call('GET', '/orgs/acme');
    expect(a.status).toBe(403);
    expect(a.headers.get('retry-after')).toBe('42');
    expect(a.body.message).toContain('secondary rate limit');
    expect(a.body.documentation_url).toContain('secondary-rate-limits');
    expect((await w.call('GET', '/orgs/acme')).status).toBe(403);
    expect((await w.call('GET', '/orgs/acme')).status).toBe(200);
  });

  it('[JOB-045] 429 without retry-after, restricted to matching requests', async () => {
    const w = world();
    w.fake.state.config.forced = {
      requests: 5,
      status: 429,
      retryAfter: false,
      match: '^POST /orgs/acme/repos$',
    };
    expect((await w.call('GET', '/orgs/acme')).status).toBe(200);
    const res = await w.call('POST', '/orgs/acme/repos', { body: { name: 'n' } });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeNull();
    expect(res.headers.get('x-ratelimit-remaining')).not.toBeNull();
    expect(w.fake.state.config.forced?.requests).toBe(4);
  });

  it('[JOB-045] a secondary limit does not consume the primary budget', async () => {
    const w = world();
    w.fake.state.config.forced = { requests: 1 };
    await w.call('GET', '/orgs/acme');
    expect((await w.call('GET', '/orgs/acme')).headers.get('x-ratelimit-used')).toBe('1');
  });

  it('[JOB-045] REST points per minute per endpoint: GET costs 1, POST costs 5; the window rolls', async () => {
    let now = NOW;
    const w = world({ clock: () => now, config: { secondary: { restPointsPerMinute: 10 } } });
    for (let i = 0; i < 10; i++) expect((await w.call('GET', '/orgs/acme')).status).toBe(200);
    const over = await w.call('GET', '/orgs/acme');
    expect(over.status).toBe(403);
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    // another endpoint has its own budget
    expect((await w.call('GET', '/orgs/acme/members')).status).toBe(200);
    now += 61_000;
    expect((await w.call('GET', '/orgs/acme')).status).toBe(200);
    // two POSTs = 10 points, the third is over
    expect(
      (await w.call('POST', '/orgs/acme/invitations', { body: { email: 'a@test.local' } })).status,
    ).toBe(201);
    expect(
      (await w.call('POST', '/orgs/acme/invitations', { body: { email: 'b@test.local' } })).status,
    ).toBe(201);
    expect(
      (await w.call('POST', '/orgs/acme/invitations', { body: { email: 'c@test.local' } })).status,
    ).toBe(403);
  });

  it('[JOB-045] content creation per minute and per hour', async () => {
    let now = NOW;
    const w = world({
      clock: () => now,
      config: { secondary: { contentCreationPerMinute: 3, contentCreationPerHour: 5 } },
    });
    const post = (i: number) => w.call('POST', '/orgs/acme/repos', { body: { name: `c${i}` } });
    for (let i = 0; i < 3; i++) expect((await post(i)).status).toBe(201);
    expect((await post(3)).status).toBe(403);
    now += 61_000;
    expect((await post(4)).status).toBe(201);
    expect((await post(5)).status).toBe(201);
    now += 61_000;
    expect((await post(6)).status).toBe(403); // 5 per hour spent
  });

  it('[JOB-045] concurrency limit and GraphQL points', async () => {
    const w = world({ config: { secondary: { concurrent: 0 } } });
    expect((await w.call('GET', '/orgs/acme')).status).toBe(403);
    const g = world({ config: { secondary: { graphqlPointsPerMinute: 6 } } });
    const query = { query: '{ organization(login:"acme") { login } }' };
    const mutation = {
      query: `mutation { createBranchProtectionRule(input:{repositoryId:"${g.repo.nodeId}", pattern:"a"}) { clientMutationId } }`,
    };
    expect((await g.call('POST', '/graphql', { body: mutation })).status).toBe(200); // 5 points
    expect((await g.call('POST', '/graphql', { body: query })).status).toBe(200); // 6
    const over = await g.call('POST', '/graphql', { body: query });
    expect(over.status).toBe(403);
    expect(over.headers.get('retry-after')).not.toBeNull();
  });

  it('[JOB-045] limits can be disabled with null', async () => {
    const w = world({
      config: {
        secondary: {
          restPointsPerMinute: null,
          contentCreationPerMinute: null,
          contentCreationPerHour: null,
          concurrent: null,
        },
      },
    });
    for (let i = 0; i < 100; i++) expect((await w.call('GET', '/orgs/acme')).status).toBe(200);
  });
});
