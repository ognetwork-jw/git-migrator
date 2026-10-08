import { describe, expect, it } from 'vitest';
import { AdapterError, type AdapterErrorCode, isAdapterError } from './errors.ts';

describe('AdapterError', () => {
  it('[ADP-050] carries code, retryable, retryAfterMs, provider and a secret-free request', () => {
    const error = new AdapterError({
      code: 'rate_limited',
      provider: 'p',
      message: 'm',
      retryAfterMs: 5,
      request: { method: 'GET', url: 'https://h.test/x', status: 429 },
    });
    expect(error).toBeInstanceOf(Error);
    expect(isAdapterError(error)).toBe(true);
    expect(isAdapterError(new Error('x'))).toBe(false);
    expect(error).toMatchObject({
      code: 'rate_limited',
      retryable: true,
      retryAfterMs: 5,
      provider: 'p',
      request: { method: 'GET', url: 'https://h.test/x', status: 429 },
    });
  });

  it('[ADP-050] is retryable only for rate_limited and transient unless set', () => {
    const codes: AdapterErrorCode[] = [
      'rate_limited',
      'not_found',
      'forbidden',
      'unauthorized',
      'conflict',
      'invalid',
      'unsupported',
      'transient',
      'blocked_by_provider',
    ];
    const retryable = codes.filter(
      (code) => new AdapterError({ code, provider: 'p', message: 'm' }).retryable,
    );
    expect(retryable).toEqual(['rate_limited', 'transient']);
    expect(
      new AdapterError({ code: 'invalid', provider: 'p', message: 'm', retryable: true }).retryable,
    ).toBe(true);
  });

  it('[ADP-050] keeps retryAt and cause', () => {
    const at = new Date(1000);
    const cause = new Error('c');
    const error = new AdapterError({
      code: 'rate_limited',
      provider: 'p',
      message: 'm',
      retryAt: at,
      cause,
    });
    expect(error.retryAt).toBe(at);
    expect(error.cause).toBe(cause);
  });
});
