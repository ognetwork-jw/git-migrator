import type { Context, Hono } from 'hono';
import { type AuthCtx, authenticate, NO_AUTH } from './auth.ts';
import { paginate } from './link.ts';
import { PRIMARY_DOC, type RateLimiter, rateHeaders } from './rate-limit.ts';
import { Serializer } from './serialize.ts';
import { GitHubState } from './state.ts';
import type { Level, RepoRec } from './types.ts';
import { GhError, notFound } from './util.ts';

/** What a route needs: an App JWT, no auth, any installation token, or a permission at a level. */
export type Need = 'jwt' | 'public' | 'any' | readonly [permission: string, level: Level];

export interface Out {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface Req {
  c: Context;
  auth: AuthCtx;
  state: GitHubState;
  ser: Serializer;
  url: URL;
  param(name: string): string;
  /** The parsed JSON body (`{}` when empty). A malformed body is a 400. */
  body(): Promise<Record<string, unknown>>;
  /** Paged JSON array response with `Link` header. */
  page<T, U>(items: T[], map: (t: T) => U, wrap?: (items: U[], total: number) => unknown): Out;
  repo(): RepoRec;
}

export type Handler = (r: Req) => Out | Promise<Out>;

export const DOC = 'https://docs.github.com/rest';
export const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function errorBody(e: GhError): Record<string, unknown> {
  return {
    message: e.message,
    ...(e.errors ? { errors: e.errors } : {}),
    documentation_url: e.docUrl ?? DOC,
    status: String(e.status),
  };
}

export interface RouterDeps {
  app: Hono;
  state: GitHubState;
  limiter: RateLimiter;
}

let requestCounter = 0;

/**
 * Registers REST routes with the shared pipeline: authentication, permission check, secondary and
 * primary rate limits, error mapping and `x-ratelimit-*` / `x-accepted-github-permissions` headers.
 */
export function createRouter({ app, state, limiter }: RouterDeps) {
  function route(method: string, path: string, need: Need, handler: Handler) {
    const verb = method.toUpperCase();
    app.on(verb, path, async (c) => {
      const base = new URL(c.req.url).origin;
      const headers: Record<string, string> = {
        'x-github-api-version-selected': '2022-11-28',
        'x-github-request-id': `FAKE:${(++requestCounter).toString(16).padStart(8, '0')}`,
      };
      if (Array.isArray(need)) headers['x-accepted-github-permissions'] = `${need[0]}=${need[1]}`;
      let auth: AuthCtx = NO_AUTH;
      let release: (() => void) | undefined;
      let out: Out;
      const generation = state.generation;
      try {
        auth = authenticate(state, c.req.header('authorization'));
        checkNeed(auth, need);
        if (auth.kind !== 'none') {
          release = limiter.begin(auth);
          limiter.checkSecondary(auth, {
            method: verb,
            path: new URL(c.req.url).pathname,
            routeKey: path,
            kind: 'rest',
            mutation: MUTATING.has(verb),
          });
          if (path !== '/rate_limit') limiter.consumePrimary(auth, 'core');
        }
        const req = makeReq(c, auth, state, new Serializer(state, base));
        out = await handler(req);
      } catch (e) {
        if (e instanceof GhError) {
          out = { status: e.status, body: errorBody(e), headers: e.headers };
        } else throw e;
      } finally {
        release?.();
      }
      if (state.generation !== generation)
        out = {
          status: 409,
          body: errorBody(new GhError(409, 'The fake was reset while this request was running')),
        };
      if (auth.kind !== 'none') {
        const info = limiter.peek(auth, 'core');
        Object.assign(headers, rateHeaders(info));
      }
      Object.assign(headers, out.headers);
      const status = out.status ?? (out.body === undefined ? 204 : 200);
      for (const [k, v] of Object.entries(headers)) c.header(k, v);
      if (out.body === undefined || status === 204) return c.body(null, status as 204);
      return c.json(out.body, status as 200);
    });
  }
  return {
    get: (p: string, n: Need, h: Handler) => route('GET', p, n, h),
    post: (p: string, n: Need, h: Handler) => route('POST', p, n, h),
    put: (p: string, n: Need, h: Handler) => route('PUT', p, n, h),
    patch: (p: string, n: Need, h: Handler) => route('PATCH', p, n, h),
    delete: (p: string, n: Need, h: Handler) => route('DELETE', p, n, h),
  };
}

export type Router = ReturnType<typeof createRouter>;

function checkNeed(auth: AuthCtx, need: Need): void {
  if (need === 'public') return;
  if (need === 'jwt') {
    if (auth.kind !== 'jwt') throw new GhError(401, 'A JSON web token could not be decoded');
    return;
  }
  if (auth.kind === 'none') throw new GhError(401, 'Requires authentication');
  if (auth.kind === 'jwt') throw new GhError(403, 'Resource not accessible by integration');
  if (need === 'any') return;
  // Every installation token carries `metadata: read`, which also covers plain repository reads.
  if (!GitHubState.allows(auth.permissions, need[0], need[1]))
    throw new GhError(403, 'Resource not accessible by integration');
}

function makeReq(c: Context, auth: AuthCtx, state: GitHubState, ser: Serializer): Req {
  const url = new URL(c.req.url);
  const req: Req = {
    c,
    auth,
    state,
    ser,
    url,
    param: (name) => c.req.param(name) ?? '',
    async body() {
      const text = await c.req.text();
      if (!text.trim()) return {};
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      } catch {
        // fall through
      }
      throw new GhError(400, 'Problems parsing JSON');
    },
    page(items, map, wrap) {
      const paged = paginate(items, url);
      const mapped = paged.items.map(map);
      return {
        body: wrap ? wrap(mapped, paged.total) : mapped,
        headers: paged.link ? { link: paged.link } : undefined,
      };
    },
    repo() {
      return findRepoFor(req, req.param('owner'), req.param('repo'));
    },
  };
  return req;
}

/**
 * Resolves a repository the caller's installation can see, else 404 (never leaks existence). A
 * public repository of another owner can be read (GET and HEAD) by any installation, as on GitHub.
 */
export function findRepoFor(r: Req, owner: string, name: string): RepoRec {
  const read = r.c.req.method === 'GET' || r.c.req.method === 'HEAD';
  const readable = (repo: RepoRec) =>
    repoVisibleTo(r.auth, repo) ||
    (read && r.auth.installation !== undefined && repo.visibility === 'public');
  const repo = r.state.findRepo(owner, name);
  if (!repo) {
    // A renamed or transferred repository's old name redirects to the new one, as GitHub does: a
    // read gets a 301, anything else a 307, which a client must not follow for a write.
    const moved = r.state.renamedRepos.get(r.state.repoKey(owner, name));
    if (moved && (repoVisibleTo(r.auth, moved) || moved.visibility === 'public')) {
      const from = new RegExp(`/${escapeRegExp(owner)}/${escapeRegExp(name)}(?=/|$)`, 'i');
      const location = new URL(
        r.url.pathname.replace(from, `/${moved.owner}/${moved.name}`),
        r.url,
      );
      location.search = r.url.search;
      throw new GhError(read ? 301 : 307, 'Moved Permanently', {
        headers: { location: location.toString() },
      });
    }
    throw notFound();
  }
  if (!readable(repo)) throw notFound();
  return repo;
}

/** Whether the installation (and the token's repository restriction) covers the repository. */
export function repoVisibleTo(auth: AuthCtx, repo: RepoRec): boolean {
  const inst = auth.installation;
  if (!inst || repo.owner.toLowerCase() !== inst.account.toLowerCase()) return false;
  if (
    inst.repositorySelection === 'selected' &&
    !inst.repositories
      .map((x) => x.toLowerCase())
      .includes(`${repo.owner}/${repo.name}`.toLowerCase())
  )
    return false;
  const ids = auth.token?.repositoryIds;
  return !ids || ids.includes(repo.id);
}

/** The organization of an installation-scoped request; another account's org is a 404. */
export function orgFor(r: Req, login: string) {
  const org = r.state.orgs.get(login.toLowerCase());
  const inst = r.auth.installation;
  if (!org || !inst || inst.account.toLowerCase() !== org.login.toLowerCase()) throw notFound();
  return org;
}

export { PRIMARY_DOC };

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
