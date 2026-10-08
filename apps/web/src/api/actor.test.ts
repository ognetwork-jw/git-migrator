import { describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json' with { type: 'json' };
import { fetchActor, problemCodeOf } from './actor.ts';

const json = (status: number, body: unknown, type = 'application/json') =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });

const ACTOR = {
  id: 'a1',
  kind: 'human',
  displayName: 'Ada',
  email: 'ada@example.test',
  role: 'operator',
  disabled: false,
};

describe('fetchActor', () => {
  it('[UI-010] reads name, email and role from GET /api/v1/me', async () => {
    const fetchImpl = vi.fn(async () => json(200, ACTOR));
    const result = await fetchActor(fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({
      kind: 'ok',
      actor: {
        id: 'a1',
        displayName: 'Ada',
        email: 'ada@example.test',
        role: 'operator',
        disabled: false,
      },
    });
    expect(fetchImpl).toHaveBeenCalledWith('/api/v1/me', expect.anything());
  });

  it('[UI-036] a 401 means the visitor must sign in', async () => {
    const result = await fetchActor((async () =>
      json(401, { code: 'unauthenticated' }, 'application/problem+json')) as typeof fetch);
    expect(result).toEqual({ kind: 'unauthenticated' });
  });

  it('[UI-010] other failures carry the problem code the UI has text for', async () => {
    const result = await fetchActor((async () =>
      json(503, { code: 'not_ready' }, 'application/problem+json')) as typeof fetch);
    expect(result).toEqual({ kind: 'problem', code: 'not_ready' });
    expect(messages.problem).toHaveProperty('not_ready');
  });

  it('[UI-010] a network failure or an unusable body is a problem, never a crash', async () => {
    const offline = await fetchActor((async () => {
      throw new TypeError('network');
    }) as typeof fetch);
    expect(offline).toEqual({ kind: 'problem', code: 'not_ready' });
    const wrongShape = await fetchActor((async () => json(200, { id: 1 })) as typeof fetch);
    expect(wrongShape).toEqual({ kind: 'problem', code: 'internal_error' });
    const notJson = await fetchActor(
      (async () => new Response('<html>', { status: 200 })) as typeof fetch,
    );
    expect(notJson).toEqual({ kind: 'problem', code: 'internal_error' });
    const unknownRole = await fetchActor((async () =>
      json(200, { ...ACTOR, role: 'root' })) as typeof fetch);
    expect(unknownRole).toEqual({ kind: 'problem', code: 'internal_error' });
    const nullBody = await fetchActor((async () => json(200, null)) as typeof fetch);
    expect(nullBody).toEqual({ kind: 'problem', code: 'internal_error' });
  });

  it('[UI-010] an Actor without an email still loads', async () => {
    const result = await fetchActor((async () =>
      json(200, { ...ACTOR, email: null, disabled: true })) as typeof fetch);
    expect(result).toMatchObject({ kind: 'ok', actor: { email: null, disabled: true } });
  });
});

describe('problemCodeOf', () => {
  it('[UI-010] reads the code of a problem body and rejects odd values', async () => {
    expect(await problemCodeOf(json(403, { code: 'forbidden' }))).toBe('forbidden');
    expect(await problemCodeOf(json(403, { code: 'a.b' }))).toBe('internal_error');
    expect(await problemCodeOf(json(403, {}))).toBe('internal_error');
    expect(await problemCodeOf(new Response('nope'))).toBe('internal_error');
  });
});
