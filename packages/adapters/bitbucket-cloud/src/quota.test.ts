import { bitbucket } from '@git-migrator/provider-fakes';
import { describe, expect, it } from 'vitest';
import { basicCredentials, TOKEN_SHAPES } from './client.ts';
import { facet, makeConnection, makeWorld, target } from './harness.test.ts';
import {
  bucketSpec,
  createClassifier,
  createInterpreter,
  DEFAULT_LIMITS,
  resourceGroups,
  safeAccountKey,
} from './quota.ts';

const setup = { endpointId: 'bb', accountKey: 'acct' };
const classify = createClassifier(setup);
const groupsOf = (method: string, path: string) =>
  classify({ method, path }).buckets.map((b) => b.key.split(':')[2]);

describe('request classifier (JOB-043)', () => {
  it('[JOB-043] repository paths and unlisted /2.0 and /1.0 paths are repository-data', () => {
    for (const path of [
      '/2.0/repositories/acme/r',
      '/2.0/repositories/acme/r/branch-restrictions',
      '/2.0/user',
      '/2.0/workspaces/acme/members',
      '/2.0/workspaces/acme/projects/PLAT/permissions-config/users',
      '/1.0/groups/acme',
      '/2.0/something/new',
    ]) {
      expect(groupsOf('GET', path), path).toEqual(['repository-data']);
    }
  });

  it('[JOB-043] hooks, repository or workspace, are only in webhooks', () => {
    expect(groupsOf('GET', '/2.0/repositories/acme/r/hooks')).toEqual(['webhooks']);
    expect(groupsOf('POST', '/2.0/repositories/acme/r/hooks')).toEqual(['webhooks']);
    expect(groupsOf('DELETE', '/2.0/workspaces/acme/hooks/%7Bu%7D')).toEqual(['webhooks']);
  });

  it('[JOB-043] file downloads count in raw-files and repository-data, listings in repository-data only', () => {
    expect(groupsOf('GET', '/2.0/repositories/acme/r/src/main/bitbucket-pipelines.yml')).toEqual([
      'raw-files',
      'repository-data',
    ]);
    expect(groupsOf('GET', '/2.0/repositories/acme/r/downloads/a.zip')).toEqual([
      'raw-files',
      'repository-data',
    ]);
    expect(groupsOf('GET', '/2.0/repositories/acme/r/src/main/')).toEqual(['repository-data']);
    expect(groupsOf('GET', '/2.0/repositories/acme/r/src/main')).toEqual(['repository-data']);
    expect(groupsOf('GET', '/2.0/repositories/acme/r/downloads')).toEqual(['repository-data']);
  });

  it('[JOB-043] properties are app-properties', () => {
    expect(groupsOf('GET', '/2.0/repositories/acme/r/properties/app/k')).toEqual([
      'app-properties',
    ]);
    expect(groupsOf('GET', '/2.0/users/u/properties/app/k')).toEqual(['app-properties']);
  });

  it('[JOB-043] only the documented property routes are app-properties', () => {
    expect(groupsOf('GET', '/2.0/repositories/properties/r')).toEqual(['repository-data']);
    expect(groupsOf('GET', '/2.0/repositories/acme/properties')).toEqual(['repository-data']);
    expect(groupsOf('GET', '/2.0/workspaces/properties/members')).toEqual(['repository-data']);
    expect(
      groupsOf('GET', '/2.0/repositories/acme/r/src/properties/bitbucket-pipelines.yml'),
    ).toEqual(['raw-files', 'repository-data']);
    for (const path of [
      '/2.0/repositories/acme/r/properties/app/k',
      '/2.0/repositories/acme/r/commit/abc/properties/app/k',
      '/2.0/repositories/acme/r/pullrequests/4/properties/app/k',
      '/2.0/users/%7Bu%7D/properties/app/k',
    ]) {
      expect(groupsOf('PUT', path), path).toEqual(['app-properties']);
    }
  });

  it('[JOB-043] limits, window and bucket keys follow the documented defaults', () => {
    const b = classify({ method: 'GET', path: '/2.0/repositories/acme/r/src/main/f' }).buckets;
    expect(b).toEqual([
      { key: 'bb:acct:raw-files', limit: 5000, windowSeconds: 3600 },
      { key: 'bb:acct:repository-data', limit: 1000, windowSeconds: 3600 },
    ]);
    expect(DEFAULT_LIMITS).toEqual({
      'repository-data': 1000,
      webhooks: 1000,
      'raw-files': 5000,
      'app-properties': 2000,
      git: 60000,
    });
  });

  it('[JOB-043] limits come from endpoints[].quota.overrides', () => {
    const c = createClassifier({ ...setup, overrides: { 'repository-data': 10 } });
    expect(c({ method: 'GET', path: '/2.0/user' }).buckets[0]?.limit).toBe(10);
    expect(bucketSpec({ ...setup, overrides: { git: 5 } }, 'git', 3)).toMatchObject({
      limit: 5,
      units: 3,
    });
  });

  it('[JOB-044] a 429 without Retry-After blocks for at least 60 seconds', () => {
    expect(classify({ method: 'GET', path: '/2.0/user' }).minBlockSeconds).toBe(60);
  });

  it('[JOB-040] account ids with a colon still make a valid bucket key', () => {
    expect(safeAccountKey('557058:ab-cd')).toBe('557058_ab-cd');
    expect(safeAccountKey('')).toBe('_');
    const c = createClassifier({ endpointId: 'bb', accountKey: '557058:ab cd' });
    expect(c({ method: 'GET', path: '/2.0/user' }).buckets[0]?.key).toBe(
      'bb:557058_ab_cd:repository-data',
    );
  });

  it('[JOB-043] classification agrees with the fake Bitbucket limiter (T-041)', async () => {
    const cases: [string, string][] = [
      ['GET', '/2.0/repositories/acme/r'],
      ['GET', '/2.0/repositories/acme/r/hooks'],
      ['GET', '/2.0/workspaces/acme/hooks'],
      ['GET', '/2.0/repositories/acme/r/src/main/a.txt'],
      ['GET', '/2.0/repositories/acme/r/downloads/a.zip'],
      ['GET', '/2.0/repositories/acme/r/properties/a/b'],
      ['GET', '/1.0/groups/acme'],
    ];
    const fakeClassify = bitbucket.classify;
    for (const [m, p] of cases) {
      expect(resourceGroups(m, p).sort(), p).toEqual([...fakeClassify(m, p, () => false)].sort());
    }
  });
});

describe('interpret (JOB-043)', () => {
  const interpret = createInterpreter(setup);
  const res = (
    headers: Record<string, string>,
    extra: Partial<Parameters<typeof interpret>[0]> = {},
  ) => ({
    status: 200,
    headers: new Headers(headers),
    body: undefined,
    method: 'GET',
    path: '/2.0/repositories/acme/r',
    grantedAt: new Date('2026-02-03T04:05:06Z'),
    ...extra,
  });

  it('[JOB-043] no rate-limit headers means no feedback', () => {
    expect(interpret(res({}))).toBeUndefined();
  });

  it('[JOB-043] X-RateLimit-Limit updates the limit and passes observedSince from the grant', () => {
    expect(interpret(res({ 'x-ratelimit-limit': '2500' }))?.feedback).toEqual([
      {
        bucketKey: 'bb:acct:repository-data',
        limit: 2500,
        windowSeconds: 3600,
        observedSince: new Date('2026-02-03T04:05:06Z'),
      },
    ]);
  });

  it('[JOB-043] X-RateLimit-NearLimit: true clamps the background pool; false does nothing', () => {
    const near = interpret(res({ 'x-ratelimit-nearlimit': 'True' }))?.feedback?.[0];
    expect(near).toMatchObject({ nearLimit: true, limit: 1000 });
    expect(interpret(res({ 'x-ratelimit-nearlimit': 'false' }))).toBeUndefined();
  });

  it('[JOB-043] hostile header values are ignored', () => {
    expect(interpret(res({ 'x-ratelimit-limit': '-1' }))).toBeUndefined();
    expect(interpret(res({ 'x-ratelimit-limit': '1e9' }))).toBeUndefined();
    expect(interpret(res({ 'x-ratelimit-limit': 'x'.repeat(5000) }))).toBeUndefined();
  });

  it('[JOB-043] the report applies to the most specific bucket of a two-bucket request', () => {
    const f = interpret(
      res({ 'x-ratelimit-limit': '9' }, { path: '/2.0/repositories/acme/r/src/main/f' }),
    )?.feedback?.[0];
    expect(f?.bucketKey).toBe('bb:acct:raw-files');
  });

  it('[ADP-060] failing responses surface a short provider message', () => {
    const out = interpret(
      res({}, { status: 403, body: { type: 'error', error: { message: 'Missing scope' } } }),
    );
    expect(out?.message).toBe('Missing scope');
  });
});

describe('credentials and token shapes (ADP-061)', () => {
  it('[ADP-061] Basic header is computed once and the token and pair are declared secrets', () => {
    const c = basicCredentials({ accountId: 'a', email: 'me@x.io', apiToken: 'tok-123456' });
    expect(c.headers.authorization).toBe(
      `Basic ${Buffer.from('me@x.io:tok-123456').toString('base64')}`,
    );
    expect(c.secrets).toEqual(['tok-123456', 'me@x.io:tok-123456']);
  });

  it('[ADP-061] Atlassian token prefixes are scrubbed shapes and stay linear', () => {
    const [shape] = TOKEN_SHAPES;
    const token = `ATATT3xFfGF0${'a1_-='.repeat(10)}`;
    expect(`key ${token} end`.replace(shape as RegExp, 'X')).toBe('key X end');
    expect('ATBBabcdefghijklmnop'.replace(shape as RegExp, 'X')).toBe('X');
    const hostile = `ATATT${'a'.repeat(1_000_000)}`;
    const started = performance.now();
    hostile.replace(shape as RegExp, 'X');
    'ATAT'.repeat(250_000).replace(shape as RegExp, 'X');
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('quota through the client', () => {
  it('[JOB-043] every request acquires its buckets in the connection pool; accounts share a key', async () => {
    const world = makeWorld();
    const { conn, rec } = await makeConnection(world, { pool: 'interactive' });
    await facet(conn, 'repository-settings').read(
      {
        http: conn.http,
        git: { lsRemote: async () => ({ refs: [] }) },
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        pool: 'interactive',
        signal: new AbortController().signal,
      },
      target(),
    );
    expect(rec.acquired[0]).toEqual({
      keys: ['bb-main:acct-operator:repository-data'],
      pool: 'interactive',
    });
  });

  it('[JOB-044] a 429 from the fake is recorded and raised as rate_limited, never retried', async () => {
    const world = makeWorld({ limits: { limits: { 'repository-data': 1 }, windowMs: 60_000 } });
    const { conn, rec } = await makeConnection(world);
    await conn.inventory.getRepository(target().repository);
    const error = await conn.inventory.getRepository(target().repository).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'rate_limited', retryable: true });
    expect(rec.rateLimited).toEqual([{ bucketKey: 'bb-main:acct-operator:repository-data' }]);
    expect(rec.acquired).toHaveLength(2);
  });

  it('[TST-010] the fake serves no rate-limit headers, so no feedback is recorded', async () => {
    const { conn, rec } = await makeConnection(makeWorld());
    await conn.inventory.listIdentities();
    expect(rec.feedback).toEqual([]);
  });
});
