import { type E2eContext, LIVE_FIXTURE } from './context.ts';
import type { ApiResult, BitbucketApi, GithubApi } from './ports.ts';
import { REQUIRED_APP_PERMISSIONS } from './preconditions.ts';

/** A context with made-up accounts, for tests (no secret is real). */
export const TEST_CONTEXT: E2eContext = {
  target: 'live',
  fixture: LIVE_FIXTURE,
  bitbucket: {
    baseUrl: 'https://api.bitbucket.example',
    endpointId: 'bb-e2e',
    workspace: 'gm-e2e',
    accountId: 'acct-1',
    email: 'admin@example.com',
    apiToken: 'not-a-real-token',
  },
  github: {
    baseUrl: 'https://api.github.example',
    org: 'gm-e2e-org',
    appId: 7,
    installationId: 9,
    privateKey: 'not-a-real-key',
  },
  operatorEmail: 'operator@test.local',
};

const ok = (json: unknown, status = 200): ApiResult => ({ status, json });
const page = (values: unknown[]): ApiResult => ok({ values });

export interface MemoryState {
  userAccountId: string;
  workspacePermission: string;
  repo: Record<string, unknown> | undefined;
  branches: string[];
  tags: string[];
  files: Set<string>;
  restrictions: Array<Record<string, unknown>>;
  keys: Array<Record<string, unknown>>;
  variables: Array<Record<string, unknown>>;
  hooks: unknown[];
  pullRequests: unknown[];
  userPermissions: unknown[];
  groupPermissions: unknown[];
  installation: Record<string, unknown>;
  org: Record<string, unknown>;
  githubRepos: Map<string, Record<string, unknown>>;
  /** Status to answer with for any path that contains the text (simulates an outage). */
  failing: Map<string, number>;
  calls: string[];
}

/** In-memory Bitbucket and GitHub that satisfy every precondition by default. */
export function memoryProviders(ctx: E2eContext = TEST_CONTEXT): {
  state: MemoryState;
  bitbucket: BitbucketApi;
  github: GithubApi;
} {
  const f = ctx.fixture;
  const state: MemoryState = {
    userAccountId: ctx.bitbucket.accountId,
    workspacePermission: 'owner',
    repo: {
      slug: f.slug,
      project: { key: f.projectKey },
      is_private: true,
      description: f.description,
      website: f.website,
      fork_policy: 'no_public_forks',
      mainbranch: { name: 'main' },
    },
    branches: [...f.branches],
    tags: [...f.tags],
    files: new Set(['.gitattributes', 'assets/sample.bin']),
    restrictions: [
      { id: 1, kind: 'force', pattern: 'main', users: [], groups: [] },
      { id: 2, kind: 'delete', pattern: 'main', users: [], groups: [] },
    ],
    keys: [{ label: f.deployKeyTitle }],
    variables: [{ key: f.variable.name, value: f.variable.value, secured: false }],
    hooks: [],
    pullRequests: [],
    userPermissions: [],
    groupPermissions: [],
    installation: {
      id: ctx.github.installationId,
      app_id: ctx.github.appId,
      repository_selection: 'all',
      suspended_at: null,
      permissions: Object.fromEntries(Object.entries(REQUIRED_APP_PERMISSIONS)),
    },
    org: { plan: { name: 'team' } },
    githubRepos: new Map(),
    failing: new Map(),
    calls: [],
  };
  const base = `/2.0/repositories/${ctx.bitbucket.workspace}/${f.slug}`;
  const bitbucket: BitbucketApi = {
    async request(method, fullPath, body) {
      state.calls.push(`${method} ${fullPath}`);
      for (const [needle, status] of state.failing) {
        if (fullPath.includes(needle)) return ok(undefined, status);
      }
      const path = fullPath.split('?')[0] as string;
      if (path === '/2.0/user') return ok({ account_id: state.userAccountId });
      if (path === `/2.0/workspaces/${ctx.bitbucket.workspace}/permissions`) {
        return page([
          { permission: state.workspacePermission, user: { account_id: ctx.bitbucket.accountId } },
        ]);
      }
      if (path === base && method === 'GET') {
        return state.repo ? ok(state.repo) : ok(undefined, 404);
      }
      if (path === base && method === 'PUT' && state.repo) {
        Object.assign(state.repo, body);
        return ok(state.repo);
      }
      if (path === `${base}/refs/branches`) return page(state.branches.map((name) => ({ name })));
      if (path === `${base}/refs/tags`) return page(state.tags.map((name) => ({ name })));
      const file = /\/src\/main\/(.+)$/.exec(path)?.[1];
      if (file) return state.files.has(file) ? ok({}) : ok(undefined, 404);
      if (path === `${base}/branch-restrictions`) return page(state.restrictions);
      const restriction = /\/branch-restrictions\/(\d+)$/.exec(path)?.[1];
      if (restriction && method === 'DELETE') {
        const before = state.restrictions.length;
        state.restrictions = state.restrictions.filter((row) => String(row.id) !== restriction);
        return ok(undefined, before === state.restrictions.length ? 404 : 204);
      }
      if (path === `${base}/deploy-keys`) return page(state.keys);
      if (path === `${base}/pipelines_config/variables`) return page(state.variables);
      if (path === `${base}/hooks`) return page(state.hooks);
      if (path === `${base}/pullrequests`) return page(state.pullRequests);
      if (path === `${base}/permissions-config/users`) return page(state.userPermissions);
      if (path === `${base}/permissions-config/groups`) return page(state.groupPermissions);
      return ok(undefined, 404);
    },
  };
  const github: GithubApi = {
    async asApp(route) {
      state.calls.push(`app ${route}`);
      if (route === 'GET /orgs/{org}/installation') {
        return state.installation ? ok(state.installation) : ok(undefined, 404);
      }
      return ok(undefined, 404);
    },
    async asInstallation(route, params) {
      state.calls.push(`installation ${route}`);
      if (route === 'GET /orgs/{org}') return ok(state.org);
      const name = `${String(params?.owner)}/${String(params?.repo)}`;
      if (route === 'GET /repos/{owner}/{repo}') {
        const repo = state.githubRepos.get(name);
        return repo ? ok(repo) : ok(undefined, 404);
      }
      if (route === 'DELETE /repos/{owner}/{repo}') {
        return state.githubRepos.delete(name) ? ok(undefined, 204) : ok(undefined, 404);
      }
      return ok(undefined, 404);
    },
  };
  return { state, bitbucket, github };
}
