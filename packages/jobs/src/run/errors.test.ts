import { AdapterError } from '@git-migrator/adapter-sdk';
import { describe, expect, it } from 'vitest';
import {
  isRateLimited,
  isRetryable,
  RETRY_CAP_MS,
  rateLimitDelayMs,
  retryDelayMs,
  serializeStepError,
} from './errors.ts';

// Built at run time so that no secret-shaped literal sits in the repository (gitleaks).
const FAKE_TOKEN = ['abcd', '1234', 'efgh'].join('');
const NOW = new Date('2026-10-09T10:00:00.000Z');
const err = (code: ConstructorParameters<typeof AdapterError>[0]['code'], extra = {}) =>
  new AdapterError({ code, provider: 'type-a', message: 'x', ...extra });

describe('[LIF-042] retry backoff', () => {
  it('[LIF-042] is full-jitter exponential from 1 s, capped at 60 s', () => {
    const top = () => 0.999999;
    expect(retryDelayMs(1, top)).toBeLessThan(1_000);
    expect(retryDelayMs(2, top)).toBeLessThan(2_000);
    expect(retryDelayMs(3, top)).toBeLessThan(4_000);
    expect(retryDelayMs(30, top)).toBeLessThan(RETRY_CAP_MS);
    expect(retryDelayMs(30, top)).toBeGreaterThan(RETRY_CAP_MS - 1_000);
    expect(retryDelayMs(5, () => 0)).toBe(0);
  });

  it('[LIF-042] retries transient errors only; a rate limit delays the Run instead', () => {
    expect(isRetryable(err('transient'))).toBe(true);
    expect(isRetryable(err('rate_limited'))).toBe(false);
    expect(isRetryable(err('conflict'))).toBe(false);
    expect(isRetryable(new Error('boom'))).toBe(false);
    expect(isRateLimited(err('rate_limited'))).toBe(true);
    expect(isRateLimited(err('transient'))).toBe(false);
  });

  it('[LIF-042] waits for the quota service retryAt, else Retry-After, else a minute, never less than a second', () => {
    expect(
      rateLimitDelayMs(err('rate_limited', { retryAt: new Date(NOW.getTime() + 90_000) }), NOW),
    ).toBe(90_000);
    expect(
      rateLimitDelayMs(err('rate_limited', { retryAt: new Date(NOW.getTime() - 5_000) }), NOW),
    ).toBe(1_000);
    expect(rateLimitDelayMs(err('rate_limited', { retryAfterMs: 12_000 }), NOW)).toBe(12_000);
    expect(rateLimitDelayMs(err('rate_limited'), NOW)).toBe(60_000);
    expect(rateLimitDelayMs(new Error('x'), NOW)).toBe(60_000);
  });
});

describe('[LIF-042] stored errors', () => {
  it('[LIF-042] keeps the code, provider and request of an adapter error without a stack', () => {
    const stored = serializeStepError(
      err('forbidden', {
        request: { method: 'PUT', url: `https://host.test/a?token=${FAKE_TOKEN}`, status: 403 },
      }),
    );
    expect(stored).toMatchObject({ code: 'forbidden', retryable: false, provider: 'type-a' });
    expect(JSON.stringify(stored)).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(stored)).not.toContain('at ');
  });

  it('[LIF-042] describes any other thrown value without leaking it', () => {
    expect(serializeStepError(new TypeError('bad'))).toMatchObject({
      code: 'step.error',
      name: 'TypeError',
    });
    expect(serializeStepError({ password: ['hunter', '2hunter2'].join('') })).toEqual({
      code: 'step.error',
      message: 'A non-error value was thrown',
      retryable: false,
    });
  });
});
