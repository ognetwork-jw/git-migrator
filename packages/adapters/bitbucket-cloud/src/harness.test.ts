/**
 * Shared test harness: the fake Bitbucket (T-041) behind the adapter's `fetch` seam, a recording
 * quota gate and a scripted git client. Never touches a real provider (TST-006).
 */

import type {
  AdapterContext,
  EndpointConnection,
  GitClient,
  GitLsRemoteResult,
  QuotaFeedback,
  RawCaptureInput,
} from '@git-migrator/adapter-sdk';
import type { FacetKey } from '@git-migrator/canonical';
import { createFakeBitbucket, type FakeBitbucketOptions } from '@git-migrator/provider-fakes';
import { expect, it } from 'vitest';
import { bitbucketCloudAdapter } from './adapter.ts';

export const BASE_URL = 'http://localhost:4010';
export const TOKEN = 'fake-bitbucket-api-token';
export const EMAIL = 'operator@test.local';

export interface Recorder {
  acquired: { keys: string[]; pool: string }[];
  feedback: QuotaFeedback[];
  rateLimited: { bucketKey: string }[];
  captures: RawCaptureInput[];
  requests: { method: string; path: string }[];
  lsRemote: { url: string; username: string }[];
}

export function makeWorld(options: FakeBitbucketOptions = {}) {
  const fake = createFakeBitbucket({
    credentials: [{ email: EMAIL, token: TOKEN, accountId: 'acct-operator' }],
    ...options,
  });
  const { state } = fake;
  const alice = state.addUser({
    nickname: 'alice',
    displayName: 'Alice A',
    accountId: 'acct-alice',
  });
  const bob = state.addUser({ nickname: 'bob', accountId: 'acct-bob' });
  state.addWorkspace({ slug: 'acme', name: 'Acme' });
  state.addCredentialMembers('acme');
  state.addMember('acme', alice.accountId, { admin: true });
  state.addMember('acme', bob.accountId);
  const devs = state.addGroup('acme', {
    name: 'Developers',
    slug: 'developers',
    members: [bob.accountId],
    defaultPermission: 'read',
  });
  state.addProject('acme', { key: 'PLAT', name: 'Platform' });
  state.addProject('acme', { key: 'DATA', name: 'Data' });
  state.grantProjectUser('acme', 'PLAT', bob.accountId, 'write');
  state.grantProjectGroup('acme', 'PLAT', devs.slug, 'create-repo');
  state.addProjectDeployKey('acme', 'PLAT', {
    key: 'ssh-ed25519 AAAAproject proj@host',
    label: 'project key',
  });
  state.addRepository('acme', {
    slug: 'auto-ok',
    projectKey: 'PLAT',
    description: 'hello',
    hasIssues: true,
    hasWiki: true,
    issueCount: 3,
    downloadCount: 2,
    size: 1234,
    pipelinesEnabled: true,
    files: { 'bitbucket-pipelines.yml': 'pipelines: {}\n' },
  });
  state.addBranch('acme', 'auto-ok', 'feature/x', { defaultMergeStrategy: 'squash' });
  state.addBranchRestriction('acme', 'auto-ok', { kind: 'force', pattern: '*' });
  state.addBranchRestriction('acme', 'auto-ok', {
    kind: 'push',
    pattern: 'main',
    users: [alice.accountId],
    groups: [devs.slug],
  });
  state.addBranchRestriction('acme', 'auto-ok', {
    kind: 'require_approvals_to_merge',
    pattern: 'main',
    value: 2,
  });
  state.addDeployKey('acme', 'auto-ok', { key: 'ssh-ed25519 AAAArepo repo@host', label: 'ci' });
  state.addVariable('acme', 'auto-ok', { key: 'PLAIN', value: 'v' });
  state.addVariable('acme', 'auto-ok', { key: 'HIDDEN', value: 'topsecret', secured: true });
  state.addEnvironment('acme', 'auto-ok', { name: 'Production', environmentType: 'Production' });
  state.addEnvironmentVariable('acme', 'auto-ok', 'Production', { key: 'E1', value: 'e' });
  state.addEnvironmentVariable('acme', 'auto-ok', 'Production', {
    key: 'E2',
    value: 's',
    secured: true,
  });
  state.addWebhook('acme', 'auto-ok', {
    url: 'https://hooks.test.local/a',
    secretSet: true,
    events: ['repo:push', 'pullrequest:comment_created', 'repo:commit_comment_created'],
  });
  state.addWorkspaceWebhook('acme', { url: 'https://hooks.test.local/ws', events: ['repo:push'] });
  state.addWorkspaceVariable('acme', { key: 'WS_VAR', value: 'w' });
  state.addWorkspaceVariable('acme', { key: 'WS_SECRET', value: 'x', secured: true });
  state.grantRepositoryUser('acme', 'auto-ok', alice.accountId, 'admin');
  state.grantRepositoryUser('acme', 'auto-ok', bob.accountId, 'read');
  state.addRepository('acme', {
    slug: 'empty',
    projectKey: 'DATA',
    mainbranch: null,
    hasWiki: false,
  });
  state.addPullRequest('acme', 'auto-ok', {
    title: 'Open one',
    sourceBranch: 'feature/x',
    authorAccountId: 'acct-bob',
  });
  return { fake, alice, bob, devs };
}

export function makeConnection(
  world: ReturnType<typeof makeWorld>,
  options: {
    lsRemote?: (request: {
      url: string;
      username: string;
    }) => GitLsRemoteResult | Promise<GitLsRemoteResult>;
    pool?: 'background' | 'interactive';
    credential?: Record<string, unknown>;
    config?: Record<string, unknown>;
    /** The Run signal (default: never aborted). */
    signal?: AbortSignal;
  } = {},
): Promise<{ conn: EndpointConnection; rec: Recorder }> {
  const rec: Recorder = {
    acquired: [],
    feedback: [],
    rateLimited: [],
    captures: [],
    requests: [],
    lsRemote: [],
  };
  const git: GitClient = {
    async lsRemote(request) {
      rec.lsRemote.push({ url: request.url, username: request.credential.username });
      if (options.lsRemote === undefined) return { refs: [] };
      return options.lsRemote({ url: request.url, username: request.credential.username });
    },
  };
  const fetchSeam: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    rec.requests.push({ method: init?.method ?? 'GET', path: `${url.pathname}${url.search}` });
    return world.fake.app.request(url.toString(), init);
  };
  const ctx: AdapterContext = {
    quota: {
      async acquire(buckets, pool) {
        rec.acquired.push({ keys: buckets.map((b) => b.key), pool });
        return { granted: true, at: new Date('2026-01-01T00:00:00Z'), buckets: [] } as never;
      },
      async recordFeedback(f) {
        rec.feedback.push(f);
      },
      async recordRateLimited(input) {
        rec.rateLimited.push({ bucketKey: input.bucketKey });
        return new Date(Date.now() + 60_000);
      },
      async recordSecondaryLimit() {
        return new Date(Date.now() + 60_000);
      },
      async adjust() {},
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    capture: {
      async save(input) {
        rec.captures.push(input);
        return `raw-${rec.captures.length}`;
      },
    },
    fetch: fetchSeam,
    environment: 'test',
    git,
    pool: options.pool ?? 'background',
    signal: options.signal ?? new AbortController().signal,
  };
  return bitbucketCloudAdapter
    .connect(
      {
        id: 'bb-main',
        baseUrl: BASE_URL,
        config: {
          workspace: 'acme',
          gitBaseUrl: 'http://localhost:4030/source',
          ...options.config,
        },
        credential: {
          accountId: 'acct-operator',
          email: EMAIL,
          apiToken: TOKEN,
          ...options.credential,
        },
        accountKey: 'acct-operator',
      },
      ctx,
    )
    .then((conn) => ({ conn, rec }));
}

export function facet(conn: EndpointConnection, key: FacetKey) {
  const driver = conn.facets[key];
  if (driver === undefined) throw new Error(`no driver ${key}`);
  return driver;
}

export const target = (slug = 'auto-ok', project = 'PLAT') => ({
  scope: 'repository' as const,
  repository: { providerId: 'x', namespace: { providerId: 'p', slug: project }, slug },
  namespace: { providerId: 'p', slug: project },
});
export const endpointTarget = () => ({
  scope: 'endpoint' as const,
  namespace: { providerId: 'acme', slug: 'acme' },
});

export function driverCtx(conn: EndpointConnection, git?: GitClient) {
  return {
    http: conn.http,
    git: git ?? { lsRemote: async () => ({ refs: [] }) },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    pool: 'background' as const,
    signal: new AbortController().signal,
  };
}

it('[TST-010] the harness builds a world the adapter can connect to', async () => {
  const world = makeWorld();
  const { conn } = await makeConnection(world);
  expect(conn.limits.repositoryName.caseInsensitiveUnique).toBe(true);
});
