import type { FacetDriver } from '@git-migrator/adapter-sdk';
import type {
  AccessControl,
  BranchRule,
  BranchRules,
  Environments,
  Webhooks,
} from '@git-migrator/canonical';
import { webhookKey } from '@git-migrator/canonical';
import { describe, expect, it } from 'vitest';
import { partialMutations } from './change-requests.ts';
import { roleOf } from './facets/access.ts';
import { all, type Harness, setup } from './harness.test.ts';

const FILES = { 'README.md': '# hi\n', 'src/a.txt': 'a\n' };

const driver = <T>(h: Harness, key: string) =>
  h.conn.facets[key as keyof typeof h.conn.facets] as FacetDriver<T>;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const rule = (pattern: string, extra: Partial<BranchRule> = {}): BranchRule => ({
  pattern,
  enforcement: 'enforced',
  restrictPushes: null,
  restrictMerges: null,
  blockForcePush: true,
  forcePushExempt: [],
  blockDeletion: true,
  deletionExempt: [],
  changeRequest: null,
  ...extra,
});

describe('Change Request writer: partial failure', () => {
  const req = {
    purpose: 'ci',
    branch: 'git-migrator/ci',
    title: 'Add CI',
    body: 'b',
    files: [{ path: '.github/workflows/ci.yml', content: 'name: ci\n' }],
  };

  it('[LIF-045] a failure after the branch and commit keeps their records, and a retry adopts the branch', async () => {
    let failPulls = true;
    const h = await setup({
      intercept: (request) =>
        failPulls && request.method === 'POST' && request.url.endsWith('/pulls')
          ? json(500, { message: 'boom' })
          : undefined,
    });
    h.fake.state.addRepository('acme', { name: 'r', private: true, files: FILES });
    const writer = h.conn.changeRequests;
    if (!writer) throw new Error('no writer');
    let error: unknown;
    try {
      await writer.upsert(h.repo('r'), req);
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect(partialMutations(error).map((m) => `${m.action}:${String(m.resourceRef.kind)}`)).toEqual(
      ['create:ref', 'update:ref'],
    );
    failPulls = false;
    const retry = await writer.upsert(h.repo('r'), req);
    expect(retry.state).toBe('open');
    expect(retry.mutations.map((m) => `${m.action}:${String(m.resourceRef.kind)}`)).toEqual([
      'create:ref',
      'create:change-request',
    ]);
    expect(retry.mutations[0]?.resourceRef.adopted).toBe(true);
  });

  it('[LIF-047] the body links the Migration when the host supplies a link', async () => {
    const h = await setup({ migrationUrl: (repo) => `https://gm.test/migrations/${repo.slug}` });
    const repo = h.fake.state.addRepository('acme', { name: 'r', private: true, files: FILES });
    await h.conn.changeRequests?.upsert(h.repo('r'), req);
    expect(repo.pulls[0]?.body).toContain('https://gm.test/migrations/r');
    const again = await h.conn.changeRequests?.upsert(h.repo('r'), req);
    expect(again?.mutations).toEqual([]);
  });
});

describe('idempotent apply', () => {
  it('[FAC-ENV] an adopted environment with extra branch and tag policies is satisfied by a subset', async () => {
    const h = await setup();
    const repo = h.fake.state.addRepository('acme', { name: 'r', private: true, files: FILES });
    const env = h.fake.state.addEnvironment(repo, 'prod');
    env.deploymentBranchPolicy = { protectedBranches: false, customBranchPolicies: true };
    env.branchPolicies.push(
      { id: 1, nodeId: 'a', name: 'main', type: 'branch' },
      { id: 2, nodeId: 'b', name: 'extra', type: 'branch' },
      { id: 3, nodeId: 'c', name: 'v*', type: 'tag' },
    );
    const d = driver<Environments>(h, 'environments');
    const read = await d.read(h.ctx, h.target('r'));
    expect(read.data.environments[0]?.deploymentBranches).toEqual(['extra', 'main']);
    expect(read.warnings.map((w) => w.code)).toEqual(['environments.tag-policy-skipped']);
    const desired = {
      environments: [{ name: 'prod', category: null, deploymentBranches: ['main'] }],
    };
    expect(await all(d.apply?.(h.ctx, h.target('r'), desired, read.data, []))).toEqual([]);
    expect(await all(d.apply?.(h.ctx, h.target('r'), desired, null, []))).toEqual([]);
  });

  it('[FAC-ACL-002] an organization owner in desired is skipped on every apply', async () => {
    const h = await setup();
    const alice = h.fake.state.addMember('acme', 'alice', 'admin');
    h.fake.state.addRepository('acme', { name: 'r', private: true, files: FILES });
    const d = driver<AccessControl>(h, 'access-control');
    const desired = {
      grants: [
        { principal: { kind: 'identity' as const, id: String(alice.id) }, role: 'admin' as const },
      ],
    };
    expect(await all(d.apply?.(h.ctx, h.target('r'), desired, null, []))).toEqual([]);
    expect(await all(d.apply?.(h.ctx, h.target('r'), desired, null, []))).toEqual([]);
    expect(h.requests.filter((r) => r.url.includes('/collaborators/alice'))).toHaveLength(0);
  });

  async function refusing() {
    let refused = 0;
    const h = await setup();
    const s = h.fake.state;
    const bob = s.addMember('acme', 'bob');
    const repo = s.addRepository('acme', { name: 'r', private: true, files: FILES });
    s.addCollaborator(repo, 'bob', 'push');
    const real = h.ctx.http;
    const ctx = {
      ...h.ctx,
      http: new Proxy(real, {
        get(target, prop, receiver) {
          if (prop !== 'request') return Reflect.get(target, prop, receiver);
          return async (req: Parameters<typeof real.request>[0]) => {
            const input = (
              req.json as { variables?: { input?: Record<string, unknown> } } | undefined
            )?.variables?.input;
            const list = input?.bypassForcePushActorIds as string[] | undefined;
            if (req.path === '/graphql' && list && list.length > 0) {
              refused += 1;
              return {
                status: 200,
                headers: new Headers(),
                url: '/graphql',
                grantedAt: new Date(),
                body: { errors: [{ type: 'UNPROCESSABLE', message: 'bypass list refused' }] },
              };
            }
            return real.request(req);
          };
        },
      }),
    };
    return { h, ctx, bob, repo, refused: () => refused };
  }

  it('[FAC-BRR-002] a bypass list GitHub refuses is not written again on the next apply', async () => {
    const { h, ctx, bob, repo, refused } = await refusing();
    const d = driver<BranchRules>(h, 'branch-rules');
    const desired = {
      rules: [
        rule('main', {
          forcePushExempt: [{ principal: { kind: 'identity', id: String(bob.id) } }],
        }),
      ],
    };
    const first = await all(d.apply?.(ctx, h.target('r'), desired, null, []));
    expect(first).toHaveLength(1);
    expect(first[0]?.resourceRef.exemptionsDropped).toBe(true);
    const writes = () => h.requests.filter((r) => r.url.endsWith('/graphql')).length;
    const before = writes();
    const second = await all(d.apply?.(ctx, h.target('r'), desired, null, []));
    expect(second).toEqual([]);
    expect(repo.rules[0]?.allowsForcePushes).toBe(false);
    expect(refused()).toBe(2);
    // read, then the refused attempt (never sent): no mutation reached the fake.
    expect(writes() - before).toBe(1);
  });

  it('[FAC-BRR-002] an unresolvable exempt actor is recorded as dropped', async () => {
    const h = await setup();
    h.fake.state.addRepository('acme', { name: 'r', private: true, files: FILES });
    const out = await all(
      driver<BranchRules>(h, 'branch-rules').apply?.(
        h.ctx,
        h.target('r'),
        {
          rules: [
            rule('main', { forcePushExempt: [{ principal: { kind: 'identity', id: '999999' } }] }),
          ],
        },
        null,
        [],
      ),
    );
    expect(out[0]?.resourceRef.exemptionsDropped).toBe(true);
    expect(out[0]?.after).toMatchObject({ forcePushExempt: [] });
  });

  it('[FAC-BRR-002] required reviews do not depend on requireNoChangesRequested being set', async () => {
    const h = await setup();
    const repo = h.fake.state.addRepository('acme', { name: 'r', private: true, files: FILES });
    await all(
      driver<BranchRules>(h, 'branch-rules').apply?.(
        h.ctx,
        h.target('r'),
        {
          rules: [
            rule('main', {
              changeRequest: {
                minApprovals: 2,
                requireCodeOwnerApproval: false,
                dismissStaleApprovals: false,
                requireNoChangesRequested: false,
                requireTasksResolved: false,
                requireUpToDate: false,
                minPassingBuilds: 0,
              },
            }),
          ],
        },
        null,
        [],
      ),
    );
    expect(repo.rules[0]?.requiresApprovingReviews).toBe(true);
    expect(repo.rules[0]?.requiredApprovingReviewCount).toBe(2);
  });
});

describe('GraphQL limits inside a 200 response', () => {
  it('[JOB-045] RATE_LIMITED becomes a retryable rate_limited error, recorded with the quota service', async () => {
    const reset = Math.floor(Date.now() / 1000) + 120;
    const h = await setup({
      intercept: (request) =>
        request.url.endsWith('/graphql')
          ? json(
              200,
              { errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] },
              {
                'x-ratelimit-limit': '5000',
                'x-ratelimit-remaining': '0',
                'x-ratelimit-reset': String(reset),
                'x-ratelimit-resource': 'graphql',
              },
            )
          : undefined,
    });
    h.fake.state.addRepository('acme', { name: 'r', private: true, files: FILES });
    const d = driver<BranchRules>(h, 'branch-rules');
    await expect(d.read(h.ctx, h.target('r'))).rejects.toMatchObject({
      code: 'rate_limited',
      retryable: true,
    });
    expect(h.quota.calls.rateLimited.length).toBe(1);
    expect(h.quota.calls.rateLimited[0]?.retryAfterSeconds).toBeGreaterThan(60);
  });

  it('[FAC-BRR-002] a rate limit never triggers the no-bypass retry', async () => {
    let graphqlCalls = 0;
    const h = await setup();
    const s = h.fake.state;
    const bob = s.addMember('acme', 'bob');
    const repo = s.addRepository('acme', { name: 'r', private: true, files: FILES });
    s.addCollaborator(repo, 'bob', 'push');
    const real = h.ctx.http;
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
              graphqlCalls += 1;
              return {
                status: 200,
                headers: new Headers(),
                url: '/graphql',
                grantedAt: new Date(),
                body: { errors: [{ type: 'RATE_LIMITED', message: 'rate limited' }] },
              };
            }
            return real.request(req);
          };
        },
      }),
    };
    await expect(
      all(
        driver<BranchRules>(h, 'branch-rules').apply?.(
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
      ),
    ).rejects.toBeDefined();
    expect(graphqlCalls).toBe(1);
    expect(repo.rules).toHaveLength(0);
  });
});

describe('repositories.isEmpty and delete', () => {
  it('[LIF-077] a missing repository is not_found, not empty', async () => {
    const h = await setup();
    await expect(h.conn.repositories.isEmpty(h.repo('nope'))).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('[LIF-077] a tags-only repository is not empty', async () => {
    const h = await setup({
      intercept: (request) => {
        if (request.url.includes('/git/matching-refs/heads')) return json(200, []);
        if (request.url.includes('/git/matching-refs/tags')) {
          return json(200, [{ ref: 'refs/tags/v1', object: { sha: 'a'.repeat(40) } }]);
        }
        return undefined;
      },
    });
    h.fake.state.addRepository('acme', { name: 't', files: FILES });
    expect(await h.conn.repositories.isEmpty(h.repo('t'))).toBe(false);
  });

  it('[LIF-077] branches mean not empty, no refs means empty', async () => {
    const h = await setup();
    h.fake.state.addRepository('acme', { name: 'full', files: FILES });
    h.fake.state.addRepository('acme', { name: 'void' });
    expect(await h.conn.repositories.isEmpty(h.repo('full'))).toBe(false);
    expect(await h.conn.repositories.isEmpty(h.repo('void'))).toBe(true);
  });

  it('[LIF-077] delete refuses a repository that replaced the one that was created', async () => {
    const h = await setup();
    const created = await h.conn.repositories.create(h.org, {
      name: 'x',
      visibility: 'private',
      description: '',
    });
    await h.conn.repositories.delete({ ...h.repo('x'), providerId: created.providerId });
    h.fake.state.addRepository('acme', { name: 'x', files: FILES });
    await expect(
      h.conn.repositories.delete({ ...h.repo('x'), providerId: created.providerId }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await h.conn.inventory.findRepository(h.org, 'x')).not.toBeNull();
  });
});

describe('webhooks', () => {
  it('[ADP-061] hook lists are not captured, so credentials in URLs never reach a RawResponse', async () => {
    const h = await setup();
    const repo = h.fake.state.addRepository('acme', { name: 'r', files: FILES });
    h.fake.state.addHook(repo, {
      url: 'https://ci.example.test/path-credential-xyz?token=queryabc',
    });
    const read = await driver<Webhooks>(h, 'webhooks').read(h.ctx, h.target('r'));
    expect(read.rawResponseIds).toEqual([]);
    expect(JSON.stringify(h.captured)).not.toContain('path-credential-xyz');
    expect(JSON.stringify(h.captured)).not.toContain('queryabc');
  });

  it('[FAC-WEB-003] a hook with a secret is created inactive even if desired says active', async () => {
    const h = await setup();
    const repo = h.fake.state.addRepository('acme', { name: 'r', files: FILES });
    const url = 'https://ci.example.test/s';
    await all(
      driver<Webhooks>(h, 'webhooks').apply?.(
        h.ctx,
        h.target('r'),
        {
          hooks: [
            {
              key: webhookKey(url),
              url,
              events: ['push'],
              active: true,
              hasSecret: true,
              verifyTls: true,
            },
          ],
        },
        null,
        [],
      ),
    );
    expect(repo.hooks[0]?.active).toBe(false);
    expect(repo.hooks[0]?.config.secret).toBeUndefined();
  });
});

describe('invitations', () => {
  const now = new Date('2026-03-01T00:00:00Z');

  it('[AUTH-060] the daily cap is rate_limited for 24 h; a seat shortage stays invalid', async () => {
    let message = 'You have exceeded the limit of invitations for the last 24 hours';
    const h = await setup({
      now: () => now,
      clock: () => now.getTime(),
      intercept: (request) =>
        request.method === 'POST' && request.url.endsWith('/orgs/acme/invitations')
          ? json(422, { message: 'Validation Failed', errors: [{ message }] })
          : undefined,
    });
    await expect(
      h.conn.invitations?.invite({ email: 'a@test.local', teamIds: [] }),
    ).rejects.toMatchObject({
      code: 'rate_limited',
      retryAfterMs: 86_400_000,
      retryAt: new Date(now.getTime() + 86_400_000),
    });
    message = 'No available seats';
    await expect(
      h.conn.invitations?.invite({ email: 'a@test.local', teamIds: [] }),
    ).rejects.toMatchObject({
      code: 'invalid',
    });
  });

  it('[AUTH-060] a lost response is recovered from the pending list', async () => {
    let lose = true;
    const h = await setup({
      intercept: (request) =>
        lose && request.method === 'POST' && request.url.endsWith('/orgs/acme/invitations')
          ? json(422, {
              message: 'Validation Failed',
              errors: [{ message: 'user is already invited' }],
            })
          : undefined,
    });
    lose = false;
    const first = await h.conn.invitations?.invite({ email: 'dup@test.local', teamIds: [] });
    lose = true;
    const again = await h.conn.invitations?.invite({ email: 'DUP@test.local', teamIds: [] });
    expect(again?.providerInvitationId).toBe(first?.providerInvitationId);
  });
});

describe('connection details', () => {
  it('[FAC-GIT-005] any per-object LFS error counts as missing', async () => {
    const oid = 'a'.repeat(64);
    const h = await setup({
      intercept: (request) =>
        request.url.endsWith('/info/lfs/objects/batch')
          ? json(200, { objects: [{ oid, size: 0, error: { code: 410, message: 'gone' } }] })
          : undefined,
    });
    h.fake.state.addRepository('acme', { name: 'r', files: FILES });
    expect(await h.conn.lfs.missing(h.repo('r'), [oid, oid])).toEqual([oid]);
  });

  it('[LIF-045] setDefaultBranch marks an unchanged default branch as a no-op', async () => {
    const h = await setup();
    h.fake.state.addRepository('acme', { name: 'r', files: FILES });
    const record = await h.conn.refs.setDefaultBranch(h.repo('r'), 'main');
    expect(record.resourceRef.noop).toBe(true);
    // A no-op is never undone: its before and after are the same branch.
    expect(record.before).toBe(record.after);
  });

  it('[JOB-045] feedback uses the provider limit and the known window; unknown resources are ignored', async () => {
    const h = await setup({
      intercept: (request) =>
        request.url.endsWith('/orgs/acme')
          ? json(
              200,
              { id: 1, login: 'acme' },
              {
                'x-ratelimit-limit': '30',
                'x-ratelimit-remaining': '29',
                'x-ratelimit-resource': 'search',
              },
            )
          : request.url.includes('/repos/acme/zzz')
            ? json(404, {}, { 'x-ratelimit-limit': '9', 'x-ratelimit-resource': 'mystery' })
            : undefined,
    });
    h.quota.calls.feedback.length = 0;
    await h.conn.inventory.listNamespaces();
    await h.conn.inventory.findRepository(h.org, 'zzz');
    const seen = h.quota.calls.feedback.map((f) => [f.bucketKey.split(':')[2], f.limit]);
    expect(seen).toContainEqual(['search', 30]);
    expect(seen.map((x) => x[0])).not.toContain('mystery');
  });
});

describe('mapper details', () => {
  it('[FAC-ACL-002] roleOf falls back to permission flags for custom roles', () => {
    expect(roleOf({ role_name: 'security-lead', permissions: { push: true, pull: true } })).toBe(
      'write',
    );
    expect(roleOf({ role_name: 'x', permissions: { admin: true } })).toBe('admin');
    expect(roleOf({ role_name: 'x', permissions: { maintain: true } })).toBe('maintain');
    expect(roleOf({ role_name: 'x', permissions: { triage: true } })).toBe('triage');
    expect(roleOf({ role_name: 'x', permissions: { pull: true } })).toBe('read');
    expect(roleOf({ role_name: 'x', permissions: {} })).toBeUndefined();
  });

  it('[FAC-ACL-002] an unknown role is a warning, not a grant', async () => {
    const h = await setup({
      intercept: (request) =>
        request.url.includes('/repos/acme/r/collaborators')
          ? json(200, [
              { id: 5, login: 'zed', type: 'User', role_name: 'mystery', permissions: {} },
            ])
          : undefined,
    });
    h.fake.state.addRepository('acme', { name: 'r', files: FILES });
    const read = await driver<AccessControl>(h, 'access-control').read(h.ctx, h.target('r'));
    expect(read.data.grants).toEqual([]);
    expect(read.warnings.map((w) => w.code)).toEqual(['access-control.unknown-role']);
  });

  it('[FAC-MRG-001] disabled strategies are written, and no representable strategy leaves things alone', async () => {
    const h = await setup();
    const repo = h.fake.state.addRepository('acme', { name: 'r', files: FILES });
    const d = driver<{ allowed: string[]; deleteBranchOnMerge: boolean }>(h, 'merge-settings');
    const current = (await d.read(h.ctx, h.target('r'))).data;
    await all(
      d.apply?.(
        h.ctx,
        h.target('r'),
        { allowed: ['squash'], deleteBranchOnMerge: false },
        current,
        [],
      ),
    );
    expect([repo.allowMergeCommit, repo.allowSquashMerge, repo.allowRebaseMerge]).toEqual([
      false,
      true,
      false,
    ]);
    const now = (await d.read(h.ctx, h.target('r'))).data;
    const out = await all(
      d.apply?.(
        h.ctx,
        h.target('r'),
        { allowed: ['fast-forward-only'], deleteBranchOnMerge: false },
        now,
        [],
      ),
    );
    expect(out).toEqual([]);
    expect(repo.allowSquashMerge).toBe(true);
  });
});
