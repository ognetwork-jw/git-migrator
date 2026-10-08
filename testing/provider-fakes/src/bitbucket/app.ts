import type { Context } from 'hono';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  DEFAULT_PAGE_OPTIONS,
  narrow,
  PageNotFoundError,
  type PageOptions,
  paginate,
} from '../common/paginate.ts';
import { QueryError } from '../common/query.ts';
import { BUILTIN_FIXTURES, type FixtureRegistry } from './fixtures.ts';
import {
  classify,
  LIMIT_CATEGORIES,
  type LimitCategory,
  type LimitConfig,
  RateLimiter,
} from './rate-limit.ts';
import { requiredScopes } from './scopes.ts';
import { Serializer } from './serialize.ts';
import {
  BitbucketState,
  type CredentialInput,
  defaultBranchingModel,
  FIXED_TIME,
} from './state.ts';
import {
  BRANCH_RESTRICTION_KINDS,
  type BranchRestrictionKind,
  type FakeCredential,
  type FakeProject,
  type FakeRepository,
  type FakeUser,
  type FakeWorkspace,
  type GroupsEndpointMode,
} from './types.ts';

/** How `PUT /repositories/{ws}/{slug}` treats fields missing from the body (ADR-0036 item 10). */
export type PutSemantics = 'merge' | 'reset-omitted';

/** Settings that tests may flip at runtime (`POST /__config`) or on reset. */
export interface RuntimeConfig {
  /** `/1.0/groups` is not in the published API reference; make it absent (404) or gone (410). */
  groupsEndpoint: GroupsEndpointMode;
  putSemantics: PutSemantics;
  pageOptions: PageOptions;
}

export interface FakeBitbucketOptions {
  /** Basic-auth credentials. Default: one dummy `operator@test.local` credential. */
  credentials?: CredentialInput[];
  limits?: Partial<LimitConfig>;
  groupsEndpoint?: GroupsEndpointMode;
  putSemantics?: PutSemantics;
  pageOptions?: Partial<PageOptions>;
  /** Clock for the rate limiter (ms). Tests inject a fake one. */
  now?: () => number;
  /** Base of `links.html`. */
  webBaseUrl?: string;
  /** Base of `links.clone`, the git http-backend server of T-040 (port 4030 by default). */
  gitBaseUrl?: string;
  /** Extra fixtures by name (T-043 registers `world`). */
  fixtures?: FixtureRegistry;
}

export interface FakeBitbucket {
  app: Hono;
  state: BitbucketState;
  limiter: RateLimiter;
  config: RuntimeConfig;
  /**
   * Same as `POST /__reset`. Throws on an unknown fixture name. Returns a promise only when the
   * fixture builder is async; resets requested meanwhile queue behind it.
   */
  reset(fixture?: string, overrides?: ResetOverrides): void | Promise<void>;
}

export interface ResetOverrides {
  limits?: Partial<LimitConfig>;
  groupsEndpoint?: GroupsEndpointMode;
  putSemantics?: PutSemantics;
}

class HttpError extends Error {
  readonly status: ContentfulStatusCode;

  constructor(status: ContentfulStatusCode, message: string) {
    super(message);
    this.status = status;
  }
}

const notFound = (what: string) => new HttpError(404, what);

function errorBody(message: string) {
  return { type: 'error', error: { message } };
}

const PERM_RANK = { none: 0, read: 1, write: 2, 'create-repo': 2, admin: 3 } as const;
type Rank = keyof typeof PERM_RANK;
const maxPerm = (a: Rank, b: Rank): Rank => (PERM_RANK[b] > PERM_RANK[a] ? b : a);

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

type Body = Record<string, unknown>;

async function jsonBody(c: Context): Promise<Body> {
  try {
    const v = await c.req.json();
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Body;
  } catch {
    // fall through
  }
  throw new HttpError(400, 'Invalid JSON body');
}

export function createFakeBitbucket(options: FakeBitbucketOptions = {}): FakeBitbucket {
  const fixtures: FixtureRegistry = { ...BUILTIN_FIXTURES, ...(options.fixtures ?? {}) };
  const state = new BitbucketState(options.credentials ?? []);
  const limiter = new RateLimiter(options.limits, options.now);
  const defaults = (): RuntimeConfig => ({
    groupsEndpoint: options.groupsEndpoint ?? 'enabled',
    putSemantics: options.putSemantics ?? 'merge',
    pageOptions: { ...DEFAULT_PAGE_OPTIONS, ...(options.pageOptions ?? {}) },
  });
  const config: RuntimeConfig = defaults();
  const webBase = options.webBaseUrl ?? 'https://bitbucket.org';
  const gitBase = options.gitBaseUrl ?? 'http://localhost:4030';

  /** Set while an async fixture builder runs (ADR-0130). */
  let pendingReset: Promise<void> | undefined;
  /** True from the start of a reset until its builder succeeded: a failed builder leaves half a world. */
  let incomplete = false;

  const fake: FakeBitbucket = {
    app: new Hono(),
    state,
    limiter,
    config,
    reset(fixture = 'empty', overrides = {}) {
      const name = fixture === '' ? 'empty' : fixture;
      const build = fixtures[name];
      if (!build) {
        throw new HttpError(
          400,
          `Unknown fixture '${name}'. Known: ${Object.keys(fixtures).join(', ')}`,
        );
      }
      // An async builder is still running: queue behind it instead of resetting state under it.
      if (pendingReset) {
        const run = () => fake.reset(fixture, overrides);
        return pendingReset.then(run, run);
      }
      Object.assign(config, defaults());
      if (overrides.groupsEndpoint) config.groupsEndpoint = overrides.groupsEndpoint;
      if (overrides.putSemantics) config.putSemantics = overrides.putSemantics;
      limiter.reset({ ...(options.limits ?? {}), ...(overrides.limits ?? {}) });
      state.reset(name);
      incomplete = true;
      const built = build(state);
      if (!built) {
        incomplete = false;
        return;
      }
      const done: Promise<void> = built.then(
        () => {
          incomplete = false;
          if (pendingReset === done) pendingReset = undefined;
        },
        (error) => {
          if (pendingReset === done) pendingReset = undefined;
          throw error;
        },
      );
      pendingReset = done;
      return done;
    },
  };

  const app = fake.app;

  app.onError((e, c) => {
    if (e instanceof HttpError) return c.json(errorBody(e.message), e.status);
    if (e instanceof QueryError) return c.json(errorBody(e.message), 400);
    if (e instanceof PageNotFoundError) return c.json(errorBody(e.message), 404);
    return c.json(errorBody(e instanceof Error ? e.message : 'Internal error'), 500);
  });
  // While an async fixture builds the world, the REST API would show half a world.
  app.use('*', async (c, next) => {
    if (incomplete && !c.req.path.startsWith('/__')) {
      return c.json(errorBody('The fake is being reset, try again'), 503);
    }
    return next();
  });
  app.notFound((c) => c.json(errorBody(`No such resource: ${c.req.method} ${c.req.path}`), 404));

  // ---- control plane (no auth) --------------------------------------------------------------

  app.post('/__reset', async (c) => {
    const text = await c.req.text();
    let body: Body = {};
    if (text.trim()) {
      try {
        body = JSON.parse(text) as Body;
      } catch {
        throw new HttpError(400, 'Invalid JSON body');
      }
    }
    const fixture = typeof body.fixture === 'string' ? body.fixture : 'empty';
    await fake.reset(fixture, toOverrides(body));
    return c.json({ ok: true, fixture });
  });

  app.post('/__config', async (c) => {
    const body = await jsonBody(c);
    const o = toOverrides(body);
    if (o.groupsEndpoint) config.groupsEndpoint = o.groupsEndpoint;
    if (o.putSemantics) config.putSemantics = o.putSemantics;
    if (o.limits) limiter.configure(o.limits);
    if (body.clearUsage === true) limiter.clearUsage();
    return c.json({ ok: true, config, limits: limiter.snapshot() });
  });

  app.get('/__state', (c) =>
    incomplete
      ? c.json(errorBody('The fake is being reset, try again'), 503)
      : c.json({
          fixture: state.data.fixture,
          config,
          limits: limiter.snapshot(),
          state: state.snapshot(),
        }),
  );

  // A `src` path is a file download (raw-files) unless it names a directory of the tree.
  const isSrcDirectory = (path: string): boolean => {
    const m = /^\/2\.0\/repositories\/([^/]+)\/([^/]+)\/src\/[^/]+\/(.+)$/.exec(path);
    const repo = m ? state.repository(m[1] as string, m[2] as string) : undefined;
    if (!m || !repo) return false;
    const rest = (m[3] as string).split('/').map(decodeURIComponent).join('/');
    return !(rest in repo.files) && Object.keys(repo.files).some((f) => f.startsWith(`${rest}/`));
  };

  // ---- auth + rate limit --------------------------------------------------------------------

  type Env = { Variables: { user: FakeUser } };
  const api = new Hono<Env>();

  api.use('*', async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const m = /^Basic\s+(.+)$/i.exec(header);
    let cred: FakeCredential | undefined;
    if (m) {
      const decoded = Buffer.from(m[1] as string, 'base64').toString('utf8');
      const i = decoded.indexOf(':');
      if (i > 0) {
        const email = decoded.slice(0, i);
        const token = decoded.slice(i + 1);
        cred = state.data.credentials.find((x) => x.email === email && x.token === token);
      }
    }
    const user = cred ? state.user(cred.accountId) : undefined;
    if (!cred || !user) {
      return c.json(errorBody('Bad credentials'), 401, {
        'WWW-Authenticate': 'Basic realm="Bitbucket.org HTTP"',
      });
    }
    c.set('user', user);
    if (!limiter.consume(user.accountId, classify(c.req.method, c.req.path, isSrcDirectory))) {
      return c.json(errorBody('Rate limit for this resource has been exceeded'), 429);
    }
    // Scopes: the matched route (not the middleware) decides what is required.
    const matched = c.req.matchedRoutes
      .filter((r) => r.method === c.req.method && r.path !== '*')
      .pop();
    const required = matched ? requiredScopes(c.req.method, matched.path) : [];
    if (cred.scopes) {
      const missing = required.filter((s) => !(cred.scopes as string[]).includes(s));
      if (missing.length > 0) {
        return c.json(
          {
            type: 'error',
            error: {
              message: 'Your credentials lack one or more required privilege scopes.',
              detail: { granted: cred.scopes, required },
            },
          },
          403,
        );
      }
    }
    await next();
  });

  // ---- helpers ------------------------------------------------------------------------------

  const ser = (c: Context) => {
    const origin = new URL(c.req.url).origin;
    return new Serializer(state, { apiBase: `${origin}/2.0`, webBase, gitBase });
  };
  const getWs = (c: Context): FakeWorkspace => {
    const slug = c.req.param('ws') ?? '';
    const ws = state.workspace(slug);
    if (!ws) throw notFound(`No workspace with identifier '${slug}'.`);
    const user = c.get('user') as FakeUser;
    if (!ws.members.includes(user.accountId)) {
      throw new HttpError(403, `You do not have access to workspace '${slug}'.`);
    }
    return ws;
  };
  const getRepo = (c: Context): { ws: FakeWorkspace; repo: FakeRepository } => {
    const ws = getWs(c);
    const slug = c.req.param('slug') ?? '';
    const repo = ws.repositories.find((r) => r.slug === slug);
    if (!repo) throw notFound(`${ws.slug}/${slug} not found`);
    return { ws, repo };
  };
  const getProject = (c: Context): { ws: FakeWorkspace; project: FakeProject } => {
    const ws = getWs(c);
    const key = c.req.param('key') ?? '';
    const project = ws.projects.find((p) => p.key === key);
    if (!project) throw notFound(`No project with key '${key}'.`);
    return { ws, project };
  };
  const list = (
    c: Context,
    items: unknown[],
    opts?: { filterable?: boolean; envelope?: 'full' | 'minimal' },
  ) => {
    const page = paginate(c.req.url, items, config.pageOptions, opts);
    return c.json(narrow(c.req.url, page) as object);
  };
  const one = (c: Context, body: unknown, status: ContentfulStatusCode = 200) =>
    c.json(narrow(c.req.url, body) as object, status);

  // ---- /2.0 ---------------------------------------------------------------------------------

  api.get('/2.0/user', (c) => one(c, ser(c).account(c.get('user'))));

  api.get('/2.0/workspaces/:ws/projects', (c) => {
    const ws = getWs(c);
    const s = ser(c);
    return list(
      c,
      ws.projects.map((p) => s.project(ws, p)),
    );
  });

  api.get('/2.0/workspaces/:ws/members', (c) => {
    const ws = getWs(c);
    const s = ser(c);
    return list(
      c,
      ws.members.map((id) => ({
        type: 'workspace_membership',
        user: s.accountById(id),
        workspace: s.workspaceRef(ws),
        links: {},
      })),
    );
  });

  api.get('/1.0/groups/:ws', (c) => {
    if (config.groupsEndpoint === 'not-found') throw notFound('Not found');
    if (config.groupsEndpoint === 'gone') throw new HttpError(410, 'Gone');
    const ws = getWs(c);
    const s = ser(c);
    return c.json(ws.groups.map((g) => s.legacyGroup(ws, g)));
  });

  api.get('/2.0/workspaces/:ws/hooks', (c) => {
    const ws = getWs(c);
    const s = ser(c);
    const subject = s.workspaceRef(ws);
    return list(
      c,
      ws.webhooks.map((h) => s.webhook(subject, h, 'workspace')),
      { envelope: 'minimal' },
    );
  });

  api.get('/2.0/workspaces/:ws/pipelines-config/variables', (c) => {
    const ws = getWs(c);
    const s = ser(c);
    return list(
      c,
      ws.variables.map((v) => s.variable(v, 'pipeline_variable')),
    );
  });

  api.get('/2.0/workspaces/:ws/projects/:key/permissions-config/users', (c) => {
    const { ws, project } = getProject(c);
    const s = ser(c);
    return list(
      c,
      project.userPermissions.map((g) => ({
        type: 'project_user_permission',
        permission: g.permission,
        user: s.accountById(g.accountId),
        project: s.project(ws, project),
        links: {},
      })),
    );
  });

  api.get('/2.0/workspaces/:ws/projects/:key/permissions-config/groups', (c) => {
    const { ws, project } = getProject(c);
    const s = ser(c);
    return list(
      c,
      project.groupPermissions.map((g) => ({
        type: 'project_group_permission',
        permission: g.permission,
        group: s.groupBySlug(ws, g.slug),
        project: s.project(ws, project),
        links: {},
      })),
    );
  });

  api.get('/2.0/workspaces/:ws/projects/:key/deploy-keys', (c) => {
    const { ws, project } = getProject(c);
    const s = ser(c);
    return list(
      c,
      project.deployKeys.map((k) => s.projectDeployKey(ws, project, k)),
    );
  });

  api.get('/2.0/workspaces/:ws/projects/:key/branching-model/settings', (c) => {
    const { ws, project } = getProject(c);
    return one(
      c,
      ser(c).branchingModelSettings(
        project.branchingModel,
        null,
        `${new URL(c.req.url).origin}/2.0/workspaces/${ws.slug}/projects/${project.key}/branching-model/settings`,
      ),
    );
  });

  api.get('/2.0/workspaces/:ws/permissions/repositories/:slug', (c) => {
    const { ws, repo } = getRepo(c);
    const s = ser(c);
    const project = ws.projects.find((p) => p.key === repo.projectKey);
    const perms = new Map<string, Rank>();
    const raise = (id: string, p: Rank) => perms.set(id, maxPerm(perms.get(id) ?? 'none', p));
    for (const id of ws.admins) raise(id, 'admin');
    for (const g of ws.groups) {
      // Workspace-wide default permission of a group, plus every grant on the project and the
      // repository: the highest one wins.
      const grants: Rank[] = [
        g.defaultPermission,
        ...repo.groupPermissions.filter((x) => x.slug === g.slug).map((x) => x.permission),
        ...(project?.groupPermissions.filter((x) => x.slug === g.slug).map((x) => x.permission) ??
          []),
      ];
      for (const id of g.members) for (const grant of grants) raise(id, grant);
    }
    for (const u of project?.userPermissions ?? []) raise(u.accountId, u.permission);
    for (const u of repo.userPermissions) raise(u.accountId, u.permission);
    const rows = [...perms]
      .filter(([, p]) => p !== 'none')
      .map(([id, p]) => ({
        type: 'repository_permission',
        permission: p === 'create-repo' ? 'write' : p,
        user: s.accountById(id),
        repository: s.repositoryRef(ws, repo),
      }));
    return list(c, rows, { filterable: true });
  });

  // ---- repositories -------------------------------------------------------------------------

  api.get('/2.0/repositories/:ws', (c) => {
    const ws = getWs(c);
    const s = ser(c);
    return list(
      c,
      ws.repositories.map((r) => s.repository(ws, r)),
      { filterable: true },
    );
  });

  api.get('/2.0/repositories/:ws/:slug', (c) => {
    const { ws, repo } = getRepo(c);
    return one(c, ser(c).repository(ws, repo));
  });

  api.put('/2.0/repositories/:ws/:slug', async (c) => {
    const ws = getWs(c);
    const slug = c.req.param('slug') ?? '';
    const body = await jsonBody(c);
    const existing = ws.repositories.find((r) => r.slug === slug);
    if (!existing && slug !== slugify(slug)) {
      throw new HttpError(400, `'${slug}' is not a valid repository slug`);
    }
    let renamedSlug: string | undefined;
    if (existing && typeof body.name === 'string' && body.name !== existing.name) {
      // Changing the name changes the slug and the location of the repository.
      renamedSlug = slugify(body.name);
      if (!renamedSlug) throw new HttpError(400, `'${body.name}' is not a valid repository name`);
      if (renamedSlug !== existing.slug && ws.repositories.some((r) => r.slug === renamedSlug)) {
        throw new HttpError(409, `A repository with slug '${renamedSlug}' already exists`);
      }
    }
    const projectKeyOf = (b: Body): string | undefined => {
      const p = b.project;
      return p && typeof p === 'object' ? ((p as Body).key as string | undefined) : undefined;
    };
    const mainOf = (b: Body): string | null | undefined => {
      if (!('mainbranch' in b)) return undefined;
      const m = b.mainbranch;
      return m && typeof m === 'object' ? ((m as Body).name as string) : null;
    };
    const fork = body.fork_policy;
    if (
      fork !== undefined &&
      !['allow_forks', 'no_public_forks', 'no_forks'].includes(String(fork))
    ) {
      throw new HttpError(400, `Invalid fork_policy '${String(fork)}'`);
    }
    const projectKey = projectKeyOf(body);
    if (projectKey && !ws.projects.some((p) => p.key === projectKey)) {
      throw new HttpError(400, `No project with key '${projectKey}'.`);
    }

    if (!existing) {
      // The real API treats PUT on a missing slug as create (provider doc, Quirks).
      const key = projectKey ?? ws.projects[0]?.key;
      if (!key) throw new HttpError(400, 'A project is required to create a repository.');
      const main = mainOf(body);
      const repo = state.addRepository(ws.slug, {
        slug,
        name: typeof body.name === 'string' ? body.name : slug,
        projectKey: key,
        description: typeof body.description === 'string' ? body.description : '',
        isPrivate: typeof body.is_private === 'boolean' ? body.is_private : true,
        forkPolicy: (fork as FakeRepository['forkPolicy'] | undefined) ?? 'no_public_forks',
        hasIssues: body.has_issues === true,
        hasWiki: body.has_wiki === true,
        language: typeof body.language === 'string' ? body.language : '',
        mainbranch: main ?? null,
        branches: [],
        branchingModel: defaultBranchingModel(),
      });
      return c.json(ser(c).repository(ws, repo), 201, {
        Location: `${new URL(c.req.url).origin}/2.0/repositories/${ws.slug}/${slug}`,
      });
    }

    const reset = config.putSemantics === 'reset-omitted';
    const has = (k: string) => k in body;
    if (typeof body.description === 'string') existing.description = body.description;
    else if (reset) existing.description = '';
    if (typeof body.is_private === 'boolean') existing.isPrivate = body.is_private;
    else if (reset) existing.isPrivate = true;
    if (fork !== undefined) existing.forkPolicy = fork as FakeRepository['forkPolicy'];
    else if (reset) existing.forkPolicy = 'no_public_forks';
    if (typeof body.has_issues === 'boolean') existing.hasIssues = body.has_issues;
    if (typeof body.has_wiki === 'boolean') existing.hasWiki = body.has_wiki;
    if (typeof body.language === 'string') existing.language = body.language;
    if (projectKey) existing.projectKey = projectKey;
    else if (reset) existing.projectKey = ws.projects[0]?.key ?? existing.projectKey;
    const main = mainOf(body);
    if (main !== undefined) existing.mainbranch = main;
    else if (reset && !has('mainbranch')) existing.mainbranch = null;
    if (renamedSlug !== undefined) {
      existing.name = body.name as string;
      existing.slug = renamedSlug;
    }
    existing.updatedOn = FIXED_TIME;
    return c.json(ser(c).repository(ws, existing), 200);
  });

  api.get('/2.0/repositories/:ws/:slug/permissions-config/users', (c) => {
    const { ws, repo } = getRepo(c);
    const s = ser(c);
    return list(
      c,
      repo.userPermissions.map((g) => ({
        type: 'repository_user_permission',
        permission: g.permission,
        user: s.accountById(g.accountId),
        repository: s.repositoryRef(ws, repo),
        links: {},
      })),
    );
  });

  api.get('/2.0/repositories/:ws/:slug/permissions-config/groups', (c) => {
    const { ws, repo } = getRepo(c);
    const s = ser(c);
    return list(
      c,
      repo.groupPermissions.map((g) => ({
        type: 'repository_group_permission',
        permission: g.permission,
        group: s.groupBySlug(ws, g.slug),
        repository: s.repositoryRef(ws, repo),
        links: {},
      })),
    );
  });

  // Branch restrictions: GET list (kind, pattern filters), GET one, POST, DELETE.
  api.get('/2.0/repositories/:ws/:slug/branch-restrictions', (c) => {
    const { ws, repo } = getRepo(c);
    const kind = c.req.query('kind');
    const pattern = c.req.query('pattern');
    const s = ser(c);
    return list(
      c,
      repo.branchRestrictions
        .filter(
          (r) => (!kind || r.kind === kind) && (pattern === undefined || r.pattern === pattern),
        )
        .map((r) => s.branchRestriction(ws, repo, r)),
    );
  });

  api.post('/2.0/repositories/:ws/:slug/branch-restrictions', async (c) => {
    const { ws, repo } = getRepo(c);
    const body = await jsonBody(c);
    const kind = body.kind as BranchRestrictionKind;
    if (!BRANCH_RESTRICTION_KINDS.includes(kind))
      throw new HttpError(400, `Invalid kind '${String(kind)}'`);
    const matchKind = (body.branch_match_kind ?? 'glob') as string;
    if (matchKind !== 'glob' && matchKind !== 'branching_model') {
      throw new HttpError(400, `Invalid branch_match_kind '${matchKind}'`);
    }
    if (matchKind === 'glob' && typeof body.pattern !== 'string') {
      throw new HttpError(400, 'pattern is required for glob restrictions');
    }
    const refs = (v: unknown, what: string): Body[] => {
      if (v === undefined) return [];
      if (!Array.isArray(v) || v.some((x) => !x || typeof x !== 'object' || Array.isArray(x))) {
        throw new HttpError(400, `${what} must be an array of objects`);
      }
      return v as Body[];
    };
    const branchType = body.branch_type;
    if (
      branchType !== undefined &&
      !['feature', 'bugfix', 'release', 'hotfix', 'development', 'production'].includes(
        String(branchType),
      )
    ) {
      throw new HttpError(400, `Invalid branch_type '${String(branchType)}'`);
    }
    if (matchKind === 'branching_model' && branchType === undefined) {
      throw new HttpError(400, 'branch_type is required for branching_model restrictions');
    }
    if (
      kind === 'require_commits_behind' &&
      (typeof body.value !== 'number' || !Number.isInteger(body.value) || body.value < 0)
    ) {
      throw new HttpError(
        400,
        'value (maximum commits behind) is required for require_commits_behind',
      );
    }
    if (body.value !== undefined && body.value !== null && typeof body.value !== 'number') {
      throw new HttpError(400, 'value must be a number');
    }
    const pattern = typeof body.pattern === 'string' ? body.pattern : '';
    if (
      repo.branchRestrictions.some(
        (x) =>
          x.kind === kind &&
          x.pattern === pattern &&
          x.branchMatchKind === matchKind &&
          x.branchType === branchType,
      )
    ) {
      throw new HttpError(400, `A ${kind} restriction for '${pattern}' already exists`);
    }
    const users = refs(body.users, 'users').map((u) => {
      const found = state.data.users.find(
        (x) => x.uuid === u.uuid || x.accountId === u.account_id || x.nickname === u.nickname,
      );
      if (!found) throw new HttpError(400, 'Unknown user in restriction');
      return found.accountId;
    });
    const groups = refs(body.groups, 'groups').map((g) => {
      const found = ws.groups.find((x) => x.slug === g.slug || x.name === g.name);
      if (!found) throw new HttpError(400, 'Unknown group in restriction');
      return found.slug;
    });
    const r = state.addBranchRestriction(ws.slug, repo.slug, {
      kind,
      pattern,
      branchMatchKind: matchKind,
      ...(typeof body.branch_type === 'string'
        ? { branchType: body.branch_type as 'feature' }
        : {}),
      ...(body.value !== undefined ? { value: body.value as number | null } : {}),
      users,
      groups,
    });
    return c.json(ser(c).branchRestriction(ws, repo, r), 201);
  });

  const findRestriction = (c: Context) => {
    const { ws, repo } = getRepo(c);
    const id = Number(c.req.param('id'));
    const r = repo.branchRestrictions.find((x) => x.id === id);
    if (!r) throw notFound(`No branch restriction ${c.req.param('id')}`);
    return { ws, repo, r };
  };

  api.get('/2.0/repositories/:ws/:slug/branch-restrictions/:id', (c) => {
    const { ws, repo, r } = findRestriction(c);
    return one(c, ser(c).branchRestriction(ws, repo, r));
  });

  api.delete('/2.0/repositories/:ws/:slug/branch-restrictions/:id', (c) => {
    const { repo, r } = findRestriction(c);
    repo.branchRestrictions = repo.branchRestrictions.filter((x) => x !== r);
    return c.body(null, 204);
  });

  api.get('/2.0/repositories/:ws/:slug/effective-branching-model', (c) => {
    const { repo } = getRepo(c);
    return one(c, ser(c).effectiveBranchingModel(repo));
  });

  api.get('/2.0/repositories/:ws/:slug/branching-model/settings', (c) => {
    const { ws, repo } = getRepo(c);
    return one(
      c,
      ser(c).branchingModelSettings(
        repo.branchingModel,
        repo.mainbranch,
        `${new URL(c.req.url).origin}/2.0/repositories/${ws.slug}/${repo.slug}/branching-model/settings`,
      ),
    );
  });

  api.get('/2.0/repositories/:ws/:slug/effective-default-reviewers', (c) => {
    const { repo } = getRepo(c);
    const s = ser(c);
    return list(
      c,
      repo.defaultReviewers.flatMap((r) => {
        const u = state.user(r.accountId);
        return u ? [s.defaultReviewer(r.reviewerType, u)] : [];
      }),
    );
  });

  api.get('/2.0/repositories/:ws/:slug/refs/branches/:name', (c) => {
    const { repo } = getRepo(c);
    const name = c.req.param('name') ?? '';
    const b = repo.branches.find((x) => x.name === name);
    if (!b) throw notFound(`Branch '${name}' not found`);
    return one(c, ser(c).branch(b));
  });

  api.get('/2.0/repositories/:ws/:slug/hooks', (c) => {
    const { ws, repo } = getRepo(c);
    const s = ser(c);
    const subject = s.repositoryRef(ws, repo);
    return list(
      c,
      repo.webhooks.map((h) => s.webhook(subject, h, 'repository')),
      { envelope: 'minimal' },
    );
  });

  api.get('/2.0/repositories/:ws/:slug/deploy-keys', (c) => {
    const { ws, repo } = getRepo(c);
    const s = ser(c);
    return list(
      c,
      repo.deployKeys.map((k) => s.deployKey(ws, repo, k)),
    );
  });

  api.get('/2.0/repositories/:ws/:slug/pipelines_config', (c) => {
    const { ws, repo } = getRepo(c);
    return one(c, {
      type: 'pipelines_config',
      enabled: repo.pipelinesEnabled,
      repository: ser(c).repositoryRef(ws, repo),
    });
  });

  api.get('/2.0/repositories/:ws/:slug/pipelines_config/variables', (c) => {
    const { repo } = getRepo(c);
    const s = ser(c);
    return list(
      c,
      repo.variables.map((v) => s.variable(v, 'pipeline_variable')),
    );
  });

  api.get('/2.0/repositories/:ws/:slug/environments', (c) => {
    const { repo } = getRepo(c);
    const s = ser(c);
    return list(
      c,
      repo.environments.map((e) => s.environment(e)),
    );
  });

  api.get('/2.0/repositories/:ws/:slug/deployments_config/environments/:env/variables', (c) => {
    const { repo } = getRepo(c);
    const uuid = c.req.param('env') ?? '';
    const env = repo.environments.find((e) => e.uuid === uuid);
    if (!env) throw notFound(`No environment ${uuid}`);
    const s = ser(c);
    return list(
      c,
      env.variables.map((v) => s.variable(v, 'deployment_variable')),
    );
  });

  api.get('/2.0/repositories/:ws/:slug/pullrequests', (c) => {
    const { ws, repo } = getRepo(c);
    const states = new URL(c.req.url).searchParams.getAll('state');
    for (const st of states) {
      if (!['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED'].includes(st)) {
        throw new HttpError(400, `Invalid state '${st}'`);
      }
    }
    const wanted = states.length > 0 ? states : ['OPEN'];
    const s = ser(c);
    return list(
      c,
      repo.pullRequests
        .filter((p) => wanted.includes(p.state))
        .map((p) => s.pullRequest(ws, repo, p)),
    );
  });

  api.get('/2.0/repositories/:ws/:slug/issues', (c) => {
    const { repo } = getRepo(c);
    if (!repo.hasIssues) throw notFound('Repository has no issue tracker.');
    const items = Array.from({ length: repo.issueCount }, (_, i) => ({
      type: 'issue',
      id: i + 1,
      title: `Issue ${i + 1}`,
    }));
    return list(c, items);
  });

  api.get('/2.0/repositories/:ws/:slug/downloads', (c) => {
    const { repo } = getRepo(c);
    const items = Array.from({ length: repo.downloadCount }, (_, i) => ({
      type: 'download',
      name: `download-${i + 1}.zip`,
      size: 1024,
    }));
    return list(c, items);
  });

  // Source: `src/{commit}/{path}`. A missing path or ref is 404 (a missing pipelines file is
  // the expected "none" signal). File data comes from the in-memory tree for now (the seam to the
  // git server of T-040).
  const serveSrc = (c: Context) => {
    const { ws, repo } = getRepo(c);
    const ref = c.req.param('commit') ?? '';
    const known =
      repo.mainbranch !== null &&
      (ref === 'HEAD' || repo.branches.some((b) => b.name === ref || b.hash === ref));
    if (!known) throw notFound(`Commit '${ref}' not found`);
    const prefix = `/2.0/repositories/${ws.slug}/${repo.slug}/src/`;
    const raw = c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : '';
    const rest = raw.split('/').slice(1).map(decodeURIComponent).join('/').replace(/\/+$/, '');
    if (rest !== '' && rest in repo.files) {
      return c.body(repo.files[rest] as string, 200, {
        'Content-Type': 'text/plain; charset=utf-8',
      });
    }
    const dirPrefix = rest === '' ? '' : `${rest}/`;
    const children = new Map<string, 'commit_file' | 'commit_directory'>();
    for (const p of Object.keys(repo.files)) {
      if (!p.startsWith(dirPrefix)) continue;
      const [head, ...tail] = p.slice(dirPrefix.length).split('/');
      children.set(`${dirPrefix}${head}`, tail.length > 0 ? 'commit_directory' : 'commit_file');
    }
    if (children.size === 0 && rest !== '') throw notFound(`No such file or directory: ${rest}`);
    const s = ser(c);
    const commit = repo.branches.find((b) => b.name === ref || b.hash === ref) ?? repo.branches[0];
    const hash = commit?.hash ?? '';
    return list(
      c,
      [...children].map(([path, type]) => ({
        type,
        path,
        commit: s.commitRef(hash),
        ...(type === 'commit_file' ? { size: (repo.files[path] ?? '').length } : {}),
      })),
      { filterable: true },
    );
  };
  api.get('/2.0/repositories/:ws/:slug/src/:commit', serveSrc);
  api.get('/2.0/repositories/:ws/:slug/src/:commit/*', serveSrc);

  app.route('/', api);
  return fake;
}

function toOverrides(body: Body): ResetOverrides {
  const out: ResetOverrides = {};
  const g = body.groupsEndpoint;
  if (g !== undefined) {
    if (g !== 'enabled' && g !== 'not-found' && g !== 'gone')
      throw new HttpError(400, `Invalid groupsEndpoint '${String(g)}'`);
    out.groupsEndpoint = g;
  }
  const p = body.putSemantics;
  if (p !== undefined) {
    if (p !== 'merge' && p !== 'reset-omitted')
      throw new HttpError(400, `Invalid putSemantics '${String(p)}'`);
    out.putSemantics = p;
  }
  const l = body.limits;
  if (l !== undefined) {
    if (!l || typeof l !== 'object') throw new HttpError(400, 'limits must be an object');
    const { windowMs, ...cats } = l as Record<string, unknown>;
    const limits: LimitConfig['limits'] = {};
    for (const [k, v] of Object.entries(cats)) {
      if (!(LIMIT_CATEGORIES as readonly string[]).includes(k))
        throw new HttpError(400, `Unknown limit category '${k}'`);
      if (v !== null && (typeof v !== 'number' || v < 0))
        throw new HttpError(400, `Invalid limit for '${k}'`);
      limits[k as LimitCategory] = v as number | null;
    }
    if (
      windowMs !== undefined &&
      (typeof windowMs !== 'number' || !Number.isFinite(windowMs) || windowMs <= 0)
    ) {
      throw new HttpError(400, 'windowMs must be a positive finite number');
    }
    out.limits = { limits, ...(windowMs !== undefined ? { windowMs: windowMs as number } : {}) };
  }
  return out;
}
