/**
 * ProviderHttpClient (ADP-060): the only way an adapter talks HTTP to a Provider. Quota before
 * every request, retries for transient failures, raw capture with secrets stripped (ADP-061),
 * telemetry. Provider-specific header parsing stays in the adapter and arrives through the neutral
 * `interpret` hook (ADR-0190).
 */
import {
  type AcquireResult,
  type BucketSpec,
  parseBucketKey,
  type QuotaFeedback,
  type QuotaPool,
} from '@git-migrator/quota';
import { AdapterError, type AdapterErrorCode } from './errors.ts';
import { assertHostAllowed, isTestEnvironment } from './host-allowlist.ts';
import { type Logger, noopLogger } from './logger.ts';
import {
  MIN_SECRET_LENGTH,
  type ScrubOptions,
  stripBody,
  stripForm,
  stripHeaders,
  stripText,
  stripUrl,
} from './redact.ts';

/** The part of `QuotaService` the client uses. `QuotaService` satisfies it. */
export interface QuotaGate {
  acquire(buckets: readonly BucketSpec[], pool: QuotaPool): Promise<AcquireResult>;
  recordFeedback(feedback: QuotaFeedback): Promise<void>;
  recordRateLimited(input: {
    bucketKey: string;
    limit: number;
    windowSeconds: number;
    retryAfterSeconds?: number;
    minBlockSeconds?: number;
  }): Promise<Date>;
  recordSecondaryLimit(input: {
    bucketKey: string;
    limit: number;
    windowSeconds: number;
    retryAfterSeconds?: number;
  }): Promise<Date>;
  adjust(bucketKey: string, pool: QuotaPool, delta: number): Promise<void>;
}

/** The part of `QuotaLeases` the client uses (JOB-045 in-flight cap). */
export interface LeaseGate {
  acquire(bucketKey: string, holder: string, cap: number): Promise<bigint | undefined>;
  release(id: bigint): Promise<void>;
}

/** One `RawResponse` row, before persistence (ADP-061). Everything in it is already stripped. */
export interface RawCaptureInput {
  readonly endpointId: string;
  readonly method: string;
  readonly url: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly fetchedAt: Date;
}

/** Persists raw responses and returns their ids (`FacetRead.rawResponseIds`). */
export interface RawCaptureSink {
  save(input: RawCaptureInput): Promise<string>;
}

export interface ProviderSpan {
  setAttributes(attributes: Record<string, string | number | boolean>): void;
  /** `error` is a stripped message, never the raw error. */
  end(error?: string): void;
}

/**
 * Telemetry sink (ADP-060). The wiring maps it onto the OpenTelemetry tracer and the
 * `gm_provider_requests_total` / `gm_provider_request_duration_seconds` recorders from
 * `packages/observability`, which `adapter-sdk` may not import (ARC-012).
 */
export interface ProviderTelemetry {
  startSpan?(name: string, attributes: Record<string, string | number | boolean>): ProviderSpan;
  recordRequest(
    labels: { provider: string; endpoint: string; bucket: string; status: string },
    durationSeconds: number,
  ): void;
}

/** What a `Classifier` decides about one request. */
export interface RequestClass {
  /** Low-cardinality endpoint label for metrics, for example `repos.get`. */
  readonly endpoint: string;
  /** Buckets charged (JOB-040); two entries acquire in one transaction. */
  readonly buckets: readonly BucketSpec[];
  /** Metrics `bucket` label. Defaults to the resource group of the first bucket. */
  readonly bucketLabel?: string;
  /** Minimum block for a 429 without Retry-After (JOB-044; an adapter with no rate-limit headers sets it). */
  readonly minBlockSeconds?: number;
  /** In-flight cap across pods, enforced with a lease before acquiring (JOB-045). */
  readonly concurrency?: { readonly bucketKey: string; readonly cap: number };
}

/** Per-adapter route to bucket classifier (ADP-060). Pure. */
export type Classifier = (request: { method: string; path: string }) => RequestClass;

/** What an adapter's `interpret` hook returns for a response. All parts are optional. */
export interface Interpretation {
  /** Provider-reported usage per bucket. The client adds `observedSince` from the grant. */
  readonly feedback?: readonly QuotaFeedback[];
  /** The response says the request was limited. Without it, only HTTP 429 counts. */
  readonly signal?: {
    readonly kind: 'rate-limited' | 'secondary-limit';
    readonly retryAfterSeconds?: number;
  };
  /** Reconciles an estimate with the real cost, for example a query cost (JOB-045). */
  readonly adjust?: readonly { readonly bucketKey: string; readonly delta: number }[];
  /** Overrides the error code of a failing response. */
  readonly code?: AdapterErrorCode;
  /** A provider message safe to show; it is stripped again before use. */
  readonly message?: string;
}

export interface ResponseInfo {
  readonly status: number;
  readonly headers: Headers;
  /** Parsed JSON, text, or undefined for an empty body. */
  readonly body: unknown;
  readonly method: string;
  readonly path: string;
  /** The `at` stamp that `acquire` returned for this request. */
  readonly grantedAt: Date;
}

export type Interpreter = (response: ResponseInfo) => Interpretation | undefined;

export interface RequestCredentials {
  /** Headers to send, for example `authorization`. Never logged or captured. */
  readonly headers: Readonly<Record<string, string>>;
  /** Secret values that must never appear in captures, logs or errors. */
  readonly secrets?: readonly string[];
}

export interface RetryPolicy {
  /** Default 1000. */
  readonly baseMs?: number;
  /** Default 60000. */
  readonly capMs?: number;
  /** Total attempts, default 5. */
  readonly attempts?: number;
}

/** What an adapter receives from the host: the shared pieces of every client (AdapterContext). */
export interface ProviderHttpEnvironment {
  readonly quota: QuotaGate;
  readonly leases?: LeaseGate;
  readonly logger: Logger;
  readonly capture?: RawCaptureSink;
  readonly telemetry?: ProviderTelemetry;
  /** Test seam: replaces `fetch`. */
  readonly fetch?: typeof fetch;
  /** Default `process.env.GM_ENVIRONMENT`. `test` turns the host allowlist on (TST-006). */
  readonly environment?: string;
  /** Extra hosts allowed in the test environment (the fakes' addresses). */
  readonly testAllowedHosts?: readonly string[];
}

export interface ProviderHttpClientOptions extends ProviderHttpEnvironment {
  /** Provider type, for errors and metrics. */
  readonly provider: string;
  readonly endpointId: string;
  readonly baseUrl: string;
  readonly classify: Classifier;
  readonly authorize: () => Promise<RequestCredentials>;
  readonly interpret?: Interpreter;
  /** Provider-specific token shapes (for example key prefixes) to scrub from captures, errors and logs. */
  readonly tokenShapes?: readonly RegExp[];
  /** Largest response body read, in bytes. Default 32 MiB; a larger body fails as `invalid`. */
  readonly maxResponseBytes?: number;
  readonly pool?: QuotaPool;
  readonly retry?: RetryPolicy;
  /** Test seams. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly random?: () => number;
  readonly now?: () => Date;
}

export interface ProviderRequest {
  readonly method?: string;
  /** Path relative to `baseUrl`, or an absolute URL on the same origin (pagination links). */
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly json?: unknown;
  readonly body?: string | Uint8Array;
  readonly pool?: QuotaPool;
  readonly signal?: AbortSignal;
  /** Record a `RawResponse` row and return its id. */
  readonly capture?: boolean;
  /** Retry transient failures. Default true; set false for a non-idempotent write. */
  readonly retry?: boolean;
}

export interface ProviderResponse<T = unknown> {
  readonly status: number;
  readonly headers: Headers;
  readonly body: T;
  /** The URL that was requested, stripped of secrets. */
  readonly url: string;
  readonly grantedAt: Date;
  readonly rawResponseId?: string;
}

const MAX_REDIRECTS = 5;
const MAX_CAPTURE_TEXT = 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60;
const MAX_ERROR_MESSAGE = 500;
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([408, 500, 502, 503, 504]);

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

const IMF_FIXDATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;
const RFC850_DATE = /^[A-Z][a-z]+, \d{2}-[A-Z][a-z]{2}-\d{2} \d{2}:\d{2}:\d{2} GMT$/;
const ASCTIME_DATE = /^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/;

/**
 * `Retry-After` (RFC 9110): non-negative delta-seconds or an HTTP date (IMF-fixdate, RFC 850 or
 * asctime). Returns seconds, clamped to 24 h; a date in the past gives 1 s; anything else is
 * undefined.
 */
export function parseRetryAfter(value: string | null, now: Date = new Date()): number | undefined {
  if (value === null) return undefined;
  const text = value.trim();
  if (/^\d{1,10}$/.test(text)) return Math.min(Number(text), MAX_RETRY_AFTER_SECONDS);
  let at: number;
  if (IMF_FIXDATE.test(text) || RFC850_DATE.test(text)) at = Date.parse(text);
  else if (ASCTIME_DATE.test(text)) at = Date.parse(`${text} GMT`);
  else return undefined;
  if (Number.isNaN(at)) return undefined;
  return Math.min(Math.max(1, Math.ceil((at - now.getTime()) / 1000)), MAX_RETRY_AFTER_SECONDS);
}

function statusCode(status: number): AdapterErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404 || status === 410) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 451) return 'blocked_by_provider';
  if (status === 429) return 'rate_limited';
  if (TRANSIENT_STATUSES.has(status) || status >= 500) return 'transient';
  return 'invalid';
}

function parseBody(text: string, contentType: string | null): unknown {
  if (text === '') return undefined;
  if (contentType !== null && /json/i.test(contentType)) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

const SYSTEM_ERROR_CODE = /^E[A-Z0-9_]+$/;

/** A real network failure: a system error code (ECONNRESET), or undici's `fetch failed`. */
function isNetworkError(error: unknown): boolean {
  const codeOf = (value: unknown): unknown => (value as { code?: unknown } | null)?.code;
  const isCode = (value: unknown) =>
    typeof codeOf(value) === 'string' && SYSTEM_ERROR_CODE.test(codeOf(value) as string);
  if (isCode(error)) return true;
  const cause = (error as { cause?: unknown } | null)?.cause;
  if (isCode(cause)) return true;
  return error instanceof TypeError && error.message === 'fetch failed';
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return error instanceof Error && error.name === 'AbortError';
}

export class ProviderHttpClient {
  readonly #o: ProviderHttpClientOptions;
  readonly #base: URL;
  readonly #fetch: typeof fetch;
  readonly #env: string | undefined;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #random: () => number;
  readonly #now: () => Date;
  readonly #logger: Logger;

  constructor(options: ProviderHttpClientOptions) {
    this.#o = options;
    this.#base = new URL(options.baseUrl);
    if (this.#base.username !== '' || this.#base.password !== '') {
      throw new AdapterError({
        code: 'invalid',
        provider: options.provider,
        message: 'The endpoint base URL must not carry credentials',
      });
    }
    this.#fetch = options.fetch ?? fetch;
    this.#env = options.environment ?? process.env.GM_ENVIRONMENT;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#random = options.random ?? Math.random;
    this.#now = options.now ?? (() => new Date());
    this.#logger = options.logger ?? noopLogger;
    // Fail at construction when the base URL itself is off the allowlist.
    this.#checkHost(this.#base);
  }

  get provider(): string {
    return this.#o.provider;
  }

  get endpointId(): string {
    return this.#o.endpointId;
  }

  #checkHost(url: URL): void {
    if (!isTestEnvironment(this.#env)) return;
    assertHostAllowed(url, this.#o.provider, this.#o.testAllowedHosts);
  }

  /** The URL must keep to the base origin and path, and carry no userinfo. */
  #assertInBase(url: URL): void {
    const basePath = this.#base.pathname.replace(/\/$/, '');
    const inPath = url.pathname === basePath || url.pathname.startsWith(`${basePath}/`);
    if (url.origin !== this.#base.origin || !inPath || url.username !== '' || url.password !== '') {
      throw new AdapterError({
        code: 'invalid',
        provider: this.#o.provider,
        message: 'Refusing a URL outside the endpoint base URL',
      });
    }
  }

  #resolve(request: ProviderRequest): URL {
    const absolute = /^[a-z][a-z0-9+.-]*:/i.test(request.path) || request.path.startsWith('//');
    const basePath = this.#base.pathname.replace(/\/$/, '');
    const url = absolute
      ? new URL(request.path, this.#base)
      : new URL(`${this.#base.origin}${basePath}/${request.path.replace(/^\/+/, '')}`);
    if (absolute && url.origin !== this.#base.origin) {
      throw new AdapterError({
        code: 'invalid',
        provider: this.#o.provider,
        message: 'Refusing a request to a different origin than the endpoint base URL',
      });
    }
    this.#assertInBase(url);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url;
  }

  /** The relative path used for classification: path and no query, under the base. */
  #classifyPath(url: URL): string {
    const basePath = this.#base.pathname.replace(/\/$/, '');
    return url.pathname.startsWith(`${basePath}/`)
      ? url.pathname.slice(basePath.length)
      : url.pathname;
  }

  async request<T = unknown>(request: ProviderRequest): Promise<ProviderResponse<T>> {
    const method = (request.method ?? 'GET').toUpperCase();
    let url = this.#resolve(request);
    const maxAttempts = request.retry === false ? 1 : (this.#o.retry?.attempts ?? 5);
    let attempt = 0;
    let redirects = 0;
    for (;;) {
      attempt++;
      try {
        const result = await this.#once<T>(method, url, request);
        if ('redirect' in result) {
          if (++redirects > MAX_REDIRECTS) {
            throw this.#error('invalid', method, url, 'Too many redirects');
          }
          url = result.redirect;
          attempt--;
          continue;
        }
        return result;
      } catch (error) {
        const retryable =
          error instanceof AdapterError && error.code === 'transient' && attempt < maxAttempts;
        if (!retryable) throw error;
        const delay = this.#backoff(attempt);
        this.#logger.debug(
          { provider: this.#o.provider, method, url: this.#safeUrl(url), attempt, delayMs: delay },
          'retrying a transient provider failure',
        );
        await this.#sleep(delay, request.signal);
      }
    }
  }

  /** Exponential backoff with full jitter: random in [0, min(cap, base * 2^(attempt - 1))]. */
  #backoff(attempt: number): number {
    const base = this.#o.retry?.baseMs ?? 1000;
    const cap = this.#o.retry?.capMs ?? 60_000;
    return Math.floor(this.#random() * Math.min(cap, base * 2 ** (attempt - 1)));
  }

  #scrub(secrets: readonly string[] = []): ScrubOptions {
    return { secrets, shapes: this.#o.tokenShapes ?? [] };
  }

  #safeUrl(url: URL, scrub: ScrubOptions = {}): string {
    return stripUrl(url.toString(), scrub);
  }

  #error(
    code: AdapterErrorCode,
    method: string,
    url: URL,
    message: string,
    extra: {
      status?: number;
      retryAfterMs?: number;
      retryAt?: Date;
      cause?: unknown;
      secrets?: readonly string[];
    } = {},
  ): AdapterError {
    const safeUrl = this.#safeUrl(url, this.#scrub(extra.secrets));
    return new AdapterError({
      code,
      provider: this.#o.provider,
      message: stripText(`${method} ${safeUrl}: ${message}`, this.#scrub(extra.secrets)).slice(
        0,
        MAX_ERROR_MESSAGE,
      ),
      ...(extra.retryAfterMs !== undefined ? { retryAfterMs: extra.retryAfterMs } : {}),
      ...(extra.retryAt !== undefined ? { retryAt: extra.retryAt } : {}),
      request: {
        method,
        url: safeUrl,
        ...(extra.status !== undefined ? { status: extra.status } : {}),
      },
      ...(extra.cause !== undefined
        ? { cause: sanitizeCause(extra.cause, this.#scrub(extra.secrets)) }
        : {}),
    });
  }

  async #once<T>(
    method: string,
    url: URL,
    request: ProviderRequest,
  ): Promise<ProviderResponse<T> | { redirect: URL }> {
    const o = this.#o;
    this.#checkHost(url);
    const cls = o.classify({ method, path: this.#classifyPath(url) });
    const pool = request.pool ?? o.pool ?? 'background';
    const bucketLabel = cls.bucketLabel ?? bucketGroup(cls.buckets[0]?.key);
    const started = performance.now();
    const span = o.telemetry?.startSpan?.('provider.request', {
      provider: o.provider,
      endpoint: cls.endpoint,
      bucket: bucketLabel,
      method,
    });
    let status = 'error';
    let secrets: readonly string[] = [];
    let leaseId: bigint | undefined;
    let spanEnded = false;
    const finishSpan = (error?: string) => {
      if (spanEnded) return;
      spanEnded = true;
      span?.setAttributes({ status });
      span?.end(error);
    };
    try {
      // Credentials first: a failure here must not spend quota (no refund path exists).
      let credentials: RequestCredentials;
      try {
        credentials = await o.authorize();
      } catch (error) {
        if (isAbort(error, request.signal) || error instanceof AdapterError) throw error;
        status = 'authorize_error';
        throw this.#error(
          isNetworkError(error) ? 'transient' : 'unauthorized',
          method,
          url,
          'Could not obtain credentials',
          { cause: error },
        );
      }
      secrets = credentials.secrets ?? [];
      if (secrets.some((secret) => secret.length < MIN_SECRET_LENGTH)) {
        throw this.#error(
          'invalid',
          method,
          url,
          `A declared secret is shorter than ${MIN_SECRET_LENGTH} characters and cannot be scrubbed`,
        );
      }
      if (cls.concurrency !== undefined && o.leases === undefined) {
        throw this.#error(
          'invalid',
          method,
          url,
          'The request class needs an in-flight cap but no LeaseGate is configured',
        );
      }
      if (cls.concurrency !== undefined && o.leases !== undefined) {
        leaseId = await o.leases.acquire(
          cls.concurrency.bucketKey,
          `${o.endpointId}:${crypto.randomUUID()}`,
          cls.concurrency.cap,
        );
        if (leaseId === undefined) {
          status = 'concurrency';
          throw this.#error('rate_limited', method, url, 'In-flight request cap reached', {
            retryAfterMs: 1000,
          });
        }
      }
      const grant = await o.quota.acquire(cls.buckets, pool);
      if (!grant.granted) {
        status = `denied_${grant.reason}`;
        const retryAfterMs = Math.max(0, grant.retryAt.getTime() - this.#now().getTime());
        throw this.#error(
          'rate_limited',
          method,
          url,
          `Quota ${grant.reason} for ${grant.bucketKey}`,
          {
            retryAfterMs,
            retryAt: grant.retryAt,
          },
        );
      }
      const headers = new Headers(request.headers);
      for (const [name, value] of Object.entries(credentials.headers)) headers.set(name, value);
      let body: string | Uint8Array | undefined = request.body;
      if (request.json !== undefined) {
        body = JSON.stringify(request.json);
        if (!headers.has('content-type')) headers.set('content-type', 'application/json');
      }
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method,
          headers,
          ...(body !== undefined ? { body: body as NonNullable<RequestInit['body']> } : {}),
          redirect: 'manual',
          ...(request.signal !== undefined ? { signal: request.signal } : {}),
        });
      } catch (error) {
        if (isAbort(error, request.signal)) throw error;
        status = 'network_error';
        throw this.#error('transient', method, url, 'Network error', { cause: error, secrets });
      }
      status = String(response.status);
      if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
        const next = new URL(response.headers.get('location') as string, url);
        this.#assertInBase(next);
        if (method !== 'GET' && method !== 'HEAD') {
          throw this.#error('invalid', method, url, 'Refusing to follow a redirect for a write', {
            status: response.status,
            secrets,
          });
        }
        if (next.origin !== this.#base.origin) {
          throw this.#error('invalid', method, url, 'Refusing a redirect to a different origin', {
            status: response.status,
            secrets,
          });
        }
        await response.body?.cancel();
        return { redirect: next };
      }
      let text: string;
      try {
        text = await this.#readBody(response);
      } catch (error) {
        if (isAbort(error, request.signal)) throw error;
        if (error instanceof AdapterError) {
          throw this.#error(error.code, method, url, error.message, {
            status: response.status,
            secrets,
          });
        }
        status = 'network_error';
        throw this.#error('transient', method, url, 'Network error reading the body', {
          cause: error,
          secrets,
        });
      }
      const parsed = parseBody(text, response.headers.get('content-type'));
      const interpretation = o.interpret?.({
        status: response.status,
        headers: response.headers,
        body: parsed,
        method,
        path: this.#classifyPath(url),
        grantedAt: grant.at,
      });
      await this.#applyQuota(grant.at, pool, interpretation);
      const rawResponseId =
        request.capture === true
          ? await this.#capture(method, url, response, parsed, this.#scrub(secrets))
          : undefined;
      const limited = await this.#limitSignal(cls, response, interpretation);
      if (limited !== undefined) {
        status = String(response.status);
        throw this.#error('rate_limited', method, url, `Rate limited (${response.status})`, {
          status: response.status,
          retryAfterMs: limited.retryAfterMs,
          retryAt: limited.retryAt,
          secrets,
        });
      }
      if (response.status >= 400) {
        const code = interpretation?.code ?? statusCode(response.status);
        const detail = interpretation?.message ?? `HTTP ${response.status}`;
        throw this.#error(code, method, url, detail, { status: response.status, secrets });
      }
      finishSpan();

      return {
        status: response.status,
        headers: response.headers,
        body: parsed as T,
        url: this.#safeUrl(url, this.#scrub(secrets)),
        grantedAt: grant.at,
        ...(rawResponseId !== undefined ? { rawResponseId } : {}),
      };
    } catch (error) {
      finishSpan(error instanceof Error ? stripText(error.message, this.#scrub(secrets)) : 'error');
      throw error;
    } finally {
      if (leaseId !== undefined) {
        await o.leases?.release(leaseId).catch((error: unknown) => {
          this.#logger.warn(
            { provider: o.provider, error: stripText(String(error), this.#scrub(secrets)) },
            'releasing a quota lease failed; it expires on its own',
          );
        });
      }
      o.telemetry?.recordRequest(
        { provider: o.provider, endpoint: cls.endpoint, bucket: bucketLabel, status },
        (performance.now() - started) / 1000,
      );
    }
  }

  async #applyQuota(
    grantedAt: Date,
    pool: QuotaPool,
    interpretation: Interpretation | undefined,
  ): Promise<void> {
    if (interpretation === undefined) return;
    const warn = (what: string, error: unknown) =>
      this.#logger.warn(
        { provider: this.#o.provider, error: stripText(String(error), this.#scrub()) },
        `recording ${what} with the quota service failed`,
      );
    for (const feedback of interpretation.feedback ?? []) {
      try {
        await this.#o.quota.recordFeedback({
          ...feedback,
          observedSince: feedback.observedSince ?? grantedAt,
        });
      } catch (error) {
        warn('provider feedback', error);
      }
    }
    for (const { bucketKey, delta } of interpretation.adjust ?? []) {
      try {
        await this.#o.quota.adjust(bucketKey, pool, delta);
      } catch (error) {
        warn('a cost adjustment', error);
      }
    }
  }

  /** Records a 429 or an adapter-detected limit on every bucket of the request (JOB-044, JOB-045). */
  async #limitSignal(
    cls: RequestClass,
    response: Response,
    interpretation: Interpretation | undefined,
  ): Promise<{ retryAt: Date; retryAfterMs: number } | undefined> {
    const signal =
      interpretation?.signal ??
      (response.status === 429 ? { kind: 'rate-limited' as const } : undefined);
    if (signal === undefined) return undefined;
    const retryAfterSeconds =
      signal.retryAfterSeconds ?? parseRetryAfter(response.headers.get('retry-after'), this.#now());
    let latest: Date | undefined;
    for (const bucket of cls.buckets) {
      const common = {
        bucketKey: bucket.key,
        limit: bucket.limit,
        windowSeconds: bucket.windowSeconds,
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      };
      const blockedUntil =
        signal.kind === 'secondary-limit'
          ? await this.#o.quota.recordSecondaryLimit(common)
          : await this.#o.quota.recordRateLimited({
              ...common,
              ...(cls.minBlockSeconds !== undefined
                ? { minBlockSeconds: cls.minBlockSeconds }
                : {}),
            });
      if (latest === undefined || blockedUntil > latest) latest = blockedUntil;
    }
    const retryAt = latest ?? new Date(this.#now().getTime() + (retryAfterSeconds ?? 60) * 1000);
    return { retryAt, retryAfterMs: Math.max(0, retryAt.getTime() - this.#now().getTime()) };
  }

  async #capture(
    method: string,
    url: URL,
    response: Response,
    body: unknown,
    scrub: ScrubOptions,
  ): Promise<string | undefined> {
    const sink = this.#o.capture;
    if (sink === undefined) return undefined;
    try {
      const contentType = response.headers.get('content-type') ?? '';
      let stripped: unknown;
      if (typeof body === 'string') {
        stripped = /x-www-form-urlencoded/i.test(contentType)
          ? stripForm(body, scrub)
          : stripText(body, scrub);
      } else {
        stripped = stripBody(body, scrub);
      }
      const size = JSON.stringify(stripped ?? null).length;
      if (size > MAX_CAPTURE_TEXT) stripped = { truncated: true, bytes: size };
      return await sink.save({
        endpointId: this.#o.endpointId,
        method,
        url: this.#safeUrl(url, scrub),
        status: response.status,
        headers: stripHeaders(response.headers, scrub),
        body: stripped ?? null,
        fetchedAt: this.#now(),
      });
    } catch (error) {
      this.#logger.warn(
        { provider: this.#o.provider, error: stripText(String(error), scrub) },
        'raw response capture failed',
      );
      return undefined;
    }
  }

  /** Reads the body as text, stopping at `maxResponseBytes` without buffering the rest. */
  async #readBody(response: Response): Promise<string> {
    const max = this.#o.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    const tooBig = () =>
      new AdapterError({
        code: 'invalid',
        provider: this.#o.provider,
        message: `Response body exceeds ${max} bytes`,
      });
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > max) {
      await response.body?.cancel();
      throw tooBig();
    }
    if (response.body === null) return '';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel();
        throw tooBig();
      }
      chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  }

  get<T = unknown>(path: string, options: Omit<ProviderRequest, 'path' | 'method'> = {}) {
    return this.request<T>({ ...options, path, method: 'GET' });
  }
}

function bucketGroup(key: string | undefined): string {
  return (key === undefined ? undefined : parseBucketKey(key)?.resourceGroup) ?? 'unknown';
}

/** A cause error keeps its message but loses any credential text; the original object is dropped. */
function sanitizeCause(cause: unknown, scrub: ScrubOptions = {}): Error {
  const message = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  return new Error(stripText(message, scrub));
}
