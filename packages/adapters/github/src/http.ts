/**
 * Request classification, rate-limit interpretation and client construction (ADP-060, JOB-045,
 * ADR-0190, ADR-0230). All GitHub HTTP goes through ProviderHttpClient.
 */
import {
  type AdapterContext,
  AdapterError,
  type AdapterErrorCode,
  type BucketSpec,
  bucketKey,
  type Classifier,
  type Interpretation,
  type Interpreter,
  ProviderHttpClient,
  type QuotaFeedback,
  type RequestClass,
} from '@git-migrator/adapter-sdk';
import {
  cacheKey,
  type InstallationToken,
  type InstallationTokenCache,
  signAppJwt,
} from './auth.ts';
import { type GitHubConfig, type GitHubCredential, PROVIDER } from './config.ts';

/** Linear, bounded token shapes (ghp_, gho_, ghu_, ghs_, ghr_, github_pat_). */
export const TOKEN_SHAPES: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,255}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,255}/g,
];

const HOUR = 3600;

/** Defaults per resource group (provider doc "Rate limits"); `quotaOverrides` replace the limit. */
export const DEFAULT_LIMITS: Readonly<Record<string, { limit: number; windowSeconds: number }>> = {
  core: { limit: 5000, windowSeconds: HOUR },
  graphql: { limit: 5000, windowSeconds: HOUR },
  search: { limit: 30, windowSeconds: 60 },
  'content-minute': { limit: 80, windowSeconds: 60 },
  'content-hour': { limit: 500, windowSeconds: HOUR },
  lfs: { limit: 3000, windowSeconds: 60 },
  'app-token': { limit: 2000, windowSeconds: HOUR },
};

const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
const LABEL_WORDS = new Set([
  'members',
  'memberships',
  'invitations',
  'failed_invitations',
  'keys',
  'hooks',
  'collaborators',
  'environments',
  'deployment-branch-policies',
  'actions',
  'variables',
  'secrets',
  'git',
  'refs',
  'ref',
  'matching-refs',
  'commits',
  'trees',
  'blobs',
  'contents',
  'pulls',
  'compare',
  'branches',
  'protection',
  'outside_collaborators',
  'users',
  'app',
  'installations',
  'access_tokens',
  'graphql',
  'rate_limit',
  'search',
  'apps',
  'installation',
  'teams',
  'repos',
]);

/** Low-cardinality label such as `repos.keys.post` (metrics `endpoint`). */
export function endpointLabel(method: string, path: string): string {
  const parts = path.split('/').filter((p) => p !== '');
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as string;
    if (i === 0 && (part === 'repos' || part === 'orgs')) {
      out.push(part);
      i += part === 'repos' ? 2 : 1;
    } else if (LABEL_WORDS.has(part)) out.push(part);
    else if (out[out.length - 1] !== ':id') out.push(':id');
  }
  return `${out.join('.') || 'root'}.${method.toLowerCase()}`;
}

export interface ClassifierOptions {
  readonly endpointId: string;
  readonly accountKey: string;
  readonly config: Pick<GitHubConfig, 'maxConcurrentRequests' | 'quotaOverrides'>;
  /** False when the host supplies no LeaseGate: the in-flight cap is then not enforced. */
  readonly leases: boolean;
}

function bucket(o: ClassifierOptions, group: string): BucketSpec {
  const d =
    DEFAULT_LIMITS[group] ?? (DEFAULT_LIMITS.core as { limit: number; windowSeconds: number });
  return {
    key: bucketKey(o.endpointId, o.accountKey, group),
    limit: o.config.quotaOverrides[group] ?? d.limit,
    windowSeconds: d.windowSeconds,
  };
}

/** Route to bucket classifier for the REST and GraphQL API (JOB-045). */
export function createClassifier(o: ClassifierOptions): Classifier {
  const concurrency = o.leases
    ? {
        bucketKey: bucketKey(o.endpointId, o.accountKey, 'concurrent'),
        cap: o.config.maxConcurrentRequests,
      }
    : undefined;
  return ({ method, path }): RequestClass => {
    const upper = method.toUpperCase();
    const base = {
      endpoint: endpointLabel(upper, path),
      minBlockSeconds: 60,
      ...(concurrency ? { concurrency } : {}),
    };
    if (path === '/graphql') return { ...base, buckets: [bucket(o, 'graphql')] };
    if (path.startsWith('/search/')) return { ...base, buckets: [bucket(o, 'search')] };
    if (WRITE_METHODS.has(upper)) {
      return {
        ...base,
        buckets: [bucket(o, 'core'), bucket(o, 'content-minute'), bucket(o, 'content-hour')],
        bucketLabel: 'core',
      };
    }
    return { ...base, buckets: [bucket(o, 'core')] };
  };
}

/** LFS batch API (the web host): its own limit. */
export function createLfsClassifier(o: ClassifierOptions): Classifier {
  return ({ method, path }) => ({
    endpoint: `lfs.${endpointLabel(method, path)}`,
    buckets: [bucket(o, 'lfs')],
    minBlockSeconds: 60,
  });
}

/** App-authenticated calls (installation token exchange). */
export function createAppClassifier(o: ClassifierOptions): Classifier {
  return ({ method, path }) => ({
    endpoint: endpointLabel(method, path),
    buckets: [bucket(o, 'app-token')],
    minBlockSeconds: 60,
  });
}

function headerNumber(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null || !/^\d{1,15}$/.test(raw.trim())) return undefined;
  return Number(raw);
}

function bodyMessage(body: unknown): string {
  if (typeof body === 'string') return body.slice(0, 500);
  if (body === null || typeof body !== 'object') return '';
  const b = body as { message?: unknown; errors?: unknown };
  const parts: string[] = [];
  if (typeof b.message === 'string') parts.push(b.message);
  if (Array.isArray(b.errors)) {
    for (const e of b.errors.slice(0, 5)) {
      if (typeof e === 'string') parts.push(e);
      else if (e && typeof e === 'object') {
        const m = (e as { message?: unknown }).message;
        if (typeof m === 'string') parts.push(m);
      }
    }
  }
  return parts.join('; ').slice(0, 500);
}

export interface InterpretOptions {
  readonly endpointId: string;
  readonly accountKey: string;
  readonly config: Pick<GitHubConfig, 'quotaOverrides'>;
  readonly now?: () => Date;
  /** Called on a 401 so the cached installation token is dropped. */
  readonly onUnauthorized?: () => void;
}

const MUTATION_FIELDS = new Set([
  'createBranchProtectionRule',
  'updateBranchProtectionRule',
  'deleteBranchProtectionRule',
]);

/** Parses `x-ratelimit-*` (including `resource`) into neutral feedback and classifies limits. */
export function createInterpreter(o: InterpretOptions): Interpreter {
  const now = o.now ?? (() => new Date());
  return (res): Interpretation | undefined => {
    const limit = headerNumber(res.headers, 'x-ratelimit-limit');
    const remaining = headerNumber(res.headers, 'x-ratelimit-remaining');
    const reset = headerNumber(res.headers, 'x-ratelimit-reset');
    const resource = (res.headers.get('x-ratelimit-resource') ?? 'core').trim();
    const feedback: QuotaFeedback[] = [];
    // Only resources with a known window get a bucket; unknown ones would create stray keys.
    const known = DEFAULT_LIMITS[resource];
    if (
      limit !== undefined &&
      limit > 0 &&
      known !== undefined &&
      /^[a-z0-9_-]{1,40}$/.test(resource)
    ) {
      const rem = remaining === undefined ? undefined : Math.min(remaining, limit);
      feedback.push({
        bucketKey: bucketKey(o.endpointId, o.accountKey, resource),
        // The provider's own limit is authoritative; overrides only set the starting limit.
        limit,
        windowSeconds: known.windowSeconds,
        ...(rem !== undefined ? { remaining: rem, nearLimit: rem <= limit * 0.2 } : {}),
        ...(reset !== undefined ? { resetAt: new Date(reset * 1000) } : {}),
        fixedWindow: true,
      });
    }
    const out: {
      feedback?: QuotaFeedback[];
      signal?: Interpretation['signal'];
      adjust?: { bucketKey: string; delta: number }[];
      code?: AdapterErrorCode;
      message?: string;
    } = {};
    if (feedback.length > 0) out.feedback = feedback;
    if (res.status === 401) o.onUnauthorized?.();

    if (res.status === 403 || res.status === 429) {
      const text = bodyMessage(res.body);
      const retryAfter = headerNumber(res.headers, 'retry-after');
      if (/secondary rate limit|abuse detection/i.test(text)) {
        out.signal = {
          kind: 'secondary-limit',
          ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}),
        };
      } else if (remaining === 0 || /rate limit exceeded/i.test(text)) {
        const wait =
          retryAfter ??
          (reset !== undefined
            ? Math.max(1, Math.ceil(reset - now().getTime() / 1000))
            : undefined);
        out.signal = {
          kind: 'rate-limited',
          ...(wait !== undefined ? { retryAfterSeconds: wait } : {}),
        };
      } else if (res.status === 403) {
        out.code = 'forbidden';
      }
      if (text !== '') out.message = text;
    } else if (res.status >= 400 && res.status < 500) {
      const text = bodyMessage(res.body);
      if (text !== '') out.message = text;
      if (res.status === 422 && /already (exists|in use)/i.test(text)) out.code = 'conflict';
    }

    // GraphQL reports limits inside a 200 response.
    if (
      res.path === '/graphql' &&
      res.body &&
      typeof res.body === 'object' &&
      out.signal === undefined
    ) {
      const errors = (res.body as { errors?: { type?: unknown; message?: unknown }[] }).errors;
      const hit = Array.isArray(errors)
        ? errors.find(
            (e) =>
              String(e?.type ?? '').toUpperCase() === 'RATE_LIMITED' ||
              /secondary rate limit/i.test(String(e?.message ?? '')),
          )
        : undefined;
      if (hit) {
        const retryAfter = headerNumber(res.headers, 'retry-after');
        const wait =
          retryAfter ??
          (reset !== undefined
            ? Math.max(1, Math.ceil(reset - now().getTime() / 1000))
            : undefined);
        out.signal = {
          kind: /secondary/i.test(String(hit.message ?? '')) ? 'secondary-limit' : 'rate-limited',
          ...(wait !== undefined ? { retryAfterSeconds: wait } : {}),
        };
      }
    }

    // GraphQL: reconcile the 1-point estimate with the reported cost, and charge mutations to the
    // content-creation buckets (the classifier cannot tell a mutation from a query).
    if (res.path === '/graphql' && res.body && typeof res.body === 'object') {
      const data = (res.body as { data?: Record<string, unknown> | null }).data;
      const cost = (data?.rateLimit as { cost?: unknown } | undefined)?.cost;
      const adjust: { bucketKey: string; delta: number }[] = [];
      if (typeof cost === 'number' && Number.isFinite(cost) && cost > 1) {
        adjust.push({
          bucketKey: bucketKey(o.endpointId, o.accountKey, 'graphql'),
          delta: cost - 1,
        });
      }
      if (data && Object.keys(data).some((k) => MUTATION_FIELDS.has(k))) {
        for (const g of ['content-minute', 'content-hour']) {
          adjust.push({ bucketKey: bucketKey(o.endpointId, o.accountKey, g), delta: 1 });
        }
      }
      if (adjust.length > 0) out.adjust = adjust;
    }
    return Object.keys(out).length === 0 ? undefined : out;
  };
}

export interface ClientSet {
  /** REST and GraphQL on the API host. */
  readonly api: ProviderHttpClient;
  /** LFS batch API on the web host. */
  readonly lfs: ProviderHttpClient;
  /** Current installation token (git credentials). */
  token(): Promise<InstallationToken>;
}

export interface BuildClientsInput {
  readonly endpointId: string;
  readonly accountKey: string;
  readonly baseUrl: string;
  readonly config: GitHubConfig;
  readonly credential: GitHubCredential;
  readonly ctx: AdapterContext;
  readonly cache: InstallationTokenCache;
  readonly now: () => Date;
}

const USER_AGENT = 'git-migrator';

function baseHeaders(extra: Record<string, string>): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': USER_AGENT,
    ...extra,
  };
}

export function buildClients(input: BuildClientsInput): ClientSet {
  const { ctx, config, credential } = input;
  const classifierOptions: ClassifierOptions = {
    endpointId: input.endpointId,
    accountKey: input.accountKey,
    config,
    leases: ctx.leases !== undefined,
  };
  const common = {
    provider: PROVIDER,
    endpointId: input.endpointId,
    quota: ctx.quota,
    ...(ctx.leases ? { leases: ctx.leases } : {}),
    logger: ctx.logger,
    ...(ctx.capture ? { capture: ctx.capture } : {}),
    ...(ctx.telemetry ? { telemetry: ctx.telemetry } : {}),
    ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
    ...(ctx.environment ? { environment: ctx.environment } : {}),
    ...(ctx.testAllowedHosts ? { testAllowedHosts: ctx.testAllowedHosts } : {}),
    pool: ctx.pool,
    tokenShapes: TOKEN_SHAPES,
    now: input.now,
  };
  const interpretBase = {
    endpointId: input.endpointId,
    accountKey: input.accountKey,
    config,
    now: input.now,
  };
  const key = cacheKey(input.baseUrl, config.appId, config.installationId, credential.privateKey);

  // The JWT client exchanges the App JWT for an installation token; it has its own authorize.
  const appClient = new ProviderHttpClient({
    ...common,
    baseUrl: input.baseUrl,
    classify: createAppClassifier(classifierOptions),
    authorize: async () => {
      const jwt = signAppJwt(config.appId, credential.privateKey, input.now());
      return { headers: baseHeaders({ authorization: `Bearer ${jwt}` }), secrets: [jwt] };
    },
    interpret: createInterpreter(interpretBase),
  });
  const mint = async (): Promise<InstallationToken> => {
    const res = await appClient.request<{ token?: unknown; expires_at?: unknown }>({
      method: 'POST',
      path: `/app/installations/${config.installationId}/access_tokens`,
    });
    const token = res.body?.token;
    const expires = typeof res.body?.expires_at === 'string' ? new Date(res.body.expires_at) : null;
    if (
      typeof token !== 'string' ||
      token.length < 4 ||
      !expires ||
      Number.isNaN(expires.getTime())
    ) {
      throw new AdapterError({
        code: 'invalid',
        provider: PROVIDER,
        message: 'The installation token response was not understood',
      });
    }
    return { token, expiresAt: expires };
  };
  const token = () => input.cache.get(key, mint);

  const interpret = createInterpreter({
    ...interpretBase,
    onUnauthorized: () => input.cache.invalidate(key),
  });
  const api = new ProviderHttpClient({
    ...common,
    baseUrl: input.baseUrl,
    classify: createClassifier(classifierOptions),
    authorize: async () => {
      const t = await token();
      return { headers: baseHeaders({ authorization: `Bearer ${t.token}` }), secrets: [t.token] };
    },
    interpret,
  });
  const lfs = new ProviderHttpClient({
    ...common,
    baseUrl: config.gitBaseUrl,
    classify: createLfsClassifier(classifierOptions),
    authorize: async () => {
      const t = await token();
      const basic = Buffer.from(`x-access-token:${t.token}`).toString('base64');
      return {
        headers: {
          authorization: `Basic ${basic}`,
          accept: 'application/vnd.git-lfs+json',
          'user-agent': USER_AGENT,
        },
        secrets: [t.token, basic],
      };
    },
    interpret,
  });
  return { api, lfs, token };
}
