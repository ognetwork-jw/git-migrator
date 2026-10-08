import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActorResult } from '../api/actor.ts';

const redirect = vi.fn((to: string) => {
  throw new Error(`NEXT_REDIRECT ${to}`);
});
let incoming = new Headers();
const request = vi.fn();

vi.mock('next/navigation', () => ({ redirect: (to: string) => redirect(to) }));
vi.mock('next/headers', () => ({ headers: async () => incoming }));
vi.mock('./api.ts', () => ({ getApiRuntime: () => ({ app: { request } }) }));

const { accessFor, authorizePage } = await import('./authorize.ts');

const ok = (role: 'viewer' | 'operator' | 'admin'): ActorResult => ({
  kind: 'ok',
  actor: { id: 'a', displayName: 'A', email: null, role, disabled: false },
});

const meResponse = (role: string, status = 200) =>
  new Response(
    JSON.stringify({
      id: 'a',
      kind: 'human',
      displayName: 'A',
      email: null,
      role,
      disabled: false,
    }),
    { status, headers: { 'content-type': 'application/json' } },
  );

beforeEach(() => {
  redirect.mockClear();
  request.mockReset();
  incoming = new Headers({ cookie: 'session=abc', 'x-other': 'no' });
});

describe('[AUTH-021] server-side page access', () => {
  it('[AUTH-021] an operator may open the mapping pages, a viewer is sent to /denied', () => {
    expect(accessFor(ok('operator'), '/people/identities')).toEqual({ kind: 'allow' });
    expect(accessFor(ok('admin'), '/people/teams')).toEqual({ kind: 'allow' });
    expect(accessFor(ok('viewer'), '/people/identities')).toEqual({
      kind: 'redirect',
      to: '/denied?required=operator',
    });
  });

  it('[AUTH-021] a visitor who is not signed in is sent to sign-in and comes back afterwards', () => {
    expect(accessFor({ kind: 'unauthenticated' }, '/people/teams')).toEqual({
      kind: 'redirect',
      to: '/signin?next=%2Fpeople%2Fteams',
    });
  });

  it('[AUTH-021] an API problem is not a reason to render the page', () => {
    expect(accessFor({ kind: 'problem', code: 'not_ready' }, '/people/teams')).toEqual({
      kind: 'problem',
      code: 'not_ready',
    });
  });

  it('[AUTH-021] authorizePage asks the API with the caller cookie and lets an operator through', async () => {
    request.mockResolvedValue(meResponse('operator'));
    await expect(authorizePage('/people/identities')).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe('/api/v1/me');
    expect(init.headers.cookie).toBe('session=abc');
    expect(init.headers['x-other']).toBeUndefined();
    expect(redirect).not.toHaveBeenCalled();
  });

  it('[AUTH-021] authorizePage redirects a viewer to /denied before the page renders', async () => {
    request.mockResolvedValue(meResponse('viewer'));
    await expect(authorizePage('/people/identities')).rejects.toThrow(
      'NEXT_REDIRECT /denied?required=operator',
    );
  });

  it('[AUTH-021] authorizePage redirects an anonymous visitor to sign-in', async () => {
    request.mockResolvedValue(new Response('{}', { status: 401 }));
    await expect(authorizePage('/people/teams')).rejects.toThrow(
      'NEXT_REDIRECT /signin?next=%2Fpeople%2Fteams',
    );
  });

  it('[AUTH-021] authorizePage fails closed when the API cannot answer', async () => {
    request.mockResolvedValue(new Response('{}', { status: 500 }));
    await expect(authorizePage('/people/teams')).rejects.toThrow('authorization unavailable');
    request.mockRejectedValue(new Error('down'));
    await expect(authorizePage('/people/teams')).rejects.toThrow('authorization unavailable');
  });

  it('[AUTH-021] a disabled Actor is treated like anyone without the capability', () => {
    expect(
      accessFor(
        {
          kind: 'ok',
          actor: { id: 'a', displayName: 'A', email: null, role: 'admin', disabled: true },
        },
        '/people/identities',
      ).kind,
    ).toBe('redirect');
  });
});
