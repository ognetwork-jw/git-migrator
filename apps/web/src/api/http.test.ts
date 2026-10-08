import { describe, expect, it, vi } from 'vitest';
import { ApiError, apiRequest } from './http.ts';

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('[API-011] apiRequest', () => {
  it('[API-011] returns the parsed JSON and sends JSON bodies with a media type', async () => {
    const fetchImpl = vi.fn(async () => reply(200, { ok: true }));
    const result = await apiRequest<{ ok: boolean }>('/api/v1/x', {
      method: 'POST',
      json: { a: 1 },
      fetchImpl,
    });
    expect(result).toEqual({ ok: true });
    const [path, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/api/v1/x');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"a":1}');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('[API-011] sends text bodies as given', async () => {
    const fetchImpl = vi.fn(async () => reply(200, {}));
    await apiRequest('/api/v1/import', {
      method: 'POST',
      text: { body: 'a,b', type: 'text/csv' },
      fetchImpl,
    });
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.body).toBe('a,b');
    expect((init.headers as Record<string, string>)['content-type']).toBe('text/csv');
  });

  it('[API-011] a problem response becomes an ApiError with its code and item errors', async () => {
    const fetchImpl = vi.fn(async () =>
      reply(422, {
        code: 'validation_failed',
        errors: [{ path: 'line 2', message: 'source_not_found' }, { bad: true }],
      }),
    );
    const error = await apiRequest('/api/v1/x', { fetchImpl }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 422,
      code: 'validation_failed',
      errors: [{ path: 'line 2', message: 'source_not_found' }],
    });
  });

  it('[API-011] a body that is not a problem document is an internal error, and a network failure is not_ready', async () => {
    const html = vi.fn(async () => new Response('<html>', { status: 502 }));
    await expect(apiRequest('/api/v1/x', { fetchImpl: html })).rejects.toMatchObject({
      code: 'internal_error',
      status: 502,
    });
    const down = vi.fn(async () => {
      throw new TypeError('network');
    });
    await expect(apiRequest('/api/v1/x', { fetchImpl: down })).rejects.toMatchObject({
      code: 'not_ready',
      status: 0,
    });
  });
});
