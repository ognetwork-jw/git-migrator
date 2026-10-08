import type { AuthCtx } from './auth.ts';
import type { ForcedSecondaryLimit } from './config.ts';
import type { GitHubState } from './state.ts';
import { GhError } from './util.ts';

export type Resource = 'core' | 'graphql' | 'search';

export interface PrimaryInfo {
  limit: number;
  remaining: number;
  used: number;
  /** Epoch seconds. */
  reset: number;
  resource: Resource;
}

interface Window {
  start: number;
  used: number;
}

const HOUR = 3600 * 1000;
const MINUTE = 60 * 1000;
export const SECONDARY_DOC =
  'https://docs.github.com/rest/overview/rate-limits-for-the-rest-api#about-secondary-rate-limits';
export const PRIMARY_DOC = 'https://docs.github.com/rest/overview/rate-limits-for-the-rest-api';

/** `x-ratelimit-*` response headers (not the `x-rate-limit-*` names of the OpenAPI components). */
export function rateHeaders(info: PrimaryInfo): Record<string, string> {
  return {
    'x-ratelimit-limit': String(info.limit),
    'x-ratelimit-remaining': String(info.remaining),
    'x-ratelimit-used': String(info.used),
    'x-ratelimit-reset': String(info.reset),
    'x-ratelimit-resource': info.resource,
  };
}

export class RateLimiter {
  private windows = new Map<string, Window>();
  private points = new Map<string, { at: number; points: number }[]>();
  private inflight = new Map<string, number>();

  private readonly state: GitHubState;

  constructor(state: GitHubState) {
    this.state = state;
  }

  clear(): void {
    this.windows.clear();
    this.points.clear();
    this.inflight.clear();
  }

  /** Default limit per the provider doc: 5,000 + 50 per repo and per org user above 20, max 12,500. */
  limitFor(auth: AuthCtx, resource: Resource): number {
    const override = this.state.config.primary.limits?.[resource];
    if (override !== undefined) return override;
    if (resource === 'search') return 30;
    const inst = auth.installation;
    if (!inst) return auth.kind === 'jwt' ? 5000 : 60;
    const org = this.state.orgs.get(inst.account.toLowerCase());
    if (org?.plan.name === 'enterprise') return 15000;
    const repos = [...this.state.repos.values()].filter(
      (r) => r.owner.toLowerCase() === inst.account.toLowerCase(),
    ).length;
    const users = org?.members.size ?? 0;
    return Math.min(12500, 5000 + 50 * Math.max(0, repos - 20) + 50 * Math.max(0, users - 20));
  }

  private windowMs(): number {
    return this.state.config.primary.windowMs ?? HOUR;
  }

  /** Current state of a resource bucket without counting a request. */
  peek(auth: AuthCtx, resource: Resource): PrimaryInfo {
    const now = this.state.clock();
    const key = `${auth.rateKey}:${resource}`;
    let w = this.windows.get(key);
    if (w && now >= w.start + this.windowMs()) {
      this.windows.delete(key);
      w = undefined;
    }
    const limit = this.limitFor(auth, resource);
    const used = w?.used ?? 0;
    return {
      limit,
      used,
      remaining: Math.max(0, limit - used),
      reset: Math.ceil(((w?.start ?? now) + this.windowMs()) / 1000),
      resource,
    };
  }

  /** Counts a request against the primary limit; throws the 403/429 once the budget is spent. */
  consumePrimary(auth: AuthCtx, resource: Resource, cost = 1): PrimaryInfo {
    const before = this.peek(auth, resource);
    if (before.remaining < cost) {
      const status = this.state.config.primary.status ?? 403;
      const who = auth.installation
        ? `installation ID ${auth.installation.id}`
        : auth.kind === 'jwt'
          ? `App ID ${auth.app?.id}`
          : 'this IP';
      throw new GhError(status, `API rate limit exceeded for ${who}.`, {
        headers: rateHeaders({ ...before, remaining: 0 }),
        docUrl: PRIMARY_DOC,
      });
    }
    const key = `${auth.rateKey}:${resource}`;
    const now = this.state.clock();
    const w = this.windows.get(key) ?? { start: now, used: 0 };
    w.used += cost;
    this.windows.set(key, w);
    return this.peek(auth, resource);
  }

  // -- secondary --------------------------------------------------------------------------------

  begin(auth: AuthCtx): () => void {
    this.inflight.set(auth.rateKey, (this.inflight.get(auth.rateKey) ?? 0) + 1);
    return () =>
      this.inflight.set(auth.rateKey, Math.max(0, (this.inflight.get(auth.rateKey) ?? 1) - 1));
  }

  private reject(status: number, retryAfterSeconds: number, send: boolean, auth: AuthCtx): never {
    const headers: Record<string, string> = {};
    if (send) headers['retry-after'] = String(Math.max(1, Math.ceil(retryAfterSeconds)));
    const info = this.peek(auth, 'core');
    Object.assign(headers, rateHeaders(info));
    throw new GhError(
      status,
      'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
      { headers, docUrl: SECONDARY_DOC },
    );
  }

  /** The recent entries of `key` plus a prospective one; nothing is stored until `commit`. */
  private prospective(key: string, now: number, points: number, horizon: number) {
    const list = (this.points.get(key) ?? []).filter((e) => now - e.at < horizon);
    list.push({ at: now, points });
    return { key, list };
  }

  private wait(
    list: { at: number; points: number }[],
    now: number,
    window: number,
    limit: number,
  ): number {
    // Seconds until enough points leave the window to get back under the limit.
    let total = list.reduce((a, e) => a + (now - e.at < window ? e.points : 0), 0);
    for (const e of list) {
      if (total <= limit) return 0;
      total -= e.points;
      if (total <= limit) return (e.at + window - now) / 1000;
    }
    return window / 1000;
  }

  /**
   * Secondary limit accounting for one request. `routeKey` is the route template (REST per-endpoint
   * points), `kind` selects the REST or GraphQL points budget.
   */
  checkSecondary(
    auth: AuthCtx,
    request: {
      method: string;
      path: string;
      routeKey: string;
      kind: 'rest' | 'graphql';
      mutation: boolean;
    },
  ): void {
    const cfg = this.state.config.secondary;
    const send = cfg.retryAfter ?? true;
    const status = cfg.status ?? 403;
    const now = this.state.clock();

    const forced = this.state.config.forced;
    if (forced && forced.requests > 0 && forcedMatches(forced, request)) {
      forced.requests -= 1;
      this.reject(
        forced.status ?? status,
        forced.retryAfterSeconds ?? 60,
        forced.retryAfter ?? send,
        auth,
      );
    }

    const concurrent = cfg.concurrent === undefined ? 100 : cfg.concurrent;
    // `begin` already counted this request.
    if (concurrent !== null && (this.inflight.get(auth.rateKey) ?? 0) > concurrent)
      this.reject(status, 60, send, auth);

    const pts = request.mutation ? 5 : 1;
    const pending: { key: string; list: { at: number; points: number }[] }[] = [];
    const sum = (list: { points: number }[]) => list.reduce((a, e) => a + e.points, 0);
    if (request.kind === 'graphql') {
      const limit = cfg.graphqlPointsPerMinute === undefined ? 2000 : cfg.graphqlPointsPerMinute;
      if (limit !== null) {
        const p = this.prospective(`${auth.rateKey}:graphql`, now, pts, MINUTE);
        if (sum(p.list) > limit)
          this.reject(status, this.wait(p.list, now, MINUTE, limit), send, auth);
        pending.push(p);
      }
    } else {
      const limit = cfg.restPointsPerMinute === undefined ? 900 : cfg.restPointsPerMinute;
      if (limit !== null) {
        const p = this.prospective(`${auth.rateKey}:rest:${request.routeKey}`, now, pts, MINUTE);
        if (sum(p.list) > limit)
          this.reject(status, this.wait(p.list, now, MINUTE, limit), send, auth);
        pending.push(p);
      }
      if (request.mutation) {
        const perMinute =
          cfg.contentCreationPerMinute === undefined ? 80 : cfg.contentCreationPerMinute;
        const perHour = cfg.contentCreationPerHour === undefined ? 500 : cfg.contentCreationPerHour;
        const p = this.prospective(`${auth.rateKey}:content`, now, 1, HOUR);
        if (perMinute !== null && p.list.filter((e) => now - e.at < MINUTE).length > perMinute)
          this.reject(status, this.wait(p.list, now, MINUTE, perMinute), send, auth);
        if (perHour !== null && p.list.length > perHour)
          this.reject(status, this.wait(p.list, now, HOUR, perHour), send, auth);
        pending.push(p);
      }
    }
    // Rejected requests are not counted.
    for (const p of pending) this.points.set(p.key, p.list);
  }
}

function forcedMatches(
  forced: ForcedSecondaryLimit,
  req: { method: string; path: string },
): boolean {
  return !forced.match || new RegExp(forced.match).test(`${req.method} ${req.path}`);
}
