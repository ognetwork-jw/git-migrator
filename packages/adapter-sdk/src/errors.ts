/** Provider-neutral error type every adapter throws (ADP-050). */

export type AdapterErrorCode =
  | 'rate_limited'
  | 'not_found'
  | 'forbidden'
  | 'unauthorized'
  | 'conflict'
  | 'invalid'
  | 'unsupported'
  | 'transient'
  | 'blocked_by_provider';

/** The request that failed. Never holds secrets: the URL is already stripped (ADP-061). */
export interface AdapterErrorRequest {
  readonly method: string;
  readonly url: string;
  readonly status?: number;
}

export interface AdapterErrorInit {
  readonly code: AdapterErrorCode;
  readonly provider: string;
  readonly message: string;
  readonly retryable?: boolean;
  readonly retryAfterMs?: number;
  /** For `rate_limited`: the instant the quota service says to try again (JOB-044). */
  readonly retryAt?: Date;
  readonly request?: AdapterErrorRequest;
  readonly cause?: unknown;
}

/** Codes a caller may retry later without changing the request. */
const RETRYABLE: ReadonlySet<AdapterErrorCode> = new Set(['rate_limited', 'transient']);

export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  /** Set when a job should `moveToDelayed(retryAt)` (JOB-044). */
  readonly retryAt?: Date;
  readonly provider: string;
  readonly request?: AdapterErrorRequest;

  constructor(init: AdapterErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'AdapterError';
    this.code = init.code;
    this.provider = init.provider;
    this.retryable = init.retryable ?? RETRYABLE.has(init.code);
    if (init.retryAfterMs !== undefined) this.retryAfterMs = init.retryAfterMs;
    if (init.retryAt !== undefined) this.retryAt = init.retryAt;
    if (init.request !== undefined) this.request = init.request;
  }
}

export function isAdapterError(value: unknown): value is AdapterError {
  return value instanceof AdapterError;
}
