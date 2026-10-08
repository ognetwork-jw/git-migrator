/**
 * Rolling-window rate limiter modelling the documented Bitbucket limits (provider doc,
 * "Rate limits"). No headers are ever emitted, a 429 is the only signal (TST-010).
 */

/**
 * Resource groups of JOB-043. The `git` group (60,000/h, smart-HTTP requests) belongs to the git
 * server of T-040, not to this REST fake.
 */
export type LimitCategory = 'repository-data' | 'webhooks' | 'raw-files' | 'app-properties';
export const LIMIT_CATEGORIES: readonly LimitCategory[] = [
  'repository-data',
  'webhooks',
  'raw-files',
  'app-properties',
];

export interface LimitConfig {
  /** Max requests per window for each category. `null` or absent disables the category. */
  limits: Partial<Record<LimitCategory, number | null>>;
  /** Length of the rolling window. Documented: one hour. */
  windowMs: number;
}

/** Documented defaults (provider doc): 1,000/h repository data, 5,000/h raw, 1,000/h webhooks. */
export const DEFAULT_LIMITS: LimitConfig = {
  limits: { 'repository-data': 1000, webhooks: 1000, 'raw-files': 5000, 'app-properties': 2000 },
  windowMs: 60 * 60 * 1000,
};

/**
 * Resource groups a REST request is counted in (JOB-043). Every `/2.0` or `/1.0` path that is not
 * a hook, a properties call or a raw file is `repository-data`. Hooks and properties are listed
 * separately in JOB-043, so they are counted only in their own group. A raw file download is
 * counted in `raw-files` AND `repository-data`.
 */
export function classify(
  method: string,
  path: string,
  isDirectory: (path: string) => boolean = () => false,
): LimitCategory[] {
  if (/^\/2\.0\/(repositories\/[^/]+\/[^/]+|workspaces\/[^/]+)\/hooks(\/|$)/.test(path))
    return ['webhooks'];
  if (
    [
      /^\/2\.0\/repositories\/[^/]+\/[^/]+\/properties\/[^/]+\/[^/]+$/,
      /^\/2\.0\/repositories\/[^/]+\/[^/]+\/commit\/[^/]+\/properties\/[^/]+\/[^/]+$/,
      /^\/2\.0\/repositories\/[^/]+\/[^/]+\/pullrequests\/[^/]+\/properties\/[^/]+\/[^/]+$/,
      /^\/2\.0\/users\/[^/]+\/properties\/[^/]+\/[^/]+$/,
    ].some((re) => re.test(path))
  )
    return ['app-properties'];
  if (
    method === 'GET' &&
    /^\/2\.0\/repositories\/[^/]+\/[^/]+\/src\/[^/]+\/.+[^/]$/.test(path) &&
    !isDirectory(path)
  ) {
    return ['raw-files', 'repository-data'];
  }
  if (method === 'GET' && /^\/2\.0\/repositories\/[^/]+\/[^/]+\/downloads\/.+/.test(path)) {
    return ['raw-files', 'repository-data'];
  }
  if (/^\/(1|2)\.0\//.test(path)) return ['repository-data'];
  return [];
}

export class RateLimiter {
  private config: LimitConfig;
  private hits = new Map<string, number[]>();
  private readonly now: () => number;

  constructor(initial: Partial<LimitConfig> = {}, now: () => number = Date.now) {
    this.now = now;
    this.config = RateLimiter.merge(DEFAULT_LIMITS, initial);
  }

  private static merge(base: LimitConfig, patch: Partial<LimitConfig>): LimitConfig {
    return {
      windowMs: patch.windowMs ?? base.windowMs,
      limits: { ...base.limits, ...(patch.limits ?? {}) },
    };
  }

  configure(patch: Partial<LimitConfig>): void {
    this.config = RateLimiter.merge(this.config, patch);
  }

  /** Back to the given config (defaults when omitted) and forgets all counters. */
  reset(config: Partial<LimitConfig> = {}): void {
    this.config = RateLimiter.merge(DEFAULT_LIMITS, config);
    this.hits.clear();
  }

  /** Forgets all counters but keeps the configured limits. */
  clearUsage(): void {
    this.hits.clear();
  }

  /**
   * Records a request for `accountId` in every category. All categories must grant, otherwise
   * nothing is recorded and the answer is 429 (JOB-043: counted in both groups atomically).
   */
  consume(accountId: string, categories: LimitCategory[]): boolean {
    const t = this.now();
    const live = new Map<string, number[]>();
    for (const category of categories) {
      const limit = this.config.limits[category];
      if (limit === null || limit === undefined) continue;
      const key = `${accountId}\0${category}`;
      const times = (this.hits.get(key) ?? []).filter((x) => x > t - this.config.windowMs);
      this.hits.set(key, times);
      if (times.length >= limit) return false;
      live.set(key, times);
    }
    for (const times of live.values()) times.push(t);
    return true;
  }

  snapshot(): unknown {
    const t = this.now();
    const used: Record<string, number> = {};
    for (const [key, times] of this.hits) {
      used[key.replace('\0', ':')] = times.filter((x) => x > t - this.config.windowMs).length;
    }
    return { windowMs: this.config.windowMs, limits: this.config.limits, used };
  }
}
