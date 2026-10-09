/**
 * Step failure handling (LIF-042): how an error is stored, whether it is retried, and the backoff.
 * Decisions: docs/adr/0341-run-step-state-machine.md.
 */
import { isAdapterError, stripBody, stripText, stripUrl } from '@git-migrator/adapter-sdk';

const MAX_MESSAGE_CHARS = 500;

/** Retry backoff: full-jitter exponential from 1 s to 60 s (LIF-044, ADP-060). */
export const RETRY_BASE_MS = 1_000;
export const RETRY_CAP_MS = 60_000;

/** The delay before retry number `retry` (1 for the first retry): uniform in [0, min(cap, base * 2^(retry-1))). */
export function retryDelayMs(
  retry: number,
  random: () => number = Math.random,
  baseMs = RETRY_BASE_MS,
  capMs = RETRY_CAP_MS,
): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.max(0, retry - 1));
  return Math.floor(random() * ceiling);
}

/**
 * A Step failure with a code of the framework's own (`preflight.blocked`, `scratch.insufficient`),
 * stored as is. Never retried: a Step that wants a retry throws an `AdapterError`.
 */
export class StepFailure extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>> | undefined;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'StepFailure';
    this.code = code;
    this.details = details;
  }
}

export interface StoredStepError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly [key: string]: unknown;
}

/** What `RunStep.error` and `Run.error` hold. Never a stack and never a URL with credentials. */
export function serializeStepError(error: unknown): StoredStepError {
  if (isAdapterError(error)) {
    return {
      code: error.code,
      message: stripText(error.message).slice(0, MAX_MESSAGE_CHARS),
      retryable: error.retryable,
      provider: error.provider,
      ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
      ...(error.request
        ? {
            request: {
              method: error.request.method,
              url: stripUrl(error.request.url),
              ...(error.request.status !== undefined ? { status: error.request.status } : {}),
            },
          }
        : {}),
    };
  }
  if (error instanceof StepFailure) {
    return {
      code: error.code,
      message: stripText(error.message).slice(0, MAX_MESSAGE_CHARS),
      retryable: false,
      ...(error.details
        ? { details: JSON.parse(JSON.stringify(stripBody(error.details))) as unknown }
        : {}),
    };
  }
  if (error instanceof Error) {
    return {
      code: 'step.error',
      name: error.name,
      message: stripText(error.message).slice(0, MAX_MESSAGE_CHARS),
      retryable: false,
    };
  }
  return { code: 'step.error', message: 'A non-error value was thrown', retryable: false };
}

/** A `rate_limited` error pauses the Run instead of failing or retrying the Step (LIF-042). */
export function isRateLimited(error: unknown): boolean {
  return isAdapterError(error) && error.code === 'rate_limited';
}

/** Network, 5xx and unknown transient failures retry; everything else fails the Step. */
export function isRetryable(error: unknown): boolean {
  return isAdapterError(error) && error.retryable && error.code !== 'rate_limited';
}

/** How long a rate-limited Run waits: the quota service's `retryAt`, else `Retry-After`, else 60 s. */
export function rateLimitDelayMs(error: unknown, now: Date): number {
  const MIN = 1_000;
  const FALLBACK = 60_000;
  if (!isAdapterError(error)) return FALLBACK;
  if (error.retryAt) return Math.max(MIN, error.retryAt.getTime() - now.getTime());
  if (error.retryAfterMs !== undefined) return Math.max(MIN, error.retryAfterMs);
  return FALLBACK;
}

/** A transaction that PostgreSQL aborted for a lock cycle or a serialization failure (40P01, 40001). */
export function isSerializationConflict(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== 'object' || error === null) return false;
  const e = error as { code?: unknown; message?: unknown; cause?: unknown };
  if (e.code === '40P01' || e.code === '40001') return true;
  if (
    typeof e.message === 'string' &&
    /deadlock detected|could not serialize access/i.test(e.message)
  ) {
    return true;
  }
  return isSerializationConflict(e.cause, depth + 1);
}
