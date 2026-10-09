import { describe, expect, it } from 'vitest';
import { createAppPort, isLoopbackHost } from './app.ts';
import { createBitbucketApi } from './ports.ts';

const appOptions = {
  baseUrl: 'http://127.0.0.1:3000',
  email: 'o@test.local',
  password: 'p',
  slug: 's',
  endpointId: 'bb',
  projectKey: 'E2E',
};

const credentials = {
  baseUrl: 'https://api.bitbucket.example/',
  email: 'a@example.com',
  apiToken: 'super-secret-token',
};

describe('live e2e clients (TST-030)', () => {
  it('[TST-030] the Bitbucket client sends basic auth and parses JSON', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createBitbucketApi(credentials, fetchImpl);
    expect(await api.request('PUT', '/2.0/x', { description: 'd' })).toEqual({
      status: 200,
      json: { ok: true },
    });
    expect(seen[0]?.url).toBe('https://api.bitbucket.example/2.0/x');
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(
      `Basic ${Buffer.from('a@example.com:super-secret-token').toString('base64')}`,
    );
    expect(seen[0]?.init.body).toBe('{"description":"d"}');
  });

  it('[TST-030] an empty or non-JSON body gives no JSON, and a network error never carries the token', async () => {
    const empty = createBitbucketApi(
      credentials,
      (async () => new Response(null, { status: 204 })) as unknown as typeof fetch,
    );
    expect(await empty.request('DELETE', '/2.0/x')).toEqual({ status: 204, json: undefined });
    const html = createBitbucketApi(
      credentials,
      (async () => new Response('<html>', { status: 502 })) as unknown as typeof fetch,
    );
    expect((await html.request('GET', '/2.0/x')).json).toBeUndefined();
    const broken = createBitbucketApi(credentials, (async () => {
      throw new Error('socket hang up');
    }) as unknown as typeof fetch);
    const error = await broken.request('GET', '/2.0/x').catch((e: Error) => e);
    expect((error as Error).message).toContain('socket hang up');
    expect((error as Error).message).not.toContain('super-secret-token');
  });
});

describe('the app port of the reset (TST-032)', () => {
  it('[TST-032] signs in, finds the Migration and runs a Run to its end', async () => {
    const calls: string[] = [];
    let polls = 0;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      calls.push(`${init.method} ${path}`);
      if (path === '/api/auth/sign-in/email') {
        return new Response('{}', {
          status: 200,
          headers: { 'set-cookie': 'session_token=abc; Path=/' },
        });
      }
      if (path === '/api/model/migration/findFirst') {
        return Response.json({
          data: {
            id: 'm1',
            sourceReadOnlyApplied: true,
            targetRepositoryId: 't1',
            status: 'verified',
          },
        });
      }
      if (path === '/api/v1/migrations/m1/runs') {
        expect((init.headers as Record<string, string>).cookie).toBe('session_token=abc');
        expect(JSON.parse(String(init.body))).toEqual({ kind: 'rollback', confirm: 'o/r' });
        return Response.json({ runId: 'r1' }, { status: 202 });
      }
      polls += 1;
      return Response.json({ data: { status: polls < 2 ? 'running' : 'succeeded' } });
    }) as unknown as typeof fetch;
    const app = createAppPort(appOptions, fetchImpl);
    expect(await app.find()).toEqual({ id: 'm1', sourceReadOnlyApplied: true, hasTarget: true });
    expect(await app.run('m1', 'rollback', 'o/r')).toBe('succeeded');
    expect(calls.filter((c) => c.includes('sign-in'))).toHaveLength(1);
  });

  it('[TST-032] reports no Migration, and a refused sign-in or start', async () => {
    const none = createAppPort(appOptions, (async (url: string) =>
      new URL(url).pathname.includes('sign-in')
        ? new Response('{}', { headers: { 'set-cookie': 'a=b' } })
        : Response.json({ data: null })) as unknown as typeof fetch);
    expect(await none.find()).toBeUndefined();
    const refused = createAppPort(
      appOptions,
      (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch,
    );
    await expect(refused.find()).rejects.toThrow(/refused the sign-in \(HTTP 401\)/);
  });

  it('[TST-032] the app port refuses a non-local app URL, and scopes the Migration lookup', async () => {
    expect(() => createAppPort({ ...appOptions, baseUrl: 'https://gm.example.com' })).toThrow(
      /must be a local address/,
    );
    const queries: string[] = [];
    const app = createAppPort(appOptions, (async (url: string) => {
      const u = new URL(url);
      if (u.pathname.includes('sign-in'))
        return new Response('{}', { headers: { 'set-cookie': 'a=b' } });
      queries.push(decodeURIComponent(u.searchParams.get('q') ?? ''));
      return Response.json({ data: null });
    }) as unknown as typeof fetch);
    await app.find();
    expect(JSON.parse(queries[0] as string).where.sourceRepository).toEqual({
      slug: 's',
      endpointId: 'bb',
      namespace: { key: 'E2E' },
    });
  });
});

describe('the loopback guard of the app port (TST-032)', () => {
  it.each([
    'http://127.0.0.1.evil.example',
    'http://127.0.0.1@evil.example',
    'http://0.0.0.0',
    'http://localhost.',
    'http://[::ffff:7f00:1]',
    'https://example.com',
  ])('[TST-032] refuses %s (the password must not leave the machine)', (baseUrl) => {
    expect(() => createAppPort({ ...appOptions, baseUrl })).toThrow(/must be a local address/);
  });

  it.each([
    'http://localhost:3000',
    'http://[::1]:3000',
    'http://127.0.0.1:3000',
    'http://127.1:3000',
  ])('[TST-032] accepts %s', (baseUrl) => {
    expect(() => createAppPort({ ...appOptions, baseUrl })).not.toThrow();
    expect(isLoopbackHost(new URL(baseUrl).hostname)).toBe(true);
  });
});
