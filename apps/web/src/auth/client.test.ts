import { describe, expect, it, vi } from 'vitest';
import { signInWithPassword, signOut, startEntraSignIn } from './client.ts';

const reply = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const stub = (response: Response | Error) =>
  vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

describe('sign-in client', () => {
  it('[UI-036] starts the Entra flow with only the fields the server accepts', async () => {
    const fetchImpl = stub(reply(200, { url: 'https://login.example/authorize', redirect: true }));
    const outcome = await startEntraSignIn('/waves', fetchImpl);
    expect(outcome).toEqual({ kind: 'redirect', url: 'https://login.example/authorize' });
    const [path, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/auth/sign-in/social');
    expect(JSON.parse(init.body as string)).toEqual({
      provider: 'microsoft',
      callbackURL: '/waves',
      errorCallbackURL: '/auth/error',
    });
    expect(init.method).toBe('POST');
  });

  it('[UI-036] an unsafe next address is replaced by the dashboard', async () => {
    const fetchImpl = stub(reply(200, { url: 'https://login.example/authorize' }));
    await startEntraSignIn('//evil.example', fetchImpl);
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(init.body as string).callbackURL).toBe('/');
  });

  it('[UI-036] reports a refused or broken Entra start as an auth error code', async () => {
    expect(
      await startEntraSignIn('/', stub(reply(400, { code: 'sign_in_method_not_allowed' }))),
    ).toEqual({ kind: 'error', code: 'sign_in_method_not_allowed' });
    expect(await startEntraSignIn('/', stub(reply(500, {})))).toEqual({
      kind: 'error',
      code: 'sign_in_failed',
    });
    expect(await startEntraSignIn('/', stub(new TypeError('offline')))).toEqual({
      kind: 'error',
      code: 'sign_in_failed',
    });
    expect(await startEntraSignIn('/', stub(reply(200, {})))).toEqual({
      kind: 'error',
      code: 'sign_in_failed',
    });
    expect(await startEntraSignIn('/', stub(new Response('not json')))).toEqual({
      kind: 'error',
      code: 'sign_in_failed',
    });
  });

  it('[UI-036] test sign-in posts the credentials and returns to next', async () => {
    const fetchImpl = stub(reply(200));
    const outcome = await signInWithPassword(
      { email: 'viewer@test.local', password: 'secret-value' },
      '/repositories',
      fetchImpl,
    );
    expect(outcome).toEqual({ kind: 'redirect', url: '/repositories' });
    const [path, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/auth/sign-in/email');
    expect(JSON.parse(init.body as string)).toMatchObject({ email: 'viewer@test.local' });
  });

  it('[UI-036] test sign-in tells refused credentials from other failures', async () => {
    const creds = { email: 'a@b.test', password: 'x' };
    expect((await signInWithPassword(creds, '/', stub(reply(401)))).kind).toBe('invalid');
    expect((await signInWithPassword(creds, '/', stub(reply(422)))).kind).toBe('invalid');
    expect(await signInWithPassword(creds, '/', stub(reply(503, { code: 'not_ready' })))).toEqual({
      kind: 'error',
      code: 'not_ready',
    });
    expect(await signInWithPassword(creds, '/', stub(new TypeError('offline')))).toEqual({
      kind: 'error',
      code: 'sign_in_failed',
    });
  });

  it('[UI-010] sign-out posts to the server and reports whether it worked', async () => {
    const fetchImpl = stub(reply(200));
    expect(await signOut(fetchImpl)).toBe(true);
    expect((fetchImpl.mock.calls[0] as [string])[0]).toBe('/api/auth/sign-out');
    expect(await signOut(stub(reply(500)))).toBe(false);
    expect(await signOut(stub(new TypeError('offline')))).toBe(false);
  });
});
