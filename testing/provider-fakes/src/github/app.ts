import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { type AuthCtx, authenticate } from './auth.ts';
import type { FakeGitHubOptions, RuntimeConfig } from './config.ts';
import { isMutation, queryCost, runGraphQL } from './graphql.ts';
import { RateLimiter, rateHeaders } from './rate-limit.ts';
import { createRouter, errorBody, repoVisibleTo } from './router.ts';
import { registerAccounts } from './routes/accounts.ts';
import { registerGit } from './routes/git.ts';
import { registerRepos } from './routes/repos.ts';
import { registerScopes } from './routes/scopes.ts';
import { GitHubState } from './state.ts';
import type { Permissions, RepoRec } from './types.ts';
import { GhError, notFound } from './util.ts';

/** One API request the fake served (control plane excluded), for tests that assert what was written. */
export interface GitHubRequestRecord {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  /** False for reads: GET, HEAD, and a GraphQL query (a GraphQL mutation is a write). */
  readonly write: boolean;
}

export interface FakeGitHub {
  /** A Hono app: use `app.request()` without a socket, or `startFakeGitHub` to bind a port. */
  app: Hono;
  state: GitHubState;
  limiter: RateLimiter;
  config: () => RuntimeConfig;
  /** Same as `POST /__reset`. */
  reset(fixture?: string, overrides?: Partial<RuntimeConfig>): Promise<void>;
  /** Every API request served since the last reset or `clearRequests()`, in arrival order. */
  requests(): readonly GitHubRequestRecord[];
  clearRequests(): void;
  /**
   * Re-derives the git policy flag from the current rules (all repositories, or one). Call it after
   * seeding a bare repository for a repository that already has rules (fixtures).
   */
  syncPolicy(repo?: RepoRec): void;
  /** Issues an installation access token directly (no JWT), for tests that do not exercise App auth. */
  token(options?: {
    installationId?: number;
    permissions?: Permissions;
    repositoryIds?: number[];
    ttlMs?: number;
  }): string;
}

const CONFIG_KEYS = [
  'primary',
  'secondary',
  'forced',
  'repositoryDeletion',
  'maxBlobBytes',
  'environmentProtection',
] as const;

function pickConfig(body: Record<string, unknown>): Partial<RuntimeConfig> {
  const out: Record<string, unknown> = {};
  for (const k of CONFIG_KEYS) if (k in body) out[k] = body[k];
  return out as Partial<RuntimeConfig>;
}

export function createFakeGitHub(options: FakeGitHubOptions = {}): FakeGitHub {
  const state = new GitHubState(options);
  const limiter = new RateLimiter(state);
  const app = new Hono();
  const requestLog: GitHubRequestRecord[] = [];
  /** GraphQL requests whose operation is a mutation, by request, for the log. */
  const graphqlMutations = new WeakSet<Request>();
  const fixtures: Record<string, (s: GitHubState) => void | Promise<void>> = {
    empty: () => {},
    ...options.fixtures,
  };

  app.onError((e, c) => {
    if (e instanceof GhError) {
      for (const [k, v] of Object.entries(e.headers)) c.header(k, v);
      return c.json(errorBody(e), e.status as 400);
    }
    return c.json(
      {
        message: `Server Error: ${e instanceof Error ? e.message : String(e)}`,
        documentation_url: 'https://docs.github.com/rest',
        status: '500',
      },
      500,
    );
  });
  app.notFound((c) => c.json(errorBody(notFound()), 404));

  // -- control plane (no auth) ----------------------------------------------------------------------

  // A reset first stops admitting API requests (409), waits for the ones in flight to finish, then
  // wipes the git server and the state, so no request ever writes into the new world (ADR-0075).
  let resetting = false;
  let inflight = 0;
  let idle: (() => void) | undefined;
  let lastReset: Promise<void> = Promise.resolve();
  app.use('*', async (c, next) => {
    if (c.req.path === '/__reset') return next();
    if (resetting)
      return c.json(errorBody(new GhError(409, 'The fake is being reset, try again')), 409);
    if (c.req.path.startsWith('/__')) return next(); // control plane: refused during a reset, not counted
    inflight += 1;
    try {
      await next();
      const method = c.req.method;
      const write =
        method === 'GET' || method === 'HEAD'
          ? false
          : c.req.path === '/graphql'
            ? graphqlMutations.has(c.req.raw)
            : true;
      requestLog.push({ method, path: c.req.path, status: c.res.status, write });
    } finally {
      inflight -= 1;
      if (inflight === 0) idle?.();
    }
  });

  const doReset = async (fixture: string, overrides: Partial<RuntimeConfig>) => {
    const run = fixtures[fixture || 'empty'];
    if (!run)
      throw new GhError(
        400,
        `Unknown fixture "${fixture}". Known: ${Object.keys(fixtures).join(', ')}`,
      );
    resetting = true;
    try {
      if (inflight > 0) {
        // Bounded: a stalled request must not hang the reset (its late result becomes a 409).
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          new Promise<void>((resolve) => {
            idle = resolve;
          }),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, options.resetDrainMs ?? 10_000);
          }),
        ]);
        clearTimeout(timer);
      }
      // The git server must forget the repositories too (ADR-0075), before the records are dropped.
      for (const repo of [...state.repos.values()])
        await state.options.repositoryHooks?.deleted?.(repo);
      state.reset(overrides);
      limiter.clear();
      requestLog.length = 0;
      state.fixture = fixture || 'empty';
      await run(state);
    } finally {
      resetting = false;
      idle = undefined;
    }
  };
  const reset = (fixture = 'empty', overrides: Partial<RuntimeConfig> = {}): Promise<void> => {
    const next = lastReset.then(() => doReset(fixture, overrides));
    lastReset = next.catch(() => {});
    return next;
  };

  const readBody = async (c: {
    req: { text(): Promise<string> };
  }): Promise<Record<string, unknown>> => {
    const text = await c.req.text();
    if (!text.trim()) return {};
    try {
      const v = JSON.parse(text);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch {
      // fall through
    }
    throw new GhError(400, 'Problems parsing JSON');
  };

  app.post('/__reset', async (c) => {
    const body = await readBody(c);
    await reset(typeof body.fixture === 'string' ? body.fixture : 'empty', pickConfig(body));
    return c.json({ fixture: state.fixture });
  });
  app.post('/__config', async (c) => {
    const body = await readBody(c);
    state.config = { ...state.config, ...structuredClone(pickConfig(body)) };
    if (body.clearUsage === true) limiter.clear();
    return c.json({ config: state.config });
  });
  app.get('/__state', (c) => c.json(state.snapshot()));
  app.post('/__token', async (c) => {
    const body = await readBody(c);
    const id =
      (body.installationId as number | undefined) ?? ([...state.installations.keys()][0] as number);
    const { token, rec } = state.issueInstallationToken(id, {
      permissions: body.permissions as Permissions | undefined,
      repositoryIds: body.repositoryIds as number[] | undefined,
      ttlMs: body.ttlSeconds ? Number(body.ttlSeconds) * 1000 : undefined,
    });
    return c.json({ token, expires_at: new Date(rec.expiresAt).toISOString() }, 201);
  });

  // -- REST -----------------------------------------------------------------------------------------

  const router = createRouter({ app, state, limiter });
  registerAccounts(router, state, limiter);
  registerRepos(router, state);
  registerScopes(router, state);
  registerGit(router, state);

  // -- GraphQL --------------------------------------------------------------------------------------

  app.post('/graphql', async (c) => {
    const auth = authenticate(state, c.req.header('authorization'));
    if (auth.kind === 'none') throw new GhError(401, 'Requires authentication');
    if (auth.kind === 'jwt') throw new GhError(403, 'Resource not accessible by integration');
    const text = await c.req.text();
    let body: {
      query?: unknown;
      variables?: Record<string, unknown> | null;
      operationName?: string | null;
    };
    try {
      body = JSON.parse(text);
    } catch {
      throw new GhError(400, 'Problems parsing JSON');
    }
    if (typeof body.query !== 'string')
      throw new GhError(400, 'A query attribute must be specified and must be a string.');
    if (isMutation(body.query, body.operationName)) graphqlMutations.add(c.req.raw);
    const release = limiter.begin(auth);
    try {
      limiter.checkSecondary(auth, {
        method: 'POST',
        path: '/graphql',
        routeKey: '/graphql',
        kind: 'graphql',
        mutation: isMutation(body.query, body.operationName),
      });
      const cost = queryCost(body.query, body.variables);
      const info = limiter.consumePrimary(auth, 'graphql', cost.cost);
      for (const [k, v] of Object.entries(rateHeaders(info))) c.header(k, v);
      const result = await runGraphQL(
        { state, auth, limiter, cost },
        { query: body.query, variables: body.variables, operationName: body.operationName },
      );
      return c.json(result);
    } finally {
      release();
    }
  });

  // -- Git LFS batch API (existence check, provider doc) ---------------------------------------------

  app.post('/:owner/:name{[^/]+\\.git}/info/lfs/objects/batch', async (c) => {
    const auth: AuthCtx = authenticate(state, c.req.header('authorization'));
    const jsonLfs = (body: unknown, status = 200) => {
      c.header('content-type', 'application/vnd.git-lfs+json');
      return c.body(JSON.stringify(body), status as 200);
    };
    if (auth.kind !== 'installation') {
      c.header('www-authenticate', 'Basic realm="GitHub"');
      return jsonLfs({ message: 'Credentials needed' }, 401);
    }
    const name = (c.req.param('name') as string).replace(/\.git$/, '');
    const repo = state.findRepo(c.req.param('owner') as string, name);
    if (!repo || !repoVisibleTo(auth, repo)) return jsonLfs({ message: 'Not Found' }, 404);
    // Same pipeline as REST: secondary and primary limits, x-ratelimit-* headers.
    const release = limiter.begin(auth);
    try {
      limiter.checkSecondary(auth, {
        method: 'POST',
        path: new URL(c.req.url).pathname,
        routeKey: '/:owner/:repo.git/info/lfs/objects/batch',
        kind: 'rest',
        mutation: false,
      });
      for (const [k, v] of Object.entries(rateHeaders(limiter.consumePrimary(auth, 'core'))))
        c.header(k, v);
      const body = (await c.req.json().catch(() => null)) as {
        operation?: string;
        objects?: { oid: string; size: number }[];
      } | null;
      if (
        !body ||
        (body.operation !== 'download' && body.operation !== 'upload') ||
        !Array.isArray(body.objects)
      )
        return jsonLfs({ message: 'Invalid batch request' }, 422);
      const need = body.operation === 'download' ? 'read' : 'write';
      if (!GitHubState.allows(auth.permissions, 'contents', need))
        return jsonLfs({ message: 'Resource not accessible by integration' }, 403);
      if (body.objects.length > 100)
        return jsonLfs({ message: 'Too many objects in the batch request (maximum 100)' }, 413);
      const lookup = options.lfsHas ?? ((r: RepoRec, oid: string) => r.lfs.get(oid));
      const origin = new URL(c.req.url).origin;
      const objects = await Promise.all(
        body.objects.map(async ({ oid, size }) => {
          const stored = await lookup(repo, oid);
          if (body.operation === 'download') {
            if (stored === undefined)
              return { oid, size, error: { code: 404, message: 'Object does not exist' } };
            return {
              oid,
              size: stored,
              authenticated: true,
              actions: {
                download: {
                  href: `${origin}/lfs-objects/${repo.owner}/${repo.name}/${oid}`,
                  header: {},
                  expires_in: 3600,
                },
              },
            };
          }
          if (stored !== undefined) return { oid, size: stored };
          return {
            oid,
            size,
            authenticated: true,
            actions: {
              upload: {
                href: `${origin}/lfs-objects/${repo.owner}/${repo.name}/${oid}?size=${size}`,
                header: {},
                expires_in: 3600,
              },
            },
          };
        }),
      );
      return jsonLfs({ transfer: 'basic', objects, hash_algo: 'sha256' });
    } finally {
      release();
    }
  });

  // Upload target for the `upload` action: authenticated like the batch call (installation auth,
  // repository restriction, Contents: write), the body must hash to the oid and match the announced size.
  app.put('/lfs-objects/:owner/:name/:oid', async (c) => {
    const auth = authenticate(state, c.req.header('authorization'));
    const repo = state.findRepo(c.req.param('owner') as string, c.req.param('name') as string);
    if (auth.kind !== 'installation') throw new GhError(401, 'Credentials needed');
    if (!repo || !repoVisibleTo(auth, repo)) throw notFound();
    if (!GitHubState.allows(auth.permissions, 'contents', 'write'))
      throw new GhError(403, 'Resource not accessible by integration');
    const oid = c.req.param('oid') as string;
    const body = Buffer.from(await c.req.arrayBuffer());
    if (createHash('sha256').update(body).digest('hex') !== oid)
      throw new GhError(422, 'The object content does not match its oid');
    const announced = c.req.query('size');
    if (announced !== undefined && Number(announced) !== body.length)
      throw new GhError(422, 'The object size does not match the size announced in the batch');
    repo.lfs.set(oid, body.length);
    return c.body(null, 200);
  });

  return {
    app,
    state,
    limiter,
    config: () => state.config,
    reset,
    requests: () => [...requestLog],
    clearRequests: () => {
      requestLog.length = 0;
    },
    syncPolicy: (repo) => {
      for (const r of repo ? [repo] : state.repos.values())
        state.options.repositoryHooks?.policyChanged?.(r, r.rules.length > 0);
    },
    token: (o = {}) => {
      const id = o.installationId ?? ([...state.installations.keys()][0] as number);
      return state.issueInstallationToken(id, {
        permissions: o.permissions,
        repositoryIds: o.repositoryIds,
        ttlMs: o.ttlMs,
      }).token;
    },
  };
}
