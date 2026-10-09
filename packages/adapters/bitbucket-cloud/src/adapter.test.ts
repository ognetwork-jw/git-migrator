import type { FacetKey } from '@git-migrator/canonical';
import { parseCanonical } from '@git-migrator/canonical';
import { sha256Hex } from '@git-migrator/core';
import { describe, expect, it } from 'vitest';
import { bitbucketCloudAdapter, capabilities } from './adapter.ts';
import {
  driverCtx,
  endpointTarget,
  facet,
  makeConnection,
  makeWorld,
  target,
} from './harness.test.ts';

async function read(
  key: FacetKey,
  tgt: ReturnType<typeof target> | ReturnType<typeof endpointTarget>,
  world = makeWorld(),
  lsRemote?: Parameters<typeof makeConnection>[1],
) {
  const { conn, rec } = await makeConnection(world, lsRemote);
  const driver = conn.facets[key];
  if (driver === undefined) throw new Error(`no driver ${key}`);
  const res = await driver.read(
    driverCtx(conn, {
      lsRemote: async (r) => {
        rec.lsRemote.push({ url: r.url, username: r.credential.username });
        return (
          (await lsRemote?.lsRemote?.({ url: r.url, username: r.credential.username })) ?? {
            refs: [],
          }
        );
      },
    }),
    tgt,
  );
  // Every read returns schema-valid canonical data (ADP-011).
  expect(parseCanonical(key, res.data).success, key).toBe(true);
  return { res, rec, conn, world };
}

describe('adapter surface', () => {
  it('[ADP-010] declares namespace levels workspace then project', () => {
    expect(bitbucketCloudAdapter.type).toBe('bitbucket-cloud');
    expect(bitbucketCloudAdapter.namespaceLevels.map((l) => l.kind)).toEqual([
      'workspace',
      'project',
    ]);
    expect(bitbucketCloudAdapter.namespaceLevels[1]?.holdsRepositories).toBe(true);
  });

  it('[ADP-014] every Facet is readable and none writable (source provider)', () => {
    expect(Object.keys(capabilities.facets)).toHaveLength(19);
    for (const cap of Object.values(capabilities.facets)) {
      expect(cap).toMatchObject({ read: true, write: false });
    }
  });

  it('[FAC-WEB-003] secrets and webhook secret values are declared unreadable, nothing else is', () => {
    const declared = Object.entries(capabilities.facets).flatMap(([facet, cap]) =>
      Object.entries(cap?.fields ?? {}).map(([path, f]) => `${facet} ${path} ${f.kind}`),
    );
    expect(declared.sort()).toEqual([
      'org-secrets /secrets/value unreadable',
      'org-webhooks /hooks/secret unreadable',
      'secrets /secrets/value unreadable',
      'webhooks /hooks/secret unreadable',
    ]);
  });

  it('[ADP-011] no driver has apply and every driver is read only', async () => {
    const { conn } = await makeConnection(makeWorld());
    for (const driver of Object.values(conn.facets)) expect(driver?.apply).toBeUndefined();
    expect(Object.keys(conn.facets)).toHaveLength(19);
  });

  it('[ADP-050] unsupported target operations fail with code unsupported', async () => {
    const { conn } = await makeConnection(makeWorld());
    const ref = target().repository;
    await expect(
      conn.repositories.create(ref.namespace, {
        name: 'x',
        visibility: 'private',
        description: '',
      }),
    ).rejects.toMatchObject({ code: 'unsupported' });
    await expect(conn.repositories.delete(ref)).rejects.toMatchObject({ code: 'unsupported' });
    await expect(conn.refs.compare(ref, 'a', 'b')).rejects.toMatchObject({ code: 'unsupported' });
    await expect(conn.lfs.missing(ref, [])).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('[ADP-010] invalid config or credential fails without echoing the token', async () => {
    const world = makeWorld();
    const error = await makeConnection(world, { credential: { apiToken: 'x' } }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: 'invalid' });
    expect(String(error)).not.toContain('"x"');
    await expect(
      makeConnection(world, { config: { workspace: 'bad slug!' } }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('[ADP-070] git access builds a credential-free https URL and a token credential', async () => {
    const { conn } = await makeConnection(makeWorld());
    const ref = target().repository;
    expect(conn.git.remoteUrl(ref)).toBe('http://localhost:4030/source/acme/auto-ok.git');
    expect(await conn.git.credential(ref)).toEqual({
      username: 'x-bitbucket-api-token-auth',
      password: 'fake-bitbucket-api-token',
    });
    const custom = await makeConnection(makeWorld(), {
      credential: { gitUsername: 'custom-user' },
    });
    expect((await custom.conn.git.credential(ref)).username).toBe('custom-user');
  });

  it('[JOB-043] git access names the credential git bucket, so git commands are metered', async () => {
    const { conn } = await makeConnection(makeWorld());
    expect(conn.git.quota).toMatchObject({ limit: 60000, windowSeconds: 3600 });
    expect(conn.git.quota?.key.endsWith(':git')).toBe(true);
  });
});

describe('inventory (JOB-030)', () => {
  it('[JOB-030] lists the workspace and its projects as namespaces', async () => {
    const { conn } = await makeConnection(makeWorld());
    const page = await conn.inventory.listNamespaces();
    expect(page.items.map((n) => `${n.kind}:${n.slug}`)).toEqual([
      'workspace:acme',
      'project:PLAT',
      'project:DATA',
    ]);
    expect(page.items[1]).toMatchObject({
      key: 'PLAT',
      parentProviderId: 'acme',
      name: 'Platform',
    });
  });

  it('[JOB-030] pages namespaces and repositories with opaque next-link cursors', async () => {
    const world = makeWorld({ pageOptions: { maxPagelen: 1 } });
    for (const k of ['A', 'B'])
      world.fake.state.addRepository('acme', { slug: `r-${k}`, projectKey: 'DATA' });
    const { conn } = await makeConnection(world);
    const first = await conn.inventory.listNamespaces();
    expect(first.nextCursor).toBeDefined();
    const second = await conn.inventory.listNamespaces(first.nextCursor);
    expect(second.items.every((n) => n.kind === 'project')).toBe(true);
    const ns = { providerId: 'p', slug: 'DATA' };
    const all: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await conn.inventory.listRepositories(ns, cursor);
      all.push(...page.items.map((r) => r.slug));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(all.sort()).toEqual(['empty', 'r-A', 'r-B']);
  });

  it('[JOB-030] maps repositories: id, path, size, default branch, updated time', async () => {
    const { conn } = await makeConnection(makeWorld());
    const page = await conn.inventory.listRepositories({ providerId: 'p', slug: 'PLAT' });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      slug: 'auto-ok',
      fullPath: 'acme/PLAT/auto-ok',
      isPrivate: true,
      sizeBytes: 1234,
      defaultBranch: 'main',
    });
    expect(page.items[0]?.providerUpdatedAt).toBeInstanceOf(Date);
    expect(page.items[0]?.namespace).toEqual({ providerId: 'p', slug: 'PLAT' });
  });

  it('[JOB-030] an empty repository has a null default branch; isEmpty follows it', async () => {
    const { conn } = await makeConnection(makeWorld());
    const page = await conn.inventory.listRepositories({ providerId: 'p', slug: 'DATA' });
    expect(page.items[0]?.defaultBranch).toBeNull();
    const ref = { providerId: 'x', namespace: { providerId: 'p', slug: 'DATA' }, slug: 'empty' };
    expect(await conn.repositories.isEmpty(ref)).toBe(true);
    expect(await conn.repositories.isEmpty(target().repository)).toBe(false);
  });

  it('[JOB-030] isEmpty fails for a missing repository and checks branches when there is no main branch', async () => {
    const world = makeWorld();
    const { conn } = await makeConnection(world);
    const ghost = { ...target().repository, slug: 'ghost' };
    await expect(conn.repositories.isEmpty(ghost)).rejects.toMatchObject({ code: 'not_found' });
    const repo = world.fake.state.workspace('acme')?.repositories.find((r) => r.slug === 'auto-ok');
    if (repo === undefined) throw new Error('repo');
    repo.mainbranch = null;
    expect(await conn.repositories.isEmpty(target().repository)).toBe(false);
  });

  it('[JOB-030] getRepository and findRepository return null when absent', async () => {
    const { conn } = await makeConnection(makeWorld());
    const missing = { ...target().repository, slug: 'nope' };
    expect(await conn.inventory.getRepository(missing)).toBeNull();
    expect((await conn.inventory.getRepository(target().repository))?.name).toBe('auto-ok');
    const ns = { providerId: 'p', slug: 'PLAT' };
    expect((await conn.inventory.findRepository(ns, 'auto-ok'))?.slug).toBe('auto-ok');
    expect(await conn.inventory.findRepository(ns, 'nothing "here"')).toBeNull();
    expect(
      await conn.inventory.findRepository({ providerId: 'p', slug: 'bad key"' }, 'x'),
    ).toBeNull();
  });

  it('[JOB-030] refuses to list repositories of the workspace or of an invalid project key', async () => {
    const { conn } = await makeConnection(makeWorld());
    await expect(
      conn.inventory.listRepositories({ providerId: 'acme', slug: 'acme' }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      conn.inventory.listRepositories({ providerId: 'p', slug: 'A" OR 1' }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('[JOB-030] lists identities with account id, login and membership', async () => {
    const { conn } = await makeConnection(makeWorld());
    const page = await conn.inventory.listIdentities();
    const alice = page.items.find((i) => i.providerId === 'acct-alice');
    expect(alice).toMatchObject({
      login: 'alice',
      displayName: 'Alice A',
      kind: 'user',
      isMember: true,
    });
    expect(alice?.email).toBeUndefined();
  });

  it('[FAC-ACL-001] lists groups with members through the 1.0 groups endpoint', async () => {
    const { conn } = await makeConnection(makeWorld());
    const page = await conn.inventory.listGroups();
    expect(page.items).toEqual([
      {
        providerId: 'developers',
        slug: 'developers',
        name: 'Developers',
        memberProviderIds: ['acct-bob'],
      },
    ]);
  });

  it('[FAC-ACL-001] falls back to permission-list group names when the groups endpoint is gone', async () => {
    for (const mode of ['not-found', 'gone'] as const) {
      const { conn } = await makeConnection(makeWorld({ groupsEndpoint: mode }));
      const page = await conn.inventory.listGroups();
      expect(page.items.map((g) => g.slug)).toEqual(['developers']);
      expect(page.items[0]?.memberProviderIds).toEqual([]);
    }
  });
});

describe('facet reads', () => {
  it('[FAC-GIT-001] git-refs classifies refs, peels tags and reads the default branch', async () => {
    const { res, rec } = await read('git-refs', target(), makeWorld(), {
      lsRemote: () => ({
        refs: [
          { name: 'HEAD', sha: 'a' },
          { name: 'refs/heads/main', sha: 'a' },
          { name: 'refs/tags/v1', sha: 'tagobj', peeled: 'c' },
          { name: 'refs/pull-requests/1/head', sha: 'p' },
        ],
        headSymref: 'refs/heads/main',
      }),
    });
    expect(res.data).toEqual({
      defaultBranch: 'main',
      refs: [
        { name: 'refs/heads/main', kind: 'branch', target: 'a' },
        { name: 'refs/tags/v1', kind: 'tag', target: 'tagobj', peeled: 'c' },
      ],
      ignoredRefs: ['refs/pull-requests/1/head'],
      lfs: {},
    });
    expect(rec.lsRemote[0]?.url).toBe('http://localhost:4030/source/acme/auto-ok.git');
  });

  it('[FAC-GIT-001] an empty repository has no refs and a null default branch', async () => {
    const { res } = await read('git-refs', target());
    expect(res.data).toMatchObject({ defaultBranch: null, refs: [] });
  });

  it('[FAC-SET-001] repository-settings maps description, visibility, features and forking', async () => {
    const { res } = await read('repository-settings', target());
    expect(res.data).toEqual({
      description: 'hello',
      homepage: null,
      visibility: 'private',
      features: { issues: true, wiki: true },
      forking: 'private-only',
    });
    expect(res.rawResponseIds.length).toBeGreaterThan(0);
  });

  it('[FAC-MRG-002] merge-settings reads strategies from the main branch and the close-branch default', async () => {
    const world = makeWorld();
    const repo = world.fake.state.workspace('acme')?.repositories.find((r) => r.slug === 'auto-ok');
    if (repo === undefined) throw new Error('repo');
    const main = repo.branches.find((b) => b.name === 'main');
    if (main === undefined) throw new Error('main');
    main.mergeStrategies = ['merge_commit', 'squash_fast_forward', 'rebase_merge', 'fast_forward'];
    repo.branchingModel.defaultBranchDeletion = 'true';
    const { res } = await read('merge-settings', target(), world);
    expect(res.data).toEqual({
      allowed: ['merge-commit', 'squash', 'rebase', 'fast-forward-only'],
      deleteBranchOnMerge: true,
    });
    expect(res.unreadable).toEqual([]);
  });

  it('[FAC-MRG-002] unreadable merge fields are reported: empty repository and 403', async () => {
    const { res } = await read('merge-settings', target('empty', 'DATA'));
    expect(res.unreadable).toContain('/allowed');
    const world = makeWorld({
      credentials: [
        {
          email: 'operator@test.local',
          token: 'fake-bitbucket-api-token',
          accountId: 'acct-operator',
          scopes: ['read:repository:bitbucket'],
        },
      ],
    });
    const limited = await read('merge-settings', target(), world);
    expect(limited.res.unreadable).toEqual(['/deleteBranchOnMerge']);
  });

  it('[FAC-ACL-001] access-control unions repo, project and default-permission grants with the maximum role', async () => {
    const { res } = await read('access-control', target());
    const grantRows = (
      res.data as { grants: { principal: { kind: string; id: string }; role: string }[] }
    ).grants;
    const grants = Object.fromEntries(
      grantRows.map((g) => [`${g.principal.kind}:${g.principal.id}`, g.role]),
    );
    // alice is a workspace owner: implicit, excluded. bob: repo read, project write -> write.
    expect(grants).toEqual({ 'identity:acct-bob': 'write', 'group:developers': 'write' });
  });

  it('[FAC-ACL-001] a workspace default-permission group gets its role only through the groups endpoint', async () => {
    const world = makeWorld();
    world.fake.state.addGroup('acme', {
      name: 'Everyone',
      slug: 'everyone',
      members: [],
      defaultPermission: 'read',
    });
    const withEndpoint = await read('access-control', target(), world);
    expect(JSON.stringify(withEndpoint.res.data)).toContain('"everyone"');
    const hidden = makeWorld({ groupsEndpoint: 'not-found' });
    hidden.fake.state.addGroup('acme', {
      name: 'Everyone',
      slug: 'everyone',
      members: [],
      defaultPermission: 'read',
    });
    const without = await read('access-control', target(), hidden);
    expect(JSON.stringify(without.res.data)).not.toContain('"everyone"');
  });

  it('[FAC-BRR-001] branch-rules groups restrictions by pattern and converts globs', async () => {
    const { res } = await read('branch-rules', target());
    const rules = (res.data as { rules: Record<string, unknown>[] }).rules;
    expect(rules.map((r) => r.pattern)).toEqual(['**', 'main']);
    const main = rules.find((r) => r.pattern === 'main');
    expect(main).toMatchObject({
      enforcement: 'advisory',
      restrictPushes: [
        { principal: { kind: 'group', id: 'developers' } },
        { principal: { kind: 'identity', id: 'acct-alice' } },
      ],
      changeRequest: { minApprovals: 2 },
    });
  });

  it('[FAC-WEB-001] webhooks map events, secret presence and report unmapped events', async () => {
    const { res } = await read('webhooks', target());
    const hooks = (
      res.data as {
        hooks: { events: string[]; hasSecret: boolean; active: boolean; verifyTls: boolean }[];
      }
    ).hooks;
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({
      events: ['cr.comment', 'push'],
      hasSecret: true,
      active: true,
      verifyTls: true,
    });
    expect(res.warnings).toEqual([
      {
        code: 'webhooks.unmapped-events',
        paths: [],
        params: { scope: 'repository', events: ['repo:commit_comment_created'] },
      },
    ]);
  });

  it('[FAC-WEB-002] duplicate webhook URLs merge with a warning and invalid URLs are dropped', async () => {
    const world = makeWorld();
    world.fake.state.addWebhook('acme', 'auto-ok', {
      url: 'https://hooks.test.local/a',
      events: ['repo:fork'],
      secretSet: false,
    });
    world.fake.state.addWebhook('acme', 'auto-ok', { url: 'https://user:pw@hooks.test.local/b' });
    const { res } = await read('webhooks', target(), world);
    const hooks = (res.data as { hooks: { events: string[] }[] }).hooks;
    expect(hooks).toHaveLength(1);
    expect(hooks[0]?.events).toEqual(['cr.comment', 'push', 'repo.fork']);
    expect(res.warnings.map((w) => w.code).sort()).toEqual([
      'webhooks.duplicate-url',
      'webhooks.invalid-url',
      'webhooks.unmapped-events',
    ]);
    expect(JSON.stringify(res.warnings)).not.toContain('pw@');
  });

  it('[FAC-DKY-001] deploy-keys flatten repository and project keys, comment stripped, read-only', async () => {
    const { res } = await read('deploy-keys', target());
    expect(res.data).toEqual({
      keys: [
        { publicKey: 'ssh-ed25519 AAAAproject', title: 'project key', readOnly: true },
        { publicKey: 'ssh-ed25519 AAAArepo', title: 'ci', readOnly: true },
      ],
    });
  });

  it('[FAC-VAR-001] variables and secrets split by secured, environment scope included', async () => {
    const vars = await read('variables', target());
    expect(
      (vars.res.data as { variables: { key: string; value: string }[] }).variables.map(
        (v) => `${v.key}=${v.value}`,
      ),
    ).toEqual(['repository/PLAIN=v', 'environment:Production/E1=e']);
    const secrets = await read('secrets', target());
    expect((secrets.res.data as { secrets: { key: string }[] }).secrets.map((s) => s.key)).toEqual([
      'repository/HIDDEN',
      'environment:Production/E2',
    ]);
    expect(JSON.stringify(secrets.res.data)).not.toContain('topsecret');
  });

  it('[FAC-ENV] environments map the type to a category, branches are null on Standard', async () => {
    const { res } = await read('environments', target());
    expect(res.data).toEqual({
      environments: [{ name: 'Production', category: 'production', deploymentBranches: null }],
    });
  });

  it('[FAC-PIP-001] pipelines reads the file hash at the main branch and the enabled flag', async () => {
    const { res } = await read('pipelines', target());
    const data = res.data as { files: { path: string; sha256: string }[]; enabled: boolean };
    expect(data.enabled).toBe(true);
    expect(data.files[0]?.path).toBe('bitbucket-pipelines.yml');
    expect(data.files[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('[FAC-PIP-002] pipelines hands the file text over as an in-memory attachment keyed by its hash', async () => {
    const { res } = await read('pipelines', target());
    const data = res.data as { files: { path: string; sha256: string }[] };
    const sha = data.files[0]?.sha256 as string;
    const text = res.attachments?.[sha];
    expect(typeof text).toBe('string');
    expect(sha256Hex(text as string)).toBe(sha);
    expect(JSON.stringify(res.data)).not.toContain(text as string);
  });

  it('[ADP-061] the pipelines file body is never captured', async () => {
    const { rec } = await read('pipelines', target());
    expect(rec.captures.some((c) => c.url.includes('/src/'))).toBe(false);
  });

  it('[FAC-PIP-001] a missing pipelines file is none, an empty repository is unreadable', async () => {
    const world = makeWorld();
    world.fake.state.addRepository('acme', { slug: 'nofile', projectKey: 'PLAT' });
    const none = await read('pipelines', target('nofile'), world);
    expect((none.res.data as { files: unknown[] }).files).toEqual([]);
    expect(none.res.unreadable).toEqual([]);
    const empty = await read('pipelines', target('empty', 'DATA'), world);
    expect(empty.res.unreadable).toEqual(['/files']);
  });

  it('[FAC-COD] code-ownership turns effective default reviewers into one * entry', async () => {
    const world = makeWorld();
    world.fake.state
      .workspace('acme')
      ?.repositories.find((r) => r.slug === 'auto-ok')
      ?.defaultReviewers.push({ accountId: 'acct-bob', reviewerType: 'repository' });
    const { res } = await read('code-ownership', target(), world);
    expect(res.data).toEqual({
      owners: [{ pattern: '*', principals: [{ principal: { kind: 'identity', id: 'acct-bob' } }] }],
    });
    const none = await read('code-ownership', target('empty', 'DATA'));
    expect(none.res.data).toEqual({ owners: [] });
  });

  it('[FAC-CRQ] change-requests lists open pull requests', async () => {
    const { res } = await read('change-requests', target());
    expect((res.data as { open: { id: string; title: string; url: string }[] }).open).toEqual([
      expect.objectContaining({ id: '1', title: 'Open one' }),
    ]);
  });

  it('[FAC-EXT] extras counts issues and downloads and probes the wiki with ls-remote', async () => {
    const { res, rec } = await read('extras', target(), makeWorld(), {
      lsRemote: () => ({ refs: [{ name: 'refs/heads/master', sha: 'a' }] }),
    });
    expect(res.data).toEqual({
      wikiPopulated: true,
      issueCount: 3,
      downloadCount: 2,
      releaseCount: 0,
    });
    expect(rec.lsRemote[0]?.url).toBe('http://localhost:4030/source/acme/auto-ok.git/wiki');
  });

  it('[FAC-EXT] a failing wiki probe is unreadable, never a failed read', async () => {
    const { res } = await read('extras', target(), makeWorld(), {
      lsRemote: () => {
        throw new Error('repository not found');
      },
    });
    expect(res.unreadable).toEqual(['/wikiPopulated']);
    expect((res.data as { wikiPopulated: boolean }).wikiPopulated).toBe(false);
  });

  it('[FAC-EXT] a repository without issues or wiki makes no such calls', async () => {
    const { rec } = await read('extras', target('empty', 'DATA'));
    expect(rec.lsRemote).toHaveLength(0);
    expect(rec.requests.some((r) => r.path.includes('/issues'))).toBe(false);
  });

  it('[FAC-END] members carry the workspace role (owners are admins)', async () => {
    const { res } = await read('members', endpointTarget());
    const roles = Object.fromEntries(
      (res.data as { members: { principal: { id: string }; role: string }[] }).members.map((m) => [
        m.principal.id,
        m.role,
      ]),
    );
    expect(roles['acct-alice']).toBe('admin');
    expect(roles['acct-bob']).toBe('member');
  });

  it('[FAC-END] teams read membership from the groups endpoint', async () => {
    const { res } = await read('teams', endpointTarget());
    expect(res.data).toEqual({
      teams: [
        {
          slug: 'developers',
          name: 'Developers',
          members: [{ principal: { kind: 'identity', id: 'acct-bob' } }],
        },
      ],
    });
    expect(res.unreadable).toEqual([]);
  });

  it('[FAC-END] teams fall back to permission lists with membership unreadable (ADR-0036)', async () => {
    const { res } = await read('teams', endpointTarget(), makeWorld({ groupsEndpoint: 'gone' }));
    expect(res.data).toEqual({ teams: [{ slug: 'developers', name: 'Developers', members: [] }] });
    expect(res.unreadable).toEqual(['/teams[slug=developers]/members']);
  });

  it('[FAC-END] org-variables, org-secrets and org-webhooks read the workspace', async () => {
    expect((await read('org-variables', endpointTarget())).res.data).toEqual({
      variables: [{ name: 'WS_VAR', value: 'w', visibility: 'all' }],
    });
    expect((await read('org-secrets', endpointTarget())).res.data).toEqual({
      secrets: [{ name: 'WS_SECRET' }],
    });
    const hooks = await read('org-webhooks', endpointTarget());
    expect((hooks.res.data as { hooks: unknown[] }).hooks).toHaveLength(1);
  });

  it('[ADP-061] facet reads capture raw responses; secrets never reach a capture', async () => {
    const { rec } = await read('variables', target());
    expect(rec.captures.length).toBeGreaterThan(0);
    const dump = JSON.stringify(rec.captures);
    expect(dump).not.toContain('fake-bitbucket-api-token');
    expect(dump).not.toContain('topsecret');
    expect(dump).not.toContain(
      Buffer.from('operator@test.local:fake-bitbucket-api-token').toString('base64'),
    );
  });

  it('[ADP-013] a missing required field is an invalid error naming paths, not values', async () => {
    const world = makeWorld();
    const { conn } = await makeConnection(world);
    const original = world.fake.app.request.bind(world.fake.app);
    world.fake.app.request = (async (input: string, init?: RequestInit) => {
      const res = await original(input, init);
      if (String(input).includes('/environments')) {
        return new Response(JSON.stringify({ values: [{ name: 'x-secret-value' }] }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return res;
    }) as never;
    const driver = conn.facets.environments;
    const error = await driver?.read(driverCtx(conn), target()).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'invalid' });
    expect(String(error)).not.toContain('x-secret-value');
  });

  it('[JOB-040] shares project reads across repositories within a batch', async () => {
    const world = makeWorld();
    world.fake.state.addRepository('acme', { slug: 'second', projectKey: 'PLAT' });
    const { conn, rec } = await makeConnection(world);
    const ctx = driverCtx(conn);
    await facet(conn, 'access-control').read(ctx, target());
    await facet(conn, 'access-control').read(ctx, target('second'));
    const projectCalls = rec.requests.filter((r) =>
      r.path.includes('/projects/PLAT/permissions-config'),
    );
    expect(projectCalls).toHaveLength(2);
    expect(rec.requests.filter((r) => r.path.startsWith('/1.0/groups'))).toHaveLength(1);
  });
});
