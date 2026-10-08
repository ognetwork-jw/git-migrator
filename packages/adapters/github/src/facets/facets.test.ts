import type { FacetDriver } from '@git-migrator/adapter-sdk';
import type { FacetKey } from '@git-migrator/canonical';
import { describe, expect, it } from 'vitest';
import { all, type Harness, setup } from '../harness.test.ts';

const FILES = { 'README.md': '# hi\n', 'src/a.txt': 'a\n' };

function driver<T>(h: Harness, key: FacetKey): FacetDriver<T> {
  const d = h.conn.facets[key];
  if (!d) throw new Error(`no driver ${key}`);
  return d as FacetDriver<T>;
}

/** read -> apply -> read equals desired; a second apply makes no mutation (ADP-011). */
async function roundTrip<T>(
  h: Harness,
  key: FacetKey,
  target: Parameters<FacetDriver<T>['read']>[1],
  desired: T,
  expected: T = desired,
) {
  const d = driver<T>(h, key);
  const before = await d.read(h.ctx, target);
  const first = await all(d.apply?.(h.ctx, target, desired, before.data, []));
  const after = await d.read(h.ctx, target);
  expect(after.data).toEqual(expected);
  const second = await all(d.apply?.(h.ctx, target, desired, after.data, []));
  expect(second).toEqual([]);
  // A caller that passes no current state gets the same answer.
  expect(await all(d.apply?.(h.ctx, target, desired, null, []))).toEqual([]);
  return { first, after, before };
}

describe('repository-settings', () => {
  it('[FAC-SET-001] reads the settings of a repository', async () => {
    const h = await setup();
    h.fake.state.addRepository('acme', {
      name: 'r',
      private: true,
      description: 'desc',
      homepage: 'https://x.test',
      files: FILES,
    });
    const read = await driver(h, 'repository-settings').read(h.ctx, h.target('r'));
    expect(read.data).toEqual({
      description: 'desc',
      homepage: 'https://x.test',
      visibility: 'private',
      features: { issues: true, wiki: true },
      forking: 'allowed',
    });
    expect(read.rawResponseIds).toBeDefined();
  });

  it('[FAC-SET-001] applies changed fields only and is idempotent', async () => {
    const h = await setup();
    h.fake.state.addRepository('acme', {
      name: 'r',
      private: true,
      description: 'a',
      files: FILES,
    });
    const { first } = await roundTrip(h, 'repository-settings', h.target('r'), {
      description: 'new text',
      homepage: null,
      visibility: 'private',
      features: { issues: false, wiki: false },
      forking: 'disallowed',
    });
    expect(first).toHaveLength(1);
    expect([...(first[0]?.paths ?? [])].sort()).toEqual([
      '/description',
      '/features/issues',
      '/features/wiki',
      '/forking',
    ]);
  });

  it('[FAC-SET-002] reports forking unsupported when the organization forbids private forking', async () => {
    const h = await setup();
    h.fake.state.requireOrg('acme').membersCanForkPrivateRepositories = false;
    h.fake.state.addRepository('acme', { name: 'r', private: true, files: FILES });
    const read = await driver(h, 'repository-settings').read(h.ctx, h.target('r'));
    expect(read.capabilities?.['/forking']).toMatchObject({ kind: 'unsupported' });
  });

  it('[FAC-SET-002] does not write allow_forking when the organization forbids it', async () => {
    const h = await setup();
    h.fake.state.requireOrg('acme').membersCanForkPrivateRepositories = false;
    h.fake.state.addRepository('acme', { name: 'r', private: true, files: FILES });
    const d = driver<import('@git-migrator/canonical').RepositorySettings>(
      h,
      'repository-settings',
    );
    const current = (await d.read(h.ctx, h.target('r'))).data;
    const out = await all(
      d.apply?.(h.ctx, h.target('r'), { ...current, forking: 'disallowed' }, current, []),
    );
    expect(out).toEqual([]);
  });
});

describe('merge-settings', () => {
  it('[FAC-MRG-001] maps the three GitHub strategies and delete-branch-on-merge', async () => {
    const h = await setup();
    h.fake.state.addRepository('acme', { name: 'r', files: FILES });
    const read = await driver<import('@git-migrator/canonical').MergeSettings>(
      h,
      'merge-settings',
    ).read(h.ctx, h.target('r'));
    expect(read.data.allowed).toEqual(['merge-commit', 'rebase', 'squash']);
    await roundTrip(h, 'merge-settings', h.target('r'), {
      allowed: ['squash'],
      deleteBranchOnMerge: true,
    });
  });
});

describe('git-refs', () => {
  it('[FAC-GIT-001] reads refs through the git client and splits ignored refs', async () => {
    const h = await setup({
      git: {
        lsRemote: async (request) => {
          expect(request.url).toBe('http://localhost:4020/acme/r.git');
          expect(request.credential.username).toBe('x-access-token');
          return {
            headSymref: 'refs/heads/main',
            refs: [
              { name: 'HEAD', sha: 'a'.repeat(40) },
              { name: 'refs/heads/main', sha: 'a'.repeat(40) },
              { name: 'refs/tags/v1', sha: 'b'.repeat(40), peeled: 'a'.repeat(40) },
              { name: 'refs/tags/v2', sha: 'c'.repeat(40) },
              { name: 'refs/pull/1/head', sha: 'a'.repeat(40) },
            ],
          };
        },
      },
    });
    const read = await driver<import('@git-migrator/canonical').GitRefs>(h, 'git-refs').read(
      h.ctx,
      h.target('r'),
    );
    expect(read.data).toEqual({
      defaultBranch: 'main',
      refs: [
        { name: 'refs/heads/main', kind: 'branch', target: 'a'.repeat(40) },
        { name: 'refs/tags/v1', kind: 'tag', target: 'b'.repeat(40), peeled: 'a'.repeat(40) },
        { name: 'refs/tags/v2', kind: 'tag', target: 'c'.repeat(40) },
      ],
      ignoredRefs: ['refs/pull/1/head'],
      lfs: {},
    });
  });

  it('[FAC-GIT-001] an empty repository has no default branch', async () => {
    const h = await setup();
    const read = await driver<import('@git-migrator/canonical').GitRefs>(h, 'git-refs').read(
      h.ctx,
      h.target('r'),
    );
    expect(read.data.defaultBranch).toBeNull();
    expect(read.data.refs).toEqual([]);
  });
});

describe('access-control', () => {
  async function world() {
    const h = await setup();
    const s = h.fake.state;
    s.addMember('acme', 'alice', 'admin');
    const bob = s.addMember('acme', 'bob');
    const dana = s.addMember('acme', 'dana');
    const team = s.addTeam('acme', { name: 'Platform', members: ['dana'] });
    const repo = s.addRepository('acme', { name: 'r', private: true, files: FILES });
    return { h, s, bob, dana, team, repo };
  }

  it('[FAC-ACL-002] reads direct collaborators and teams, without org owners', async () => {
    const { h, s, bob, team, repo } = await world();
    s.addCollaborator(repo, 'bob', 'push');
    s.addCollaborator(repo, 'alice', 'admin');
    s.grantTeam(repo, team, 'maintain');
    const read = await driver<import('@git-migrator/canonical').AccessControl>(
      h,
      'access-control',
    ).read(h.ctx, h.target('r'));
    expect(read.data.grants).toEqual([
      { principal: { kind: 'group', id: String(team.id) }, role: 'maintain' },
      { principal: { kind: 'identity', id: String(bob.id) }, role: 'write' },
    ]);
  });

  it('[FAC-ACL-002] grants collaborators and teams, updates roles, idempotent', async () => {
    const { h, bob, team } = await world();
    const desired = {
      grants: [
        { principal: { kind: 'group' as const, id: String(team.id) }, role: 'admin' as const },
        { principal: { kind: 'identity' as const, id: String(bob.id) }, role: 'triage' as const },
      ],
    };
    const { first } = await roundTrip(h, 'access-control', h.target('r'), desired);
    expect(first.map((m) => m.action)).toEqual(['create', 'create']);
    const upgraded = {
      grants: [
        desired.grants[0] as (typeof desired.grants)[number],
        { principal: { kind: 'identity' as const, id: String(bob.id) }, role: 'write' as const },
      ],
    };
    const { first: again } = await roundTrip(h, 'access-control', h.target('r'), upgraded);
    expect(again).toHaveLength(1);
    expect(again[0]?.action).toBe('update');
  });

  it('[FAC-ACL-002] never invites an outside collaborator', async () => {
    const { h, s } = await world();
    const carol = s.addUser({ login: 'carol', email: 'c@test.local' });
    const d = driver<import('@git-migrator/canonical').AccessControl>(h, 'access-control');
    const out = await all(
      d.apply?.(
        h.ctx,
        h.target('r'),
        { grants: [{ principal: { kind: 'identity', id: String(carol.id) }, role: 'read' }] },
        { grants: [] },
        [],
      ),
    );
    expect(out).toEqual([]);
    expect(
      h.requests.filter((r) => r.method === 'PUT' && r.url.includes('/collaborators/')),
    ).toHaveLength(0);
  });
});

describe('branch-rules', () => {
  const rule = (
    pattern: string,
    extra: Partial<import('@git-migrator/canonical').BranchRule> = {},
  ) => ({
    pattern,
    enforcement: 'enforced' as const,
    restrictPushes: null,
    restrictMerges: null,
    blockForcePush: true,
    forcePushExempt: [],
    blockDeletion: true,
    deletionExempt: [],
    changeRequest: null,
    ...extra,
  });

  it('[FAC-BRR-002] creates rules through GraphQL and reads them back verbatim', async () => {
    const h = await setup();
    h.fake.state.addRepository('acme', { name: 'r', private: true, files: FILES });
    const desired = {
      rules: [rule('main'), rule('release/**/*', { blockForcePush: false, blockDeletion: false })],
    };
    const { first } = await roundTrip(h, 'branch-rules', h.target('r'), desired);
    expect(first.map((m) => m.action)).toEqual(['create', 'create']);
    expect(first[0]?.paths).toEqual(['/rules[pattern=main]']);
  });

  it('[FAC-BRR-003] creates wildcard rules in branchRuleApplyOrder: the narrower rule is older (ADR-0113)', async () => {
    const h = await setup();
    const repo = h.fake.state.addRepository('acme', { name: 'r', private: true, files: FILES });
    const desired = {
      rules: [rule('**/*'), rule('release/**/*'), rule('release/*'), rule('main')],
    };
    await all(
      driver<import('@git-migrator/canonical').BranchRules>(h, 'branch-rules').apply?.(
        h.ctx,
        h.target('r'),
        desired,
        null,
        [],
      ),
    );
    const created = repo.rules.map((r) => r.pattern);
    expect(created.indexOf('release/*')).toBeLessThan(created.indexOf('release/**/*'));
    expect(created.indexOf('release/**/*')).toBeLessThan(created.indexOf('**/*'));
    expect(created.indexOf('main')).toBeLessThan(created.indexOf('release/*'));
  });

  it('[FAC-BRR-002] maps change-request rules, push restrictions and force-push exemptions', async () => {
    const h = await setup();
    const s = h.fake.state;
    const bob = s.addMember('acme', 'bob');
    const team = s.addTeam('acme', { name: 'devs', members: ['bob'] });
    const repo = s.addRepository('acme', { name: 'r', private: true, files: FILES });
    s.addCollaborator(repo, 'bob', 'push');
    s.grantTeam(repo, team, 'push');
    const desired = {
      rules: [
        rule('main', {
          restrictPushes: [
            { principal: { kind: 'group', id: String(team.id) } },
            { principal: { kind: 'identity', id: String(bob.id) } },
          ],
          forcePushExempt: [{ principal: { kind: 'identity', id: String(bob.id) } }],
          changeRequest: {
            minApprovals: 2,
            requireCodeOwnerApproval: true,
            dismissStaleApprovals: true,
            requireNoChangesRequested: true,
            requireTasksResolved: true,
            requireUpToDate: true,
            minPassingBuilds: 0,
          },
        }),
      ],
    };
    await roundTrip(h, 'branch-rules', h.target('r'), desired);
    const stored = repo.rules[0];
    expect(stored?.restrictsPushes).toBe(true);
    expect(stored?.blocksCreations).toBe(true);
    expect(stored?.allowsForcePushes).toBe(false);
    expect(stored?.isAdminEnforced).toBe(false);
  });

  it('[FAC-BRR-002] ADR-0040: a bypass actor can force push and a non-listed writer cannot', async () => {
    const { canForcePush } = (await import('@git-migrator/provider-fakes')).github;
    const h = await setup();
    const s = h.fake.state;
    const bob = s.addMember('acme', 'bob');
    const eve = s.addMember('acme', 'eve');
    const repo = s.addRepository('acme', { name: 'r', private: true, files: FILES });
    s.addCollaborator(repo, 'bob', 'push');
    s.addCollaborator(repo, 'eve', 'push');
    await all(
      driver<import('@git-migrator/canonical').BranchRules>(h, 'branch-rules').apply?.(
        h.ctx,
        h.target('r'),
        {
          rules: [
            rule('main', {
              forcePushExempt: [{ principal: { kind: 'identity', id: String(bob.id) } }],
            }),
          ],
        },
        null,
        [],
      ),
    );
    expect(canForcePush(repo, 'main', [bob.nodeId])).toBe(true);
    expect(canForcePush(repo, 'main', [eve.nodeId])).toBe(false);
  });

  it('[FAC-BRR-002] updates an existing rule in place and deletes rules that are not wanted', async () => {
    const h = await setup();
    const repo = h.fake.state.addRepository('acme', { name: 'r', private: true, files: FILES });
    await all(
      driver<import('@git-migrator/canonical').BranchRules>(h, 'branch-rules').apply?.(
        h.ctx,
        h.target('r'),
        { rules: [rule('main'), rule('old')] },
        null,
        [],
      ),
    );
    const id = repo.rules.find((r) => r.pattern === 'main')?.id;
    const out = await all(
      driver<import('@git-migrator/canonical').BranchRules>(h, 'branch-rules').apply?.(
        h.ctx,
        h.target('r'),
        { rules: [rule('main', { blockDeletion: false })] },
        null,
        [],
      ),
    );
    expect(out.map((m) => m.action).sort()).toEqual(['delete', 'update']);
    expect(repo.rules.map((r) => r.pattern)).toEqual(['main']);
    expect(repo.rules[0]?.id).toBe(id);
    expect(repo.rules[0]?.allowsDeletions).toBe(true);
  });

  it('[FAC-BRR-002] ADR-0040: a refused bypass list is retried without it and recorded', async () => {
    const h = await setup();
    const s = h.fake.state;
    const bob = s.addMember('acme', 'bob');
    const repo = s.addRepository('acme', { name: 'r', private: true, files: FILES });
    s.addCollaborator(repo, 'bob', 'push');
    const real = h.ctx.http;
    let refused = 0;
    const ctx = {
      ...h.ctx,
      http: new Proxy(real, {
        get(target, prop, receiver) {
          if (prop !== 'request') return Reflect.get(target, prop, receiver);
          return async (req: Parameters<typeof real.request>[0]) => {
            const json = req.json as
              | { variables?: { input?: { bypassForcePushActorIds?: string[] } } }
              | undefined;
            if (
              req.path === '/graphql' &&
              (json?.variables?.input?.bypassForcePushActorIds?.length ?? 0) > 0
            ) {
              refused += 1;
              return {
                status: 200,
                headers: new Headers(),
                url: '/graphql',
                grantedAt: new Date(),
                body: { errors: [{ type: 'UNPROCESSABLE', message: 'bypass list not allowed' }] },
              };
            }
            return real.request(req);
          };
        },
      }),
    };
    const d = driver<import('@git-migrator/canonical').BranchRules>(h, 'branch-rules');
    const out = await all(
      d.apply?.(
        ctx,
        h.target('r'),
        {
          rules: [
            rule('main', {
              forcePushExempt: [{ principal: { kind: 'identity', id: String(bob.id) } }],
            }),
          ],
        },
        null,
        [],
      ),
    );
    expect(refused).toBe(1);
    expect(out[0]?.resourceRef).toMatchObject({ exemptionsDropped: true });
    expect(out[0]?.after).toMatchObject({ forcePushExempt: [] });
    expect(repo.rules[0]?.allowsForcePushes).toBe(false);
  });

  it('[FAC-BRR-002] a 403 on a mutation is forbidden and is not retried (T-031 follow-up)', async () => {
    const h = await setup();
    h.fake.state.addRepository('acme', { name: 'r', private: true, files: FILES });
    const token = h.fake.token({ permissions: { metadata: 'read', contents: 'write' } });
    void token;
    // Without Administration the GraphQL mutation is refused; simulate via a GraphQL FORBIDDEN error.
    const real = h.ctx.http;
    let calls = 0;
    const ctx = {
      ...h.ctx,
      http: new Proxy(real, {
        get(target, prop, receiver) {
          if (prop !== 'request') return Reflect.get(target, prop, receiver);
          return async (req: Parameters<typeof real.request>[0]) => {
            if (
              req.path === '/graphql' &&
              JSON.stringify(req.json).includes('createBranchProtectionRule')
            ) {
              calls += 1;
              return {
                status: 200,
                headers: new Headers(),
                url: '/graphql',
                grantedAt: new Date(),
                body: {
                  errors: [
                    { type: 'FORBIDDEN', message: 'Resource not accessible by integration' },
                  ],
                },
              };
            }
            return real.request(req);
          };
        },
      }),
    };
    await expect(
      all(
        driver<import('@git-migrator/canonical').BranchRules>(h, 'branch-rules').apply?.(
          ctx,
          h.target('r'),
          { rules: [rule('main')] },
          null,
          [],
        ),
      ),
    ).rejects.toMatchObject({ code: 'forbidden', retryable: false });
    expect(calls).toBe(1);
  });
});
