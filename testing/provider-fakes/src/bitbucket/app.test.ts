import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createFakeBitbucket, type FakeBitbucket, type FakeBitbucketOptions } from './app.ts';
import { REQUIRED_SCOPES, SCOPES_NOT_IN_SPEC, toTemplate } from './scopes.ts';
import { validateAgainstSpec } from './spec-validation.ts';

const AUTH = `Basic ${Buffer.from('operator@test.local:fake-bitbucket-api-token').toString('base64')}`;
const HEADERS = { Authorization: AUTH };

function setup(options: FakeBitbucketOptions = {}) {
  const fake = createFakeBitbucket(options);
  const { state } = fake;
  const alice = state.addUser({
    nickname: 'alice',
    displayName: 'Alice A',
    email: 'alice@test.local',
  });
  const bob = state.addUser({ nickname: 'bob' });
  state.addWorkspace({ slug: 'acme', name: 'Acme' });
  state.addCredentialMembers('acme');
  state.addMember('acme', alice.accountId, { admin: true });
  state.addMember('acme', bob.accountId);
  const devs = state.addGroup('acme', {
    name: 'Developers',
    members: [bob.accountId],
    defaultPermission: 'read',
  });
  state.addProject('acme', { key: 'PLAT', name: 'Platform' });
  state.addProject('acme', { key: 'DATA', name: 'Data' });
  state.grantProjectUser('acme', 'PLAT', bob.accountId, 'write');
  state.grantProjectGroup('acme', 'PLAT', devs.slug, 'create-repo');
  state.addProjectDeployKey('acme', 'PLAT', {
    key: 'ssh-ed25519 AAAAproject',
    label: 'project key',
  });
  const repo = state.addRepository('acme', {
    slug: 'auto-ok',
    projectKey: 'PLAT',
    description: 'hello',
    hasIssues: true,
    issueCount: 3,
    downloadCount: 2,
    size: 1234,
    pipelinesEnabled: true,
    files: { 'bitbucket-pipelines.yml': 'pipelines: {}\n', 'src/a.txt': 'a', 'src/b/c.txt': 'c' },
    gitRoot: '/srv/git/acme/auto-ok.git',
  });
  state.addBranch('acme', 'auto-ok', 'feature/x', { defaultMergeStrategy: 'squash' });
  state.addBranchRestriction('acme', 'auto-ok', { kind: 'force', pattern: '*' });
  state.addBranchRestriction('acme', 'auto-ok', { kind: 'delete', pattern: 'release/*' });
  state.addBranchRestriction('acme', 'auto-ok', {
    kind: 'push',
    pattern: 'main',
    users: [alice.accountId],
    groups: [devs.slug],
  });
  state.addBranchRestriction('acme', 'auto-ok', {
    kind: 'require_commits_behind',
    branchMatchKind: 'branching_model',
    branchType: 'development',
    pattern: '',
    value: 3,
  });
  state.addDeployKey('acme', 'auto-ok', { key: 'ssh-ed25519 AAAArepo', label: 'ci', comment: 'c' });
  state.addVariable('acme', 'auto-ok', { key: 'PLAIN', value: 'v' });
  state.addVariable('acme', 'auto-ok', { key: 'HIDDEN', value: 'topsecret', secured: true });
  const env = state.addEnvironment('acme', 'auto-ok', {
    name: 'Production',
    environmentType: 'Production',
  });
  state.addEnvironmentVariable('acme', 'auto-ok', 'Production', { key: 'E1', value: 'e' });
  state.addEnvironmentVariable('acme', 'auto-ok', 'Production', {
    key: 'E2',
    value: 's',
    secured: true,
  });
  state.addWebhook('acme', 'auto-ok', { url: 'https://hooks.test.local/a', secretSet: true });
  state.addWorkspaceWebhook('acme', { url: 'https://hooks.test.local/ws' });
  state.addWorkspaceVariable('acme', { key: 'WS_VAR', value: 'w' });
  state.grantRepositoryUser('acme', 'auto-ok', alice.accountId, 'admin');
  state.grantRepositoryGroup('acme', 'auto-ok', devs.slug, 'write');
  state.addPullRequest('acme', 'auto-ok', { title: 'open', authorAccountId: bob.accountId });
  state.addPullRequest('acme', 'auto-ok', {
    title: 'merged',
    authorAccountId: bob.accountId,
    state: 'MERGED',
  });
  repo.defaultReviewers.push({ accountId: alice.accountId, reviewerType: 'repository' });
  state.addRepository('acme', { slug: 'empty-repo', projectKey: 'DATA', mainbranch: null });
  return { fake, state, alice, bob, devs, repo, env };
}

// biome-ignore lint/suspicious/noExplicitAny: response bodies are inspected loosely in tests
type Loose = any;

async function get(
  fake: FakeBitbucket,
  path: string,
  headers: Record<string, string | undefined> = HEADERS,
) {
  const res = await fake.app.request(path, { headers });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // raw text
  }
  return { res, body: body as Loose };
}

/** Every endpoint of the provider doc's "Endpoints used" table, with its OpenAPI path template. */
const ENDPOINTS: { name: string; url: string; template: string; noSchema?: boolean }[] = [
  {
    name: 'projects',
    url: '/2.0/workspaces/acme/projects',
    template: '/workspaces/{workspace}/projects',
  },
  { name: 'repositories', url: '/2.0/repositories/acme', template: '/repositories/{workspace}' },
  {
    name: 'repositories by project',
    url: `/2.0/repositories/acme?q=${encodeURIComponent('project.key="PLAT"')}&pagelen=100`,
    template: '/repositories/{workspace}',
  },
  {
    name: 'repository',
    url: '/2.0/repositories/acme/auto-ok',
    template: '/repositories/{workspace}/{repo_slug}',
  },
  {
    name: 'members',
    url: '/2.0/workspaces/acme/members',
    template: '/workspaces/{workspace}/members',
  },
  {
    name: 'repo user permissions',
    url: '/2.0/repositories/acme/auto-ok/permissions-config/users',
    template: '/repositories/{workspace}/{repo_slug}/permissions-config/users',
  },
  {
    name: 'repo group permissions',
    url: '/2.0/repositories/acme/auto-ok/permissions-config/groups',
    template: '/repositories/{workspace}/{repo_slug}/permissions-config/groups',
  },
  {
    name: 'project user permissions',
    url: '/2.0/workspaces/acme/projects/PLAT/permissions-config/users',
    template: '/workspaces/{workspace}/projects/{project_key}/permissions-config/users',
  },
  {
    name: 'project group permissions',
    url: '/2.0/workspaces/acme/projects/PLAT/permissions-config/groups',
    template: '/workspaces/{workspace}/projects/{project_key}/permissions-config/groups',
  },
  {
    name: 'effective permissions',
    url: '/2.0/workspaces/acme/permissions/repositories/auto-ok',
    template: '/workspaces/{workspace}/permissions/repositories/{repo_slug}',
  },
  {
    name: 'branch restrictions',
    url: '/2.0/repositories/acme/auto-ok/branch-restrictions',
    template: '/repositories/{workspace}/{repo_slug}/branch-restrictions',
  },
  {
    name: 'effective branching model',
    url: '/2.0/repositories/acme/auto-ok/effective-branching-model',
    template: '/repositories/{workspace}/{repo_slug}/effective-branching-model',
  },
  {
    name: 'effective default reviewers',
    url: '/2.0/repositories/acme/auto-ok/effective-default-reviewers',
    template: '/repositories/{workspace}/{repo_slug}/effective-default-reviewers',
  },
  {
    name: 'main branch',
    url: '/2.0/repositories/acme/auto-ok/refs/branches/main',
    template: '/repositories/{workspace}/{repo_slug}/refs/branches/{name}',
  },
  {
    name: 'branching model settings',
    url: '/2.0/repositories/acme/auto-ok/branching-model/settings',
    template: '/repositories/{workspace}/{repo_slug}/branching-model/settings',
  },
  {
    name: 'project branching model settings',
    url: '/2.0/workspaces/acme/projects/PLAT/branching-model/settings',
    template: '/workspaces/{workspace}/projects/{project_key}/branching-model/settings',
  },
  {
    name: 'repo hooks',
    url: '/2.0/repositories/acme/auto-ok/hooks',
    template: '/repositories/{workspace}/{repo_slug}/hooks',
  },
  {
    name: 'workspace hooks',
    url: '/2.0/workspaces/acme/hooks',
    template: '/workspaces/{workspace}/hooks',
  },
  {
    name: 'repo deploy keys',
    url: '/2.0/repositories/acme/auto-ok/deploy-keys',
    template: '/repositories/{workspace}/{repo_slug}/deploy-keys',
  },
  {
    name: 'project deploy keys',
    url: '/2.0/workspaces/acme/projects/PLAT/deploy-keys',
    template: '/workspaces/{workspace}/projects/{project_key}/deploy-keys',
  },
  {
    name: 'pipelines config',
    url: '/2.0/repositories/acme/auto-ok/pipelines_config',
    template: '/repositories/{workspace}/{repo_slug}/pipelines_config',
  },
  {
    name: 'repo variables',
    url: '/2.0/repositories/acme/auto-ok/pipelines_config/variables',
    template: '/repositories/{workspace}/{repo_slug}/pipelines_config/variables',
  },
  {
    name: 'environments',
    url: '/2.0/repositories/acme/auto-ok/environments',
    template: '/repositories/{workspace}/{repo_slug}/environments',
  },
  {
    name: 'workspace variables',
    url: '/2.0/workspaces/acme/pipelines-config/variables',
    template: '/workspaces/{workspace}/pipelines-config/variables',
  },
  {
    name: 'src directory',
    url: '/2.0/repositories/acme/auto-ok/src/main/src',
    template: '/repositories/{workspace}/{repo_slug}/src/{commit}/{path}',
  },
  {
    name: 'open pull requests',
    url: '/2.0/repositories/acme/auto-ok/pullrequests?state=OPEN',
    template: '/repositories/{workspace}/{repo_slug}/pullrequests',
  },
  {
    name: 'downloads',
    url: '/2.0/repositories/acme/auto-ok/downloads?pagelen=1&fields=size',
    template: '/repositories/{workspace}/{repo_slug}/downloads',
    noSchema: true,
  },
];

describe('[TST-010] responses conform to the saved Bitbucket OpenAPI document', () => {
  for (const ep of ENDPOINTS) {
    it(`[TST-010] ${ep.name}: ${ep.url}`, async () => {
      const { fake } = setup();
      const { res, body } = await get(fake, ep.url);
      expect(res.status).toBe(200);
      // The 200 response of /downloads has no schema in the document, so there is nothing to check.
      if (ep.noSchema) return expect(body).toEqual({ size: 2 });
      expect(validateAgainstSpec('get', ep.template, 200, body).errors).toEqual([]);
    });
  }

  it('[TST-010] environment variables validate', async () => {
    const { fake, env } = setup();
    const url = `/2.0/repositories/acme/auto-ok/deployments_config/environments/${encodeURIComponent(env.uuid)}/variables`;
    const { res, body } = await get(fake, url);
    expect(res.status).toBe(200);
    expect(
      validateAgainstSpec(
        'get',
        '/repositories/{workspace}/{repo_slug}/deployments_config/environments/{environment_uuid}/variables',
        200,
        body,
      ).errors,
    ).toEqual([]);
    expect(body.values?.length).toBe(2);
  });

  it('[TST-010] branch restriction create returns a conforming 201', async () => {
    const { fake } = setup();
    const res = await fake.app.request('/2.0/repositories/acme/auto-ok/branch-restrictions', {
      method: 'POST',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'push', pattern: '*', branch_match_kind: 'glob' }),
    });
    expect(res.status).toBe(201);
    expect(
      validateAgainstSpec(
        'post',
        '/repositories/{workspace}/{repo_slug}/branch-restrictions',
        201,
        await res.json(),
      ).errors,
    ).toEqual([]);
  });

  it('[TST-010] repository PUT (update 200 and create 201) conforms', async () => {
    const { fake } = setup();
    const put = (slug: string, body: unknown) =>
      fake.app.request(`/2.0/repositories/acme/${slug}`, {
        method: 'PUT',
        headers: { ...HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const upd = await put('auto-ok', { description: 'x' });
    expect(upd.status).toBe(200);
    expect(
      validateAgainstSpec('put', '/repositories/{workspace}/{repo_slug}', 200, await upd.json())
        .errors,
    ).toEqual([]);
    const created = await put('brand-new', { project: { key: 'DATA' } });
    expect(created.status).toBe(201);
    expect(
      validateAgainstSpec('put', '/repositories/{workspace}/{repo_slug}', 201, await created.json())
        .errors,
    ).toEqual([]);
  });

  it('[TST-010] error bodies conform', async () => {
    const { fake } = setup();
    const { res, body } = await get(fake, '/2.0/repositories/acme/nope');
    expect(res.status).toBe(404);
    expect(
      validateAgainstSpec('get', '/repositories/{workspace}/{repo_slug}', 404, body).errors,
    ).toEqual([]);
  });

  it('[TST-010] the validator rejects a non-conforming body', () => {
    expect(
      validateAgainstSpec('get', '/workspaces/{workspace}/projects', 200, { values: 5 }).errors,
    ).not.toEqual([]);
    expect(validateAgainstSpec('get', '/nope', 200, {}).errors[0]).toMatch(/no operation/);
  });
});

describe('[TST-010] Basic auth', () => {
  it('[TST-010] rejects missing, malformed and wrong credentials with 401', async () => {
    const { fake } = setup();
    for (const h of [
      {},
      { Authorization: 'Bearer abc' },
      { Authorization: `Basic ${Buffer.from('operator@test.local:wrong').toString('base64')}` },
      { Authorization: `Basic ${Buffer.from('nocolon').toString('base64')}` },
      {
        Authorization: `Basic ${Buffer.from('other@test.local:fake-bitbucket-api-token').toString('base64')}`,
      },
    ]) {
      const { res, body } = await get(fake, '/2.0/repositories/acme', h);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toMatch(/^Basic/);
      expect(body.type).toBe('error');
    }
  });

  it('[TST-010] accepts configured credentials (email + API token) and identifies the account', async () => {
    const { fake } = setup({
      credentials: [{ email: 'me@example.test', token: 'tok-1', nickname: 'me' }],
    });
    const h = { Authorization: `Basic ${Buffer.from('me@example.test:tok-1').toString('base64')}` };
    const { res, body } = await get(fake, '/2.0/user', h);
    expect(res.status).toBe(200);
    expect(body.nickname).toBe('me');
    expect(validateAgainstSpec('get', '/user', 200, body).errors).toEqual([]);
    expect((await get(fake, '/2.0/user', HEADERS)).res.status).toBe(401);
  });

  it('[TST-010] token passwords may contain colons', async () => {
    const { fake } = setup({ credentials: [{ email: 'a@b.test', token: 'x:y:z' }] });
    const h = { Authorization: `Basic ${Buffer.from('a@b.test:x:y:z').toString('base64')}` };
    expect((await get(fake, '/2.0/user', h)).res.status).toBe(200);
  });
});

describe('[TST-010] pagination', () => {
  function many(n: number, options: FakeBitbucketOptions = {}) {
    const ctx = setup(options);
    for (let i = 0; i < n; i++)
      ctx.state.addRepository('acme', {
        slug: `r${String(i).padStart(3, '0')}`,
        projectKey: 'DATA',
      });
    return ctx.fake;
  }

  it('[TST-010] follows next links until exhausted and returns every repository once', async () => {
    const fake = many(25);
    const slugs: string[] = [];
    let url: string | undefined = '/2.0/repositories/acme?pagelen=7';
    let pages = 0;
    while (url) {
      const { res, body } = await get(fake, url);
      expect(res.status).toBe(200);
      expect(body.pagelen).toBe(7);
      expect(body.size).toBe(27);
      for (const v of body.values as { slug: string }[]) slugs.push(v.slug);
      pages++;
      const next = body.next as string | undefined;
      url = next ? next.replace('http://localhost', '') : undefined;
    }
    expect(pages).toBe(4);
    expect(new Set(slugs).size).toBe(27);
  });

  it('[TST-010] next links are absolute, keep other query parameters and previous is set after page 1', async () => {
    const fake = many(12);
    const { body } = await get(fake, '/2.0/repositories/acme?pagelen=5&q=name~%22r%22');
    const next = new URL(body.next as string);
    expect(next.origin).toBe('http://localhost');
    expect(next.searchParams.get('page')).toBe('2');
    expect(next.searchParams.get('q')).toBe('name~"r"');
    const second = await get(fake, (body.next as string).replace('http://localhost', ''));
    expect(second.body.previous).toBeTypeOf('string');
    expect(second.body.page).toBe(2);
  });

  it('[TST-010] default pagelen is 10 and requests above the maximum are clamped', async () => {
    const fake = many(150);
    expect((await get(fake, '/2.0/repositories/acme')).body.pagelen).toBe(10);
    const big = await get(fake, '/2.0/repositories/acme?pagelen=500');
    expect(big.body.pagelen).toBe(100);
    expect(big.body.values?.length).toBe(100);
    expect(big.body.next).toBeTypeOf('string');
  });

  it('[TST-010] the maximum pagelen is configurable so adapters cannot assume 100', async () => {
    const fake = many(30, { pageOptions: { maxPagelen: 20 } });
    const { body } = await get(fake, '/2.0/repositories/acme?pagelen=100');
    expect(body.pagelen).toBe(20);
    expect(body.values?.length).toBe(20);
  });

  it('[TST-010] rejects a bad pagelen or page with 400', async () => {
    const fake = many(1);
    expect((await get(fake, '/2.0/repositories/acme?pagelen=0')).res.status).toBe(400);
    expect((await get(fake, '/2.0/repositories/acme?page=x')).res.status).toBe(400);
  });

  it('[TST-010] webhook lists use the closed envelope (values, pagelen, next only)', async () => {
    const { fake, state } = setup();
    for (let i = 0; i < 12; i++)
      state.addWebhook('acme', 'auto-ok', { url: `https://hooks.test.local/${i}` });
    const { body } = await get(fake, '/2.0/repositories/acme/auto-ok/hooks?pagelen=5');
    expect(Object.keys(body).sort()).toEqual(['next', 'pagelen', 'values']);
  });
});

describe('[TST-010] q, sort and fields', () => {
  it('[TST-010] q=project.key="X" filters repositories, with AND/OR/NOT, ~ and parentheses', async () => {
    const { fake } = setup();
    const slugs = async (q: string) =>
      (
        (await get(fake, `/2.0/repositories/acme?q=${encodeURIComponent(q)}`)).body.values as {
          slug: string;
        }[]
      ).map((v) => v.slug);
    expect(await slugs('project.key="PLAT"')).toEqual(['auto-ok']);
    expect(await slugs('project.key="DATA"')).toEqual(['empty-repo']);
    expect(await slugs('project.key="PLAT" OR project.key="DATA"')).toHaveLength(2);
    expect(await slugs('project.key="PLAT" AND name~"EMPTY"')).toEqual([]);
    expect(await slugs('NOT (project.key="PLAT")')).toEqual(['empty-repo']);
    expect(await slugs('has_issues=true')).toEqual(['auto-ok']);
    expect(await slugs('size>1000')).toEqual(['auto-ok']);
    expect(await slugs('size<=1000 AND name!~"x"')).toEqual(['empty-repo']);
    expect(await slugs('description!="hello"')).toEqual(['empty-repo']);
  });

  it('[TST-010] a malformed q is a 400', async () => {
    const { fake } = setup();
    for (const q of ['project.key=', 'a = "x', '(a="b"', 'a ?? b', '= "x"', 'a="b" c']) {
      expect(
        (await get(fake, `/2.0/repositories/acme?q=${encodeURIComponent(q)}`)).res.status,
      ).toBe(400);
    }
  });

  it('[TST-010] sort orders ascending and descending', async () => {
    const { fake } = setup();
    const names = async (sort: string) =>
      (
        (await get(fake, `/2.0/repositories/acme?sort=${sort}`)).body.values as { slug: string }[]
      ).map((v) => v.slug);
    expect(await names('name')).toEqual(['auto-ok', 'empty-repo']);
    expect(await names('-name')).toEqual(['empty-repo', 'auto-ok']);
  });

  it('[TST-010] fields= trims payloads like the pull request query of the provider doc', async () => {
    const { fake } = setup();
    const { body } = await get(
      fake,
      '/2.0/repositories/acme/auto-ok/pullrequests?state=OPEN&fields=values.id,values.title,values.links.html,next,size',
    );
    expect(body).toEqual({
      size: 1,
      values: [
        {
          id: 1,
          title: 'open',
          links: { html: { href: 'https://bitbucket.org/acme/auto-ok/pull-requests/1' } },
        },
      ],
    });
  });

  it('[TST-010] fields=-x removes fields and +x keeps defaults', async () => {
    const { fake } = setup();
    const minus = await get(fake, '/2.0/repositories/acme/auto-ok?fields=-owner,-links');
    expect(minus.body).not.toHaveProperty('owner');
    expect(minus.body).toHaveProperty('slug');
    const plus = await get(fake, '/2.0/repositories/acme/auto-ok?fields=%2Bextra');
    expect(plus.body).toHaveProperty('slug');
  });

  it('[TST-010] open pull requests only by default, other states on request', async () => {
    const { fake } = setup();
    expect((await get(fake, '/2.0/repositories/acme/auto-ok/pullrequests')).body.size).toBe(1);
    expect(
      (await get(fake, '/2.0/repositories/acme/auto-ok/pullrequests?state=MERGED&state=OPEN')).body
        .size,
    ).toBe(2);
  });
});

describe('[TST-010] resource semantics', () => {
  it('[TST-010] secured variables never expose a value; hooks never expose the secret', async () => {
    const { fake } = setup();
    const vars = (await get(fake, '/2.0/repositories/acme/auto-ok/pipelines_config/variables')).body
      .values as {
      key: string;
      value?: string;
    }[];
    expect(vars.find((v) => v.key === 'PLAIN')?.value).toBe('v');
    expect(vars.find((v) => v.key === 'HIDDEN')).not.toHaveProperty('value');
    const hooks = (await get(fake, '/2.0/repositories/acme/auto-ok/hooks')).body.values as Record<
      string,
      unknown
    >[];
    expect(hooks[0]).toMatchObject({ secret_set: true });
    expect(hooks[0]).not.toHaveProperty('secret');
  });

  it('[TST-010] unknown workspace, repository, project and environment are 404 errors', async () => {
    const { fake } = setup();
    for (const p of [
      '/2.0/repositories/nope',
      '/2.0/repositories/acme/nope',
      '/2.0/workspaces/acme/projects/NOPE/deploy-keys',
      '/2.0/repositories/acme/auto-ok/deployments_config/environments/%7Bnope%7D/variables',
      '/2.0/repositories/acme/auto-ok/refs/branches/nope',
      '/2.0/something/else',
    ]) {
      const { res, body } = await get(fake, p);
      expect(res.status, p).toBe(404);
      expect(body.type).toBe('error');
    }
  });

  it('[TST-010] branch restrictions: filters, create, read, delete and validation', async () => {
    const { fake } = setup();
    const base = '/2.0/repositories/acme/auto-ok/branch-restrictions';
    expect((await get(fake, `${base}?kind=force`)).body.size).toBe(1);
    expect((await get(fake, `${base}?pattern=release/*`)).body.size).toBe(1);
    const post = (b: unknown) =>
      fake.app.request(base, {
        method: 'POST',
        headers: { ...HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify(b),
      });
    const created = await post({
      kind: 'push',
      pattern: '*',
      users: [{ nickname: 'alice' }],
      groups: [{ slug: 'developers' }],
    });
    expect(created.status).toBe(201);
    const c = (await created.json()) as { id: number; users: unknown[]; groups: unknown[] };
    expect(c.users).toHaveLength(1);
    expect(c.groups).toHaveLength(1);
    expect((await get(fake, `${base}/${c.id}`)).res.status).toBe(200);
    expect(
      (await fake.app.request(`${base}/${c.id}`, { method: 'DELETE', headers: HEADERS })).status,
    ).toBe(204);
    expect((await get(fake, `${base}/${c.id}`)).res.status).toBe(404);
    expect(
      (await fake.app.request(`${base}/999`, { method: 'DELETE', headers: HEADERS })).status,
    ).toBe(404);
    expect((await post({ kind: 'bogus', pattern: '*' })).status).toBe(400);
    expect((await post({ kind: 'push' })).status).toBe(400);
    expect((await post({ kind: 'push', pattern: '*', branch_match_kind: 'x' })).status).toBe(400);
    expect((await post({ kind: 'push', pattern: '*', users: [{ uuid: '{none}' }] })).status).toBe(
      400,
    );
    expect((await post({ kind: 'push', pattern: '*', groups: [{ slug: 'none' }] })).status).toBe(
      400,
    );
    const bad = await fake.app.request(base, {
      method: 'POST',
      headers: HEADERS,
      body: 'not json',
    });
    expect(bad.status).toBe(400);
    expect(
      (
        await post({
          kind: 'require_commits_behind',
          branch_match_kind: 'branching_model',
          branch_type: 'production',
          value: 2,
        })
      ).status,
    ).toBe(201);
  });

  it('[TST-010] the source read-only step: a push restriction on * created through the API is listed', async () => {
    const { fake } = setup();
    const base = '/2.0/repositories/acme/empty-repo/branch-restrictions';
    await fake.app.request(base, {
      method: 'POST',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'push', pattern: '*' }),
    });
    const { body } = await get(fake, `${base}?kind=push`);
    expect(body.values).toHaveLength(1);
  });

  it('[TST-010] merge strategies and default strategy are served per branch', async () => {
    const { fake } = setup();
    const { body } = await get(fake, '/2.0/repositories/acme/auto-ok/refs/branches/feature%2Fx');
    expect(body.default_merge_strategy).toBe('squash');
    expect(body.merge_strategies).toEqual(['merge_commit', 'squash', 'fast_forward']);
  });

  it('[TST-010] default_branch_deletion is a string, outside the schema, and survives as configured', async () => {
    const { fake, repo } = setup();
    repo.branchingModel.defaultBranchDeletion = 'true';
    const { body } = await get(fake, '/2.0/repositories/acme/auto-ok/branching-model/settings');
    expect(body.default_branch_deletion).toBe('true');
    expect(body.default_branch_deletion).toBeTypeOf('string');
    // the schema check would fail without the documented exemption
    expect(
      validateAgainstSpec(
        'get',
        '/repositories/{workspace}/{repo_slug}/branching-model/settings',
        200,
        body,
      ).errors,
    ).toEqual([]);
  });

  it('[TST-010] empty repositories have no main branch, no branches and no source', async () => {
    const { fake } = setup();
    const { body } = await get(fake, '/2.0/repositories/acme/empty-repo');
    expect(body.mainbranch).toBeNull();
    expect(
      (await get(fake, '/2.0/repositories/acme/empty-repo/src/main/bitbucket-pipelines.yml')).res
        .status,
    ).toBe(404);
    expect(
      (await get(fake, '/2.0/repositories/acme/empty-repo/refs/branches/main')).res.status,
    ).toBe(404);
  });

  it('[TST-010] src serves files as text, directories as listings, and 404 for missing paths or refs', async () => {
    const { fake, repo } = setup();
    const f = await get(fake, '/2.0/repositories/acme/auto-ok/src/main/bitbucket-pipelines.yml');
    expect(f.res.status).toBe(200);
    expect(f.res.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(f.body).toBe('pipelines: {}\n');
    const root = await get(fake, '/2.0/repositories/acme/auto-ok/src/main/');
    expect(
      (root.body.values as { path: string; type: string }[])
        .map((v) => `${v.type}:${v.path}`)
        .sort(),
    ).toEqual(['commit_directory:src', 'commit_file:bitbucket-pipelines.yml']);
    const dir = await get(fake, '/2.0/repositories/acme/auto-ok/src/main/src');
    expect((dir.body.values as { path: string }[]).map((v) => v.path).sort()).toEqual([
      'src/a.txt',
      'src/b',
    ]);
    expect(
      (await get(fake, '/2.0/repositories/acme/auto-ok/src/main/missing.yml')).res.status,
    ).toBe(404);
    expect(
      (await get(fake, '/2.0/repositories/acme/auto-ok/src/nope/bitbucket-pipelines.yml')).res
        .status,
    ).toBe(404);
    const head = repo.branches[0]?.hash ?? '';
    expect((await get(fake, `/2.0/repositories/acme/auto-ok/src/${head}/src/a.txt`)).body).toBe(
      'a',
    );
    expect((await get(fake, '/2.0/repositories/acme/auto-ok/src/HEAD/src/a.txt')).body).toBe('a');
  });

  it('[TST-010] issues: count via size, 404 when the tracker is off', async () => {
    const { fake } = setup();
    expect(
      (await get(fake, '/2.0/repositories/acme/auto-ok/issues?pagelen=1&fields=size')).body,
    ).toEqual({ size: 3 });
    const none = await get(fake, '/2.0/repositories/acme/empty-repo/issues?pagelen=1&fields=size');
    expect(none.res.status).toBe(404);
  });

  it('[TST-010] effective permissions combine direct, project, group and workspace-admin grants', async () => {
    const { fake, alice, bob } = setup();
    const { body } = await get(fake, '/2.0/workspaces/acme/permissions/repositories/auto-ok');
    const byUser = Object.fromEntries(
      (body.values as { user: { account_id: string }; permission: string }[]).map((v) => [
        v.user.account_id,
        v.permission,
      ]),
    );
    expect(byUser[alice.accountId]).toBe('admin');
    // bob: project write + project group create-repo + repo group write, group default read
    expect(byUser[bob.accountId]).toBe('write');
  });

  it('[TST-010] effective default reviewers and the effective branching model', async () => {
    const { fake, alice } = setup();
    const r = await get(fake, '/2.0/repositories/acme/auto-ok/effective-default-reviewers');
    expect((r.body.values as { user: { account_id: string } }[])[0]?.user.account_id).toBe(
      alice.accountId,
    );
    const m = await get(fake, '/2.0/repositories/acme/auto-ok/effective-branching-model');
    expect(m.body.development).toMatchObject({ name: 'main', use_mainbranch: true });
  });

  it('[TST-010] repository links point clone URLs at the git server (seam) and state keeps the git root', async () => {
    const { fake } = setup({ gitBaseUrl: 'http://git.test:4030' });
    const { body } = await get(fake, '/2.0/repositories/acme/auto-ok');
    const clone = (body.links as unknown as { clone: { href: string }[] }).clone[0]?.href;
    expect(clone).toBe('http://git.test:4030/acme/auto-ok.git');
    const state = (await get(fake, '/__state')).body as unknown as {
      state: { workspaces: { repositories: { gitRoot: string }[] }[] };
    };
    expect(state.state.workspaces[0]?.repositories[0]?.gitRoot).toBe('/srv/git/acme/auto-ok.git');
  });
});

describe('[TST-010] repository PUT quirks', () => {
  const put = (fake: FakeBitbucket, slug: string, body: unknown) =>
    fake.app.request(`/2.0/repositories/acme/${slug}`, {
      method: 'PUT',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('[TST-010] PUT on a missing slug returns 201 and CREATES the repository', async () => {
    const { fake } = setup();
    const res = await put(fake, 'ghost', { description: 'boo' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { slug: string; description: string };
    expect(body).toMatchObject({ slug: 'ghost', description: 'boo' });
    expect((await get(fake, '/2.0/repositories/acme/ghost')).res.status).toBe(200);
  });

  it('[TST-010] PUT create honours the body and rejects unknown workspaces or projects', async () => {
    const { fake } = setup();
    const res = await put(fake, 'made', {
      name: 'Made',
      is_private: false,
      fork_policy: 'no_forks',
      project: { key: 'DATA' },
      mainbranch: { name: 'trunk' },
      has_issues: true,
      has_wiki: true,
      language: 'ts',
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      is_private: false,
      fork_policy: 'no_forks',
      has_issues: true,
      has_wiki: true,
      language: 'ts',
      mainbranch: { name: 'trunk' },
      project: { key: 'DATA' },
    });
    expect((await put(fake, 'x', { project: { key: 'NOPE' } })).status).toBe(400);
    expect((await put(fake, 'x', { fork_policy: 'bogus' })).status).toBe(400);
    const gone = await fake.app.request('/2.0/repositories/nope/x', {
      method: 'PUT',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(gone.status).toBe(404);
  });

  it('[TST-010] PUT create without any project in the workspace is a 400', async () => {
    const fake = createFakeBitbucket();
    fake.state.addWorkspace({ slug: 'bare' });
    fake.state.addCredentialMembers('bare');
    const res = await fake.app.request('/2.0/repositories/bare/x', {
      method: 'PUT',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(400);
  });

  it('[TST-010] PUT with only a description updates it and leaves the rest alone (merge)', async () => {
    const { fake } = setup();
    const res = await put(fake, 'auto-ok', { description: '[migrated] hello' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      description: '[migrated] hello',
      is_private: true,
      project: { key: 'PLAT' },
      mainbranch: { name: 'main' },
    });
  });

  it('[TST-010] reset-omitted semantics model the hazard of a partial PUT', async () => {
    const { fake, repo } = setup({ putSemantics: 'reset-omitted' });
    repo.isPrivate = false;
    repo.forkPolicy = 'allow_forks';
    const res = await put(fake, 'auto-ok', { description: 'd' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      is_private: true,
      fork_policy: 'no_public_forks',
      mainbranch: null,
    });
  });

  it('[TST-010] changing name changes the slug', async () => {
    const { fake } = setup();
    const res = await put(fake, 'auto-ok', { name: 'Renamed Repo' });
    expect(((await res.json()) as { slug: string }).slug).toBe('renamed-repo');
    expect((await get(fake, '/2.0/repositories/acme/auto-ok')).res.status).toBe(404);
    expect((await get(fake, '/2.0/repositories/acme/renamed-repo')).res.status).toBe(200);
  });
});

describe('[TST-010] /1.0/groups is removable', () => {
  it('[TST-010] serves groups with members and default permission when enabled', async () => {
    const { fake, bob } = setup();
    const { res, body } = await get(fake, '/1.0/groups/acme');
    expect(res.status).toBe(200);
    expect(body).toMatchObject([
      {
        name: 'Developers',
        slug: 'developers',
        permission: 'read',
        members: [{ account_id: bob.accountId }],
      },
    ]);
  });

  it('[TST-010] answers 404 or 410 when removed, at construction, at runtime and on reset', async () => {
    const a = setup({ groupsEndpoint: 'not-found' });
    expect((await get(a.fake, '/1.0/groups/acme')).res.status).toBe(404);
    const b = setup({ groupsEndpoint: 'gone' });
    expect((await get(b.fake, '/1.0/groups/acme')).res.status).toBe(410);
    const c = setup();
    await c.fake.app.request('/__config', {
      method: 'POST',
      body: JSON.stringify({ groupsEndpoint: 'not-found' }),
    });
    expect((await get(c.fake, '/1.0/groups/acme')).res.status).toBe(404);
    await c.fake.app.request('/__reset', {
      method: 'POST',
      body: JSON.stringify({ fixture: 'empty', groupsEndpoint: 'gone' }),
    });
    expect((await get(c.fake, '/1.0/groups/acme')).res.status).toBe(410);
    await c.fake.app.request('/__reset', { method: 'POST' });
    c.fake.state.addWorkspace({ slug: 'acme' });
    c.fake.state.addCredentialMembers('acme');
    expect((await get(c.fake, '/1.0/groups/acme')).res.status).toBe(200);
  });
});

describe('[JOB-043] rate limits: 429 at the documented limits, never any rate-limit headers', () => {
  function clocked(options: FakeBitbucketOptions = {}) {
    const clock = { t: 1_000_000 };
    const ctx = setup({ ...options, now: () => clock.t });
    return { ...ctx, clock };
  }
  const noRateHeaders = (res: Response) =>
    [...res.headers.keys()].filter((k) => /ratelimit|rate-limit|retry/i.test(k));

  it('[TST-010] defaults match JOB-043 (repository-data, webhooks, raw-files, app-properties)', async () => {
    const { fake } = setup();
    const snap = (await get(fake, '/__state')).body;
    expect(snap.limits.limits).toEqual({
      'repository-data': 1000,
      webhooks: 1000,
      'raw-files': 5000,
      'app-properties': 2000,
    });
    expect(snap.limits.windowMs).toBe(3_600_000);
  });

  it('[TST-010] returns 429 once the limit is hit, without rate-limit headers, and recovers after the window', async () => {
    const { fake, clock } = clocked({
      limits: { limits: { 'repository-data': 3 }, windowMs: 1000 },
    });
    for (let i = 0; i < 3; i++) {
      const { res } = await get(fake, '/2.0/repositories/acme/auto-ok');
      expect(res.status).toBe(200);
      expect(noRateHeaders(res)).toEqual([]);
    }
    const blocked = await get(fake, '/2.0/repositories/acme/auto-ok');
    expect(blocked.res.status).toBe(429);
    expect(noRateHeaders(blocked.res)).toEqual([]);
    expect(blocked.body.type).toBe('error');
    clock.t += 999;
    expect((await get(fake, '/2.0/repositories/acme/auto-ok')).res.status).toBe(429);
    clock.t += 2;
    expect((await get(fake, '/2.0/repositories/acme/auto-ok')).res.status).toBe(200);
  });

  it('[JOB-043] every /2.0 and /1.0 path not listed separately is repository-data', async () => {
    const { fake } = clocked({ limits: { limits: { 'repository-data': 1 } } });
    // /2.0/user, workspaces, members, projects, permissions, pipelines-config and /1.0/groups
    const paths = [
      '/2.0/user',
      '/2.0/workspaces/acme/projects',
      '/2.0/workspaces/acme/members',
      '/2.0/workspaces/acme/permissions/repositories/auto-ok',
      '/2.0/workspaces/acme/pipelines-config/variables',
      '/1.0/groups/acme',
      '/2.0/does-not-exist',
    ];
    for (const p of paths) {
      fake.limiter.clearUsage();
      expect((await get(fake, p)).res.status, p).not.toBe(429);
      expect((await get(fake, p)).res.status, p).toBe(429);
    }
  });

  it('[JOB-043] raw file downloads are counted in raw-files AND repository-data, atomically', async () => {
    const { fake } = clocked({
      limits: { limits: { 'raw-files': 2, 'repository-data': 3 } },
    });
    const raw = '/2.0/repositories/acme/auto-ok/src/main/src/a.txt';
    expect((await get(fake, raw)).res.status).toBe(200); // raw 1, repo 1
    expect((await get(fake, '/2.0/repositories/acme/auto-ok')).res.status).toBe(200); // repo 2
    expect((await get(fake, raw)).res.status).toBe(200); // raw 2, repo 3
    expect((await get(fake, raw)).res.status).toBe(429); // raw exhausted
    // the rejected request recorded nothing in repository-data either: still blocked by repo=3
    expect((await get(fake, '/2.0/repositories/acme/auto-ok')).res.status).toBe(429);
    const used = (await get(fake, '/__state')).body.limits.used;
    expect(Object.values(used).sort()).toEqual([2, 3]);
  });

  it('[JOB-043] directory listings under src are repository-data only', async () => {
    const { fake } = clocked({ limits: { limits: { 'raw-files': 0, 'repository-data': 5 } } });
    expect((await get(fake, '/2.0/repositories/acme/auto-ok/src/main/src')).res.status).toBe(200);
    expect((await get(fake, '/2.0/repositories/acme/auto-ok/src/main/src/a.txt')).res.status).toBe(
      429,
    );
  });

  it('[JOB-043] hooks (repository and workspace) have their own group and are not repository-data', async () => {
    const { fake } = clocked({
      limits: { limits: { webhooks: 2, 'repository-data': 0 } },
    });
    expect((await get(fake, '/2.0/workspaces/acme/hooks')).res.status).toBe(200);
    expect((await get(fake, '/2.0/repositories/acme/auto-ok/hooks')).res.status).toBe(200);
    expect((await get(fake, '/2.0/workspaces/acme/hooks')).res.status).toBe(429);
    expect((await get(fake, '/2.0/repositories/acme/auto-ok')).res.status).toBe(429);
  });

  it('[JOB-043] /properties/** is app-properties', async () => {
    const { fake } = clocked({ limits: { limits: { 'app-properties': 1, 'repository-data': 0 } } });
    const p = '/2.0/repositories/acme/auto-ok/properties/app/key';
    expect((await get(fake, p)).res.status).toBe(404);
    expect((await get(fake, p)).res.status).toBe(429);
    expect((await get(fake, '/2.0/repositories/acme/auto-ok')).res.status).toBe(429);
  });

  it('[TST-010] limits are per account (shared across credentials with the same accountId)', async () => {
    const { fake } = clocked({
      credentials: [
        { email: 'a@x.test', token: 't1', accountId: 'acct-A' },
        { email: 'b@x.test', token: 't2', accountId: 'acct-B' },
        { email: 'a2@x.test', token: 't3', accountId: 'acct-A' },
      ],
      limits: { limits: { 'repository-data': 2 } },
    });
    fake.state.addWorkspace({ slug: 'acme' });
    fake.state.addCredentialMembers('acme');
    fake.state.addProject('acme', { key: 'P' });
    fake.state.addRepository('acme', { slug: 'r', projectKey: 'P' });
    const as = (email: string, token: string) => ({
      Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
    });
    const A = as('a@x.test', 't1');
    const A2 = as('a2@x.test', 't3');
    const B = as('b@x.test', 't2');
    expect((await get(fake, '/2.0/repositories/acme/r', A)).res.status).toBe(200);
    expect((await get(fake, '/2.0/repositories/acme/r', A2)).res.status).toBe(200);
    expect((await get(fake, '/2.0/repositories/acme/r', A)).res.status).toBe(429);
    expect((await get(fake, '/2.0/repositories/acme/r', B)).res.status).toBe(200);
  });

  it('[TST-010] unauthenticated requests are not counted against anyone', async () => {
    const { fake } = clocked({ limits: { limits: { 'repository-data': 1 } } });
    for (let i = 0; i < 3; i++) {
      expect((await get(fake, '/2.0/repositories/acme/auto-ok', {})).res.status).toBe(401);
    }
    expect((await get(fake, '/2.0/repositories/acme/auto-ok')).res.status).toBe(200);
  });

  it('[TST-010] limits are configurable per test over HTTP, including null to disable', async () => {
    const { fake } = setup();
    const post = (path: string, body: unknown) =>
      fake.app.request(path, { method: 'POST', body: JSON.stringify(body) });
    expect((await post('/__config', { limits: { 'repository-data': 1 } })).status).toBe(200);
    expect((await get(fake, '/2.0/repositories/acme/auto-ok')).res.status).toBe(200);
    expect((await get(fake, '/2.0/repositories/acme/auto-ok')).res.status).toBe(429);
    const used = (await get(fake, '/__state')).body.limits.used;
    expect(Object.values(used)).toEqual([1]);
    await post('/__config', { limits: { 'repository-data': null } });
    for (let i = 0; i < 5; i++) {
      expect((await get(fake, '/2.0/repositories/acme/auto-ok')).res.status).toBe(200);
    }
    expect((await post('/__config', { limits: { repository: 1 } })).status).toBe(400);
    expect((await post('/__config', { limits: { git: 1 } })).status).toBe(400);
    expect((await post('/__config', { limits: { webhooks: -1 } })).status).toBe(400);
    expect((await post('/__config', { limits: 5 })).status).toBe(400);
    expect((await post('/__config', { groupsEndpoint: 'x' })).status).toBe(400);
    expect((await post('/__config', { putSemantics: 'x' })).status).toBe(400);
    for (const windowMs of [0, -5, 'x', null]) {
      expect((await post('/__config', { limits: { windowMs } })).status, String(windowMs)).toBe(
        400,
      );
    }
    expect(
      (await post('/__config', { putSemantics: 'reset-omitted', limits: { windowMs: 5 } })).status,
    ).toBe(200);
    expect(fake.config.putSemantics).toBe('reset-omitted');
  });

  it('[TST-010] clearUsage forgets counters but keeps limits configured earlier', async () => {
    const { fake } = setup();
    const post = (body: unknown) =>
      fake.app.request('/__config', { method: 'POST', body: JSON.stringify(body) });
    await post({ limits: { 'repository-data': 1, windowMs: 60_000 } });
    expect((await get(fake, '/2.0/repositories/acme/auto-ok')).res.status).toBe(200);
    expect((await get(fake, '/2.0/repositories/acme/auto-ok')).res.status).toBe(429);
    await post({ clearUsage: true });
    const snap = (await get(fake, '/__state')).body.limits;
    expect(snap.limits['repository-data']).toBe(1);
    expect(snap.windowMs).toBe(60_000);
    expect(snap.used).toEqual({});
    expect((await get(fake, '/2.0/repositories/acme/auto-ok')).res.status).toBe(200);
    expect((await get(fake, '/2.0/repositories/acme/auto-ok')).res.status).toBe(429);
  });

  it('[TST-010] POST /__reset can carry limits for the next test, and plain reset restores the options', async () => {
    const { fake } = setup({ limits: { limits: { 'repository-data': 7 } } });
    await fake.app.request('/__reset', {
      method: 'POST',
      body: JSON.stringify({ limits: { 'repository-data': 1, windowMs: 100 } }),
    });
    expect((await get(fake, '/__state')).body.limits).toMatchObject({
      windowMs: 100,
      limits: { 'repository-data': 1 },
    });
    await fake.app.request('/__reset', { method: 'POST' });
    expect((await get(fake, '/__state')).body.limits.limits['repository-data']).toBe(7);
  });
});

describe('[TST-010] API token scopes and workspace access', () => {
  const READ_ONLY = [
    'read:user:bitbucket',
    'read:workspace:bitbucket',
    'read:project:bitbucket',
    'read:repository:bitbucket',
    'read:pullrequest:bitbucket',
    'read:pipeline:bitbucket',
    'read:webhook:bitbucket',
  ];
  function withScopes(scopes?: string[]) {
    const ctx = setup({
      credentials: [{ email: 'scoped@x.test', token: 'tok', ...(scopes ? { scopes } : {}) }],
    });
    ctx.state.addCredentialMembers('acme');
    const headers = {
      Authorization: `Basic ${Buffer.from('scoped@x.test:tok').toString('base64')}`,
    };
    return { ...ctx, headers };
  }

  it('[TST-010] a credential without scopes has every scope', async () => {
    const { fake, headers } = withScopes();
    expect(
      (await get(fake, '/2.0/repositories/acme/auto-ok/branch-restrictions', headers)).res.status,
    ).toBe(200);
  });

  it('[TST-010] the admin-only endpoints answer 403 without admin scopes, with the Bitbucket error shape', async () => {
    const { fake, headers } = withScopes(READ_ONLY);
    const adminOnly: [string, string][] = [
      ['GET', '/2.0/repositories/acme/auto-ok/branch-restrictions'],
      ['GET', '/2.0/repositories/acme/auto-ok/branch-restrictions/1'],
      ['POST', '/2.0/repositories/acme/auto-ok/branch-restrictions'],
      ['DELETE', '/2.0/repositories/acme/auto-ok/branch-restrictions/1'],
      ['PUT', '/2.0/repositories/acme/auto-ok'],
      ['GET', '/2.0/repositories/acme/auto-ok/pipelines_config'],
      ['GET', '/2.0/repositories/acme/auto-ok/deploy-keys'],
      ['GET', '/2.0/repositories/acme/auto-ok/branching-model/settings'],
      ['GET', '/2.0/workspaces/acme/projects/PLAT/deploy-keys'],
      ['GET', '/2.0/workspaces/acme/projects/PLAT/branching-model/settings'],
    ];
    for (const [method, path] of adminOnly) {
      const res = await fake.app.request(path, {
        method,
        headers: { ...headers, 'content-type': 'application/json' },
        ...(method === 'GET' || method === 'DELETE' ? {} : { body: '{}' }),
      });
      expect(res.status, `${method} ${path}`).toBe(403);
      const body = (await res.json()) as Loose;
      expect(body.type).toBe('error');
      expect(body.error.message).toMatch(/privilege scopes/);
      expect(body.error.detail.granted).toEqual(READ_ONLY);
      expect(body.error.detail.required.length).toBeGreaterThan(0);
    }
  });

  it('[TST-010] admin:repository grants the repository endpoints, but admin:project is separate', async () => {
    const { fake, headers } = withScopes(['admin:repository:bitbucket']);
    const ok = [
      '/2.0/repositories/acme/auto-ok/branch-restrictions',
      '/2.0/repositories/acme/auto-ok/pipelines_config',
      '/2.0/repositories/acme/auto-ok/deploy-keys',
      '/2.0/repositories/acme/auto-ok/branching-model/settings',
    ];
    for (const p of ok) expect((await get(fake, p, headers)).res.status, p).toBe(200);
    expect(
      (await get(fake, '/2.0/workspaces/acme/projects/PLAT/deploy-keys', headers)).res.status,
    ).toBe(403);
    const project = withScopes(['admin:project:bitbucket']);
    expect(
      (await get(project.fake, '/2.0/workspaces/acme/projects/PLAT/deploy-keys', project.headers))
        .res.status,
    ).toBe(200);
    expect(
      (
        await get(
          project.fake,
          '/2.0/workspaces/acme/projects/PLAT/branching-model/settings',
          project.headers,
        )
      ).res.status,
    ).toBe(200);
    expect(
      (await get(project.fake, '/2.0/repositories/acme/auto-ok/deploy-keys', project.headers)).res
        .status,
    ).toBe(403);
  });

  it('[TST-010] scopes do not imply each other: write or admin does not grant read', async () => {
    const { fake, headers } = withScopes([
      'write:repository:bitbucket',
      'admin:repository:bitbucket',
    ]);
    expect((await get(fake, '/2.0/repositories/acme/auto-ok', headers)).res.status).toBe(403);
    expect((await get(fake, '/2.0/user', headers)).res.status).toBe(403);
  });

  it('[TST-010] read scopes are enough for the read endpoints (and the PR/issue/hook lists)', async () => {
    const { fake, headers } = withScopes([...READ_ONLY, 'read:issue:bitbucket']);
    for (const p of [
      '/2.0/user',
      '/2.0/workspaces/acme/members',
      '/2.0/workspaces/acme/projects',
      '/2.0/repositories/acme/auto-ok/pullrequests',
      '/2.0/repositories/acme/auto-ok/issues?pagelen=1&fields=size',
      '/2.0/repositories/acme/auto-ok/hooks',
      '/2.0/repositories/acme/auto-ok/src/main/src/a.txt',
    ]) {
      expect((await get(fake, p, headers)).res.status, p).toBe(200);
    }
    const narrow = withScopes(['read:repository:bitbucket']);
    expect(
      (await get(narrow.fake, '/2.0/repositories/acme/auto-ok/environments', narrow.headers)).res
        .status,
    ).toBe(403);
  });

  it('[TST-010] scopes are shown in /__state, tokens stay redacted', async () => {
    const { fake } = withScopes(['read:user:bitbucket']);
    const text = await (await fake.app.request('/__state')).text();
    expect(text).toContain('read:user:bitbucket');
    expect(text).not.toContain('"tok"');
  });

  it('[TST-010] every scope in the table matches x-atlassian-oauth2-scopes of the saved OpenAPI document', () => {
    const spec = JSON.parse(
      readFileSync(new URL('../../specs/bitbucket-cloud.openapi.json', import.meta.url), 'utf8'),
    ) as Loose;
    for (const [key, scopes] of Object.entries(REQUIRED_SCOPES)) {
      if (SCOPES_NOT_IN_SPEC.includes(key)) continue;
      const [method, template] = key.split(' ') as [string, string];
      const op = spec.paths[template]?.[method.toLowerCase()];
      expect(op, key).toBeDefined();
      expect([...scopes].sort(), key).toEqual(
        [...op['x-atlassian-oauth2-scopes'][0].scopes].sort(),
      );
    }
    for (const key of SCOPES_NOT_IN_SPEC) {
      const [method, template] = key.split(' ') as [string, string];
      expect(spec.paths[template]?.[method.toLowerCase()], key).toBeUndefined();
    }
  });

  it('[TST-010] every implemented route has a scope entry (except /1.0 groups, not in the reference)', async () => {
    const { fake } = setup();
    const routes = new Set(
      fake.app.routes
        .filter((r) => r.path.startsWith('/2.0') && r.method !== 'ALL')
        .map((r) => `${r.method} ${toTemplate(r.path)}`),
    );
    expect(routes.size).toBeGreaterThan(20);
    for (const r of routes) expect(REQUIRED_SCOPES[r], r).toBeDefined();
  });

  it('[TST-010] an account that is not a member of the workspace gets 403 on it, but unknown workspaces stay 404', async () => {
    const { fake } = setup({
      credentials: [{ email: 'outsider@x.test', token: 'tok' }],
    });
    const ws = fake.state.workspace('acme');
    if (ws) ws.members = [];
    const headers = {
      Authorization: `Basic ${Buffer.from('outsider@x.test:tok').toString('base64')}`,
    };
    for (const p of [
      '/2.0/repositories/acme',
      '/2.0/repositories/acme/auto-ok',
      '/2.0/workspaces/acme/projects',
      '/2.0/workspaces/acme/members',
      '/1.0/groups/acme',
    ]) {
      expect((await get(fake, p, headers)).res.status, p).toBe(403);
    }
    expect((await get(fake, '/2.0/repositories/nope', headers)).res.status).toBe(404);
    expect((await get(fake, '/2.0/user', headers)).res.status).toBe(200);
  });
});

describe('[TST-010] /__reset and /__state', () => {
  it('[TST-010] reset with the empty fixture wipes state and keeps the credentials', async () => {
    const { fake } = setup();
    const res = await fake.app.request('/__reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fixture: 'empty' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, fixture: 'empty' });
    const { body } = await get(fake, '/__state');
    const st = body.state as unknown as {
      workspaces: unknown[];
      users: unknown[];
      credentials: unknown[];
    };
    expect(st.workspaces).toEqual([]);
    expect(st.users).toHaveLength(1);
    expect(st.credentials).toHaveLength(1);
    expect((await get(fake, '/2.0/repositories/acme')).res.status).toBe(404);
    expect((await get(fake, '/2.0/user')).res.status).toBe(200);
  });

  it('[TST-010] an empty body or empty fixture name means empty; /__ endpoints need no auth', async () => {
    const { fake } = setup();
    expect((await fake.app.request('/__reset', { method: 'POST' })).status).toBe(200);
    expect(
      (
        await fake.app.request('/__reset', {
          method: 'POST',
          body: JSON.stringify({ fixture: '' }),
        })
      ).status,
    ).toBe(200);
    expect((await fake.app.request('/__state')).status).toBe(200);
  });

  it('[TST-010] unknown fixtures and invalid JSON are 400 and leave the state alone', async () => {
    const { fake } = setup();
    const unknown = await fake.app.request('/__reset', {
      method: 'POST',
      body: JSON.stringify({ fixture: 'world' }),
    });
    expect(unknown.status).toBe(400);
    expect(JSON.stringify(await unknown.json())).toContain('Known: empty');
    expect((await fake.app.request('/__reset', { method: 'POST', body: '{nope' })).status).toBe(
      400,
    );
    expect((await get(fake, '/2.0/repositories/acme/auto-ok')).res.status).toBe(200);
  });

  it('[TST-010] registered fixtures build into freshly reset state (the T-043 hook)', async () => {
    const fake = createFakeBitbucket({
      fixtures: {
        tiny: (state) => {
          state.addWorkspace({ slug: 'acme' });
          state.addCredentialMembers('acme');
          state.addProject('acme', { key: 'PLAT' });
          state.addRepository('acme', { slug: 'one', projectKey: 'PLAT' });
        },
      },
    });
    await fake.app.request('/__reset', {
      method: 'POST',
      body: JSON.stringify({ fixture: 'tiny' }),
    });
    expect((await get(fake, '/2.0/repositories/acme')).body.size).toBe(1);
    expect(((await get(fake, '/__state')).body as { fixture?: string }).fixture).toBe('tiny');
    await fake.app.request('/__reset', {
      method: 'POST',
      body: JSON.stringify({ fixture: 'tiny' }),
    });
    // ids restart, so a second reset yields the identical world
    expect((await get(fake, '/2.0/repositories/acme')).body.size).toBe(1);
  });

  it('[TST-010] /__state redacts API tokens and exposes records for assertions', async () => {
    const { fake } = setup();
    const text = await (await fake.app.request('/__state')).text();
    expect(text).not.toContain('fake-bitbucket-api-token');
    expect(text).toContain('<redacted>');
    expect(text).toContain('topsecret'); // fixture data, not a credential
    expect(JSON.parse(text).state.workspaces[0].repositories[0].branchRestrictions.length).toBe(4);
  });

  it('[TST-010] state builders reject unknown parents and are deterministic across resets', () => {
    const { state } = setup();
    expect(() => state.addProject('nope', { key: 'X' })).toThrow(/unknown workspace/);
    expect(() => state.addBranch('acme', 'nope', 'x')).toThrow(/unknown repository/);
    expect(() => state.addEnvironmentVariable('acme', 'auto-ok', 'nope', { key: 'k' })).toThrow(
      /unknown environment/,
    );
    expect(() => state.grantProjectUser('acme', 'NOPE', 'a', 'read')).toThrow(/unknown project/);
    expect(() => state.addProjectDeployKey('acme', 'NOPE', { key: 'k' })).toThrow(
      /unknown project/,
    );
    state.reset();
    const w1 = state.addWorkspace({ slug: 'acme' });
    state.reset();
    const w2 = state.addWorkspace({ slug: 'acme' });
    expect(w1.uuid).toBe(w2.uuid);
  });
});

describe('[TST-010] review hardening', () => {
  const post = (
    fake: FakeBitbucket,
    body: unknown,
    path = '/2.0/repositories/acme/auto-ok/branch-restrictions',
  ) =>
    fake.app.request(path, {
      method: 'POST',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('[TST-010] effective permissions take the highest group grant across repository and project', async () => {
    const { fake, state, bob, devs } = setup();
    // repository grant (write) is lower than the project grant (create-repo => write); raise the project to admin
    state.project('acme', 'PLAT').groupPermissions.push({ slug: devs.slug, permission: 'admin' });
    state.repository('acme', 'auto-ok')?.groupPermissions.splice(0);
    state.grantRepositoryGroup('acme', 'auto-ok', devs.slug, 'read');
    // bob's direct grants are read-ish only; user grants removed to isolate the group path
    state.project('acme', 'PLAT').userPermissions = [];
    const { body } = await get(fake, '/2.0/workspaces/acme/permissions/repositories/auto-ok');
    const perm = (body.values as Loose[]).find(
      (v) => v.user.account_id === bob.accountId,
    )?.permission;
    expect(perm).toBe('admin');
    // and the other way round: repo grant admin beats project read
    state.project('acme', 'PLAT').groupPermissions = [{ slug: devs.slug, permission: 'read' }];
    state.repository('acme', 'auto-ok')?.groupPermissions.splice(0);
    state.grantRepositoryGroup('acme', 'auto-ok', devs.slug, 'admin');
    const again = await get(fake, '/2.0/workspaces/acme/permissions/repositories/auto-ok');
    expect(
      (again.body.values as Loose[]).find((v) => v.user.account_id === bob.accountId)?.permission,
    ).toBe('admin');
  });

  it('[TST-010] branch restriction POST validates its input with 400 and the error shape, never 500', async () => {
    const { fake } = setup();
    const bad: unknown[] = [
      { kind: 'push', pattern: 'x', users: 'alice' },
      { kind: 'push', pattern: 'x', users: [null] },
      { kind: 'push', pattern: 'x', users: {} },
      { kind: 'push', pattern: 'x', groups: ['developers'] },
      { kind: 'push', pattern: 'x', groups: [[]] },
      { kind: 'require_commits_behind', pattern: 'x' },
      { kind: 'require_commits_behind', pattern: 'x', value: 'many' },
      { kind: 'require_commits_behind', pattern: 'x', value: -1 },
      { kind: 'push', pattern: 'x', value: 'many' },
      { kind: 'push', branch_match_kind: 'branching_model' },
      { kind: 'push', branch_match_kind: 'branching_model', branch_type: 'bogus' },
      { kind: 'push', pattern: 5 },
    ];
    for (const b of bad) {
      const res = await post(fake, b);
      expect(res.status, JSON.stringify(b)).toBe(400);
      expect(((await res.json()) as Loose).type).toBe('error');
    }
  });

  it('[TST-010] a duplicate restriction (same kind, pattern and match kind) is a 400', async () => {
    const { fake } = setup();
    expect((await post(fake, { kind: 'push', pattern: 'dup' })).status).toBe(201);
    const dup = await post(fake, { kind: 'push', pattern: 'dup' });
    expect(dup.status).toBe(400);
    expect(JSON.stringify(await dup.json())).toMatch(/already exists/);
    // different kind or pattern is fine
    expect((await post(fake, { kind: 'delete', pattern: 'dup' })).status).toBe(201);
    expect((await post(fake, { kind: 'push', pattern: 'dup2' })).status).toBe(201);
    // the fixture already has force on '*'
    expect((await post(fake, { kind: 'force', pattern: '*' })).status).toBe(400);
  });

  it('[TST-010] PUT rejects slugs that are not slugified and rename collisions', async () => {
    const { fake } = setup();
    const put = (slug: string, body: unknown) =>
      fake.app.request(`/2.0/repositories/acme/${slug}`, {
        method: 'PUT',
        headers: { ...HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    for (const slug of ['Has-Upper', 'a%20b', 'a%2Fb', '-lead', 'trail-']) {
      expect((await put(slug, { project: { key: 'DATA' } })).status, slug).toBe(400);
    }
    expect((await get(fake, '/2.0/repositories/acme')).body.size).toBe(2);
    const collide = await put('auto-ok', { name: 'Empty Repo', description: 'must not apply' });
    expect(collide.status).toBe(409);
    const unchanged = (await get(fake, '/2.0/repositories/acme/auto-ok')).body;
    expect(unchanged.description).toBe('hello');
    expect(unchanged.name).toBe('auto-ok');
    expect((await put('auto-ok', { name: '!!!' })).status).toBe(400);
    // renaming to a name that slugifies to the same slug is allowed
    expect((await put('auto-ok', { name: 'auto-ok' })).status).toBe(200);
  });

  it('[TST-010] q and sort apply only where the OpenAPI document defines them', async () => {
    const { fake } = setup();
    // projects documents neither: parameters are ignored
    const ignored = await get(
      fake,
      '/2.0/workspaces/acme/projects?q=nonsense%3D%22x%22&sort=-bogus',
    );
    expect(ignored.res.status).toBe(200);
    expect(ignored.body.size).toBe(2);
    // repositories document both: unknown fields are 400
    expect(
      (await get(fake, `/2.0/repositories/acme?q=${encodeURIComponent('bogus.field="x"')}`)).res
        .status,
    ).toBe(400);
    expect((await get(fake, '/2.0/repositories/acme?sort=bogus')).res.status).toBe(400);
    expect((await get(fake, '/2.0/repositories/acme?sort=-project.key')).res.status).toBe(200);
  });

  it('[TST-010] an invalid pullrequests state is a 400', async () => {
    const { fake } = setup();
    for (const st of ['bogus', 'open', 'ALL']) {
      expect(
        (await get(fake, `/2.0/repositories/acme/auto-ok/pullrequests?state=${st}`)).res.status,
        st,
      ).toBe(400);
    }
    expect(
      (await get(fake, '/2.0/repositories/acme/auto-ok/pullrequests?state=DECLINED')).res.status,
    ).toBe(200);
  });

  it('[TST-010] a page beyond the last is 404, page 1 of an empty list is fine', async () => {
    const { fake } = setup();
    expect((await get(fake, '/2.0/repositories/acme?pagelen=1&page=2')).res.status).toBe(200);
    const beyond = await get(fake, '/2.0/repositories/acme?pagelen=1&page=3');
    expect(beyond.res.status).toBe(404);
    expect(beyond.body.type).toBe('error');
    const empty = await get(fake, '/2.0/repositories/acme/empty-repo/deploy-keys');
    expect(empty.res.status).toBe(200);
    expect(empty.body.values).toEqual([]);
    expect(
      (await get(fake, '/2.0/repositories/acme/empty-repo/deploy-keys?page=2')).res.status,
    ).toBe(404);
  });
});
