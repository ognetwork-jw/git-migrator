/**
 * The adapter contract suite (TST-015) for the Bitbucket Cloud adapter, against the fake
 * Bitbucket (TST-006). Bitbucket is the source provider: every Facet is `write: false` and no
 * driver has `apply`, so each scenario is the read-only contract (valid per the Facet schema,
 * stable across two reads). The suite also pins that fact (ADP-014).
 */
import { bitbucketCloudAdapter, capabilities } from '@git-migrator/adapter-bitbucket-cloud';
import {
  type AdapterContext,
  type DriverContext,
  type FacetTarget,
  noopLogger,
} from '@git-migrator/adapter-sdk';
import { CANONICAL_FACETS, type FacetKey } from '@git-migrator/canonical';
import { createFakeBitbucket } from '@git-migrator/provider-fakes';
import { describe, expect, it } from 'vitest';
import {
  type AdapterContract,
  type ContractConnection,
  defineAdapterContract,
  type Scenario,
} from './contract.ts';

const BASE = 'http://localhost:4010';
const EMAIL = 'operator@test.local';
const TOKEN = 'fake-bitbucket-api-token';

type World = ReturnType<typeof createFakeBitbucket>;

async function connect(): Promise<ContractConnection<World>> {
  const fake = createFakeBitbucket({
    credentials: [{ email: EMAIL, token: TOKEN, accountId: 'acct-operator' }],
  });
  const s = fake.state;
  const alice = s.addUser({ nickname: 'alice', displayName: 'Alice A', accountId: 'acct-alice' });
  const bob = s.addUser({ nickname: 'bob', accountId: 'acct-bob' });
  s.addWorkspace({ slug: 'acme', name: 'Acme' });
  s.addCredentialMembers('acme');
  s.addMember('acme', alice.accountId, { admin: true });
  s.addMember('acme', bob.accountId);
  const devs = s.addGroup('acme', {
    name: 'Developers',
    slug: 'developers',
    members: [bob.accountId],
    defaultPermission: 'read',
  });
  s.addProject('acme', { key: 'PLAT', name: 'Platform' });
  s.addRepository('acme', {
    slug: 'auto-ok',
    projectKey: 'PLAT',
    description: 'hello',
    hasIssues: true,
    hasWiki: true,
    issueCount: 3,
    downloadCount: 2,
    pipelinesEnabled: true,
    files: { 'bitbucket-pipelines.yml': 'pipelines: {}\n' },
  });
  s.addBranch('acme', 'auto-ok', 'feature/x', { defaultMergeStrategy: 'squash' });
  s.addBranchRestriction('acme', 'auto-ok', { kind: 'force', pattern: '*' });
  s.addBranchRestriction('acme', 'auto-ok', {
    kind: 'push',
    pattern: 'main',
    users: [alice.accountId],
    groups: [devs.slug],
  });
  s.addBranchRestriction('acme', 'auto-ok', {
    kind: 'require_approvals_to_merge',
    pattern: 'main',
    value: 2,
  });
  s.addDeployKey('acme', 'auto-ok', { key: 'ssh-ed25519 AAAArepo repo@host', label: 'ci' });
  s.addVariable('acme', 'auto-ok', { key: 'PLAIN', value: 'v' });
  s.addVariable('acme', 'auto-ok', { key: 'HIDDEN', value: 'topsecret', secured: true });
  s.addEnvironment('acme', 'auto-ok', { name: 'Production', environmentType: 'Production' });
  s.addEnvironmentVariable('acme', 'auto-ok', 'Production', { key: 'E1', value: 'e' });
  s.addWebhook('acme', 'auto-ok', {
    url: 'https://hooks.test.local/a',
    secretSet: true,
    events: ['repo:push', 'pullrequest:comment_created'],
  });
  s.addWorkspaceWebhook('acme', { url: 'https://hooks.test.local/ws', events: ['repo:push'] });
  s.addWorkspaceVariable('acme', { key: 'WS_VAR', value: 'w' });
  s.addWorkspaceVariable('acme', { key: 'WS_SECRET', value: 'x', secured: true });
  s.grantRepositoryUser('acme', 'auto-ok', alice.accountId, 'admin');
  s.grantRepositoryUser('acme', 'auto-ok', bob.accountId, 'read');
  s.addPullRequest('acme', 'auto-ok', {
    title: 'Open one',
    sourceBranch: 'feature/x',
    authorAccountId: 'acct-bob',
  });

  const git = {
    lsRemote: async () => ({
      headSymref: 'refs/heads/main',
      refs: [
        { name: 'HEAD', sha: 'a'.repeat(40) },
        { name: 'refs/heads/main', sha: 'a'.repeat(40) },
        { name: 'refs/tags/v1', sha: 'b'.repeat(40) },
      ],
    }),
  };
  const adapterCtx: AdapterContext = {
    quota: {
      acquire: async () => ({ granted: true, at: new Date('2026-01-01T00:00:00Z'), buckets: [] }),
      recordFeedback: async () => {},
      recordRateLimited: async () => new Date(Date.now() + 60_000),
      recordSecondaryLimit: async () => new Date(Date.now() + 60_000),
      adjust: async () => {},
    },
    logger: noopLogger,
    capture: { save: async () => 'raw' },
    fetch: (async (input: URL | string | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      return fake.app.request(url.toString(), init);
    }) as typeof fetch,
    environment: 'test',
    git,
    pool: 'background',
    signal: new AbortController().signal,
  };
  const conn = await bitbucketCloudAdapter.connect(
    {
      id: 'bb-main',
      baseUrl: BASE,
      config: { workspace: 'acme', gitBaseUrl: 'http://localhost:4030/source' },
      credential: { accountId: 'acct-operator', email: EMAIL, apiToken: TOKEN },
      accountKey: 'acct-operator',
    },
    adapterCtx,
  );
  const ctx: DriverContext = {
    http: conn.http,
    git,
    logger: noopLogger,
    pool: 'background',
    signal: adapterCtx.signal,
  };
  return { world: fake, conn, ctx };
}

const repo: FacetTarget = {
  scope: 'repository',
  repository: { providerId: 'x', namespace: { providerId: 'p', slug: 'PLAT' }, slug: 'auto-ok' },
  namespace: { providerId: 'p', slug: 'PLAT' },
};
const endpoint: FacetTarget = {
  scope: 'endpoint',
  namespace: { providerId: 'acme', slug: 'acme' },
};

type Doc = Record<string, unknown>;
const list = (data: unknown, key: string): Doc[] => (data as Doc)[key] as Doc[];
const keys = (data: unknown, key: string, field: string): unknown[] =>
  list(data, key).map((item) => item[field]);

/**
 * What the seeded world must show in each read, so a read that drops data fails (the read-only
 * contract cannot compare to a written document).
 */
const SEEDED_READS: Record<FacetKey, (data: unknown) => void> = {
  'git-refs': (d) => {
    expect(keys(d, 'refs', 'name')).toEqual(['refs/heads/main', 'refs/tags/v1']);
    expect((d as Doc).defaultBranch).toBe('main');
  },
  'repository-settings': (d) =>
    expect(d).toMatchObject({ description: 'hello', visibility: 'private' }),
  'merge-settings': (d) => expect((d as Doc).allowed).toContain('squash'),
  'access-control': (d) => {
    expect(list(d, 'grants')).toHaveLength(2);
    expect(list(d, 'grants').map((g) => (g.principal as Doc).id)).toEqual([
      'developers',
      'acct-bob',
    ]);
  },
  'branch-rules': (d) => {
    expect(keys(d, 'rules', 'pattern')).toEqual(['**', 'main']);
    expect(list(d, 'rules')[1]).toMatchObject({ restrictPushes: expect.any(Array) });
    expect(list(d, 'rules')[1]?.changeRequest).toMatchObject({ minApprovals: 2 });
  },
  webhooks: (d) => {
    expect(keys(d, 'hooks', 'url')).toEqual(['https://hooks.test.local/a']);
    expect(list(d, 'hooks')[0]).toMatchObject({ hasSecret: true });
  },
  'deploy-keys': (d) => expect(keys(d, 'keys', 'title')).toEqual(['ci']),
  variables: (d) =>
    expect(keys(d, 'variables', 'key')).toEqual(['repository/PLAIN', 'environment:Production/E1']),
  secrets: (d) => expect(keys(d, 'secrets', 'key')).toEqual(['repository/HIDDEN']),
  environments: (d) => expect(keys(d, 'environments', 'name')).toEqual(['Production']),
  pipelines: (d) => expect(keys(d, 'files', 'path')).toEqual(['bitbucket-pipelines.yml']),
  'code-ownership': (d) => expect(list(d, 'owners')).toEqual([]),
  'change-requests': (d) => expect(keys(d, 'open', 'title')).toEqual(['Open one']),
  extras: (d) => expect(d).toMatchObject({ issueCount: 3, downloadCount: 2, wikiPopulated: true }),
  members: (d) => expect(list(d, 'members')).toHaveLength(3),
  teams: (d) => expect(keys(d, 'teams', 'slug')).toEqual(['developers']),
  'org-variables': (d) => expect(keys(d, 'variables', 'name')).toEqual(['WS_VAR']),
  'org-secrets': (d) => expect(keys(d, 'secrets', 'name')).toEqual(['WS_SECRET']),
  'org-webhooks': (d) => expect(keys(d, 'hooks', 'url')).toEqual(['https://hooks.test.local/ws']),
};

const scenarios: Scenario<World>[] = (Object.keys(SEEDED_READS) as FacetKey[]).map((facet) => {
  const scope = CANONICAL_FACETS[facet].scope;
  return {
    facet,
    name: scope === 'repository' ? 'the seeded repository' : 'the seeded workspace',
    prepare: () => ({
      target: scope === 'repository' ? repo : endpoint,
      checkRead: SEEDED_READS[facet],
    }),
  };
});

const contract: AdapterContract<World> = {
  name: 'bitbucket-cloud',
  connect,
  capabilities,
  normalisations: {},
  scenarios,
};

defineAdapterContract(contract);

describe('adapter contract: bitbucket-cloud is a source', () => {
  it('[TST-015] no Facet is writable, so no round-trip applies', async () => {
    for (const cap of Object.values(capabilities.facets)) expect(cap?.write).toBe(false);
    const { conn } = await connect();
    for (const driver of Object.values(conn.facets)) expect(driver?.apply).toBeUndefined();
  });
});
