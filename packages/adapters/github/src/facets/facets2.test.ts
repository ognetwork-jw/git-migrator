import type { FacetDriver } from '@git-migrator/adapter-sdk';
import { noopLogger } from '@git-migrator/adapter-sdk';
import { type FacetKey, scopedKey, webhookKey } from '@git-migrator/canonical';
import { describe, expect, it } from 'vitest';
import { all, type Harness, setup } from '../harness.test.ts';
import { fromGithubEvents, toGithubEvents } from './hooks.ts';

const FILES = { 'README.md': '# hi\n', 'src/a.txt': 'a\n' };

function driver<T>(h: Harness, key: FacetKey): FacetDriver<T> {
  const d = h.conn.facets[key];
  if (!d) throw new Error(`no driver ${key}`);
  return d as FacetDriver<T>;
}

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
  expect(await all(d.apply?.(h.ctx, target, desired, after.data, []))).toEqual([]);
  expect(await all(d.apply?.(h.ctx, target, desired, null, []))).toEqual([]);
  return { first, after, before };
}

const hook = (url: string, extra: Partial<import('@git-migrator/canonical').Webhook> = {}) => ({
  key: webhookKey(url),
  url,
  events: ['push'] as import('@git-migrator/canonical').CanonicalEvent[],
  active: true,
  hasSecret: false,
  verifyTls: true,
  ...extra,
});

describe('webhooks', () => {
  it('[FAC-WEB-001] maps canonical events to GitHub events and back (the covering set)', () => {
    expect(toGithubEvents(['cr.opened', 'cr.merged', 'push'])).toEqual(['pull_request', 'push']);
    expect(fromGithubEvents(['pull_request']).sort()).toEqual(
      ['cr.declined', 'cr.merged', 'cr.opened', 'cr.updated'].sort(),
    );
    expect(fromGithubEvents(['*'])).toHaveLength(12);
    expect(fromGithubEvents([])).toEqual([]);
  });

  it('[FAC-WEB-004] creates hooks with JSON content, applies idempotently', async () => {
    const h = await setup();
    const repo = h.fake.state.addRepository('acme', { name: 'r', files: FILES });
    const url = 'https://ci.example.test/hook?token=abc';
    const events = ['cr.opened', 'cr.updated', 'cr.merged', 'cr.declined', 'push'] as const;
    const { first } = await roundTrip(h, 'webhooks', h.target('r'), {
      hooks: [hook(url, { events: [...events].sort() as never })],
    });
    expect(first).toHaveLength(1);
    expect(repo.hooks[0]?.config.content_type).toBe('json');
    expect(repo.hooks[0]?.events).toEqual(['pull_request', 'push']);
    // The ledger never holds the credential-bearing URL.
    expect(JSON.stringify(first)).not.toContain('token=abc');
  });

  it('[FAC-WEB-003] a hook with a secret is created inactive and without one; activation is left to the human', async () => {
    const h = await setup();
    const repo = h.fake.state.addRepository('acme', { name: 'r', files: FILES });
    const url = 'https://ci.example.test/secret';
    await roundTrip(h, 'webhooks', h.target('r'), {
      hooks: [hook(url, { active: false, hasSecret: false })],
    });
    expect(repo.hooks[0]?.config.secret).toBeUndefined();
    expect(repo.hooks[0]?.active).toBe(false);
  });

  it('[FAC-WEB-003] a second apply never activates a target hook that has no secret', async () => {
    const h = await setup();
    const repo = h.fake.state.addRepository('acme', { name: 'r', files: FILES });
    const url = 'https://ci.example.test/twice';
    const d = driver<{ hooks: ReturnType<typeof hook>[] }>(h, 'webhooks');
    const desired = { hooks: [hook(url, { active: true, hasSecret: true })] };
    // First apply creates the hook inactive, because it has a secret that the target does not have.
    await all(
      d.apply?.(h.ctx, h.target('r'), desired, (await d.read(h.ctx, h.target('r'))).data, []),
    );
    expect(repo.hooks[0]?.active).toBe(false);
    // The second apply sees an inactive target hook without a secret; it must stay inactive.
    const read = await d.read(h.ctx, h.target('r'));
    await all(d.apply?.(h.ctx, h.target('r'), desired, read.data, []));
    expect(repo.hooks[0]?.active).toBe(false);
  });

  it('[FAC-WEB-003] never deactivates a hook that has a secret and updates missing events and TLS', async () => {
    const h = await setup();
    const repo = h.fake.state.addRepository('acme', { name: 'r', files: FILES });
    const url = 'https://ci.example.test/h';
    h.fake.state.addHook(repo, { url, events: ['push'], secret: 'shh-shh-shh' });
    const d = driver<{ hooks: ReturnType<typeof hook>[] }>(h, 'webhooks');
    const read = await d.read(h.ctx, h.target('r'));
    expect(read.data.hooks[0]).toMatchObject({ hasSecret: true, active: true });
    const out = await all(
      d.apply?.(
        h.ctx,
        h.target('r'),
        {
          hooks: [
            hook(url, {
              events: ['issue.any', 'push'],
              active: false,
              hasSecret: true,
              verifyTls: false,
            }),
          ],
        },
        read.data,
        [],
      ),
    );
    expect(out).toHaveLength(1);
    expect(repo.hooks[0]?.active).toBe(true);
    expect(repo.hooks[0]?.events.sort()).toEqual(['issues', 'push']);
    expect(repo.hooks[0]?.config.insecure_ssl).toBe('1');
    expect(repo.hooks[0]?.config.secret).toBe('shh-shh-shh');
  });

  it('[FAC-WEB-002] reads hooks with the same URL as one and reports webhooks.duplicate-url without the URL', async () => {
    const h = await setup();
    const repo = h.fake.state.addRepository('acme', { name: 'r', files: FILES });
    const url = 'https://ci.example.test/dup?secret=zzz';
    h.fake.state.addHook(repo, { url, events: ['push'] });
    h.fake.state.addHook(repo, { url, events: ['issues'], active: false });
    const read = await driver<{ hooks: ReturnType<typeof hook>[] }>(h, 'webhooks').read(
      h.ctx,
      h.target('r'),
    );
    expect(read.data.hooks).toHaveLength(1);
    expect(read.data.hooks[0]).toMatchObject({ events: ['issue.any', 'push'], active: true });
    expect(read.warnings).toEqual([
      expect.objectContaining({
        code: 'webhooks.duplicate-url',
        params: { targetUrlDisplay: 'https://ci.example.test/…', count: 2 },
      }),
    ]);
    expect(JSON.stringify(read.warnings)).not.toContain('zzz');
  });

  it('[FAC-WEB-001] org hooks use the same mapping at organization scope', async () => {
    const h = await setup();
    const url = 'https://ci.example.test/org';
    await roundTrip(h, 'org-webhooks', h.endpointTarget(), { hooks: [hook(url)] });
    expect(h.fake.state.requireOrg('acme').hooks).toHaveLength(1);
  });
});

describe('deploy-keys', () => {
  const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';

  it('[FAC-DKY-002] reads keys without their comment and creates read-only keys idempotently', async () => {
    const h = await setup();
    const repo = h.fake.state.addRepository('acme', { name: 'r', files: FILES });
    const { first } = await roundTrip(h, 'deploy-keys', h.target('r'), {
      keys: [{ publicKey: KEY, title: 'ci', readOnly: true }],
    });
    expect(first).toHaveLength(1);
    expect(repo.keys[0]?.readOnly).toBe(true);
    const read = await driver(h, 'deploy-keys').read(h.ctx, h.target('r'));
    expect(JSON.stringify(read.data)).not.toContain('comment');
  });

  it('[FAC-DKY-002] normalizes a key that carries a comment', async () => {
    const h = await setup();
    const repo = h.fake.state.addRepository('acme', { name: 'r', files: FILES });
    h.fake.state.addDeployKey(repo, { key: `${KEY} someone@host`, title: 't' });
    const read = await driver<{ keys: { publicKey: string }[] }>(h, 'deploy-keys').read(
      h.ctx,
      h.target('r'),
    );
    expect(read.data.keys[0]?.publicKey).toBe(KEY);
  });

  it('[FAC-DKY-002] a key already in use elsewhere is skipped, not fatal', async () => {
    const h = await setup();
    const other = h.fake.state.addRepository('acme', { name: 'other', files: FILES });
    h.fake.state.addRepository('acme', { name: 'r', files: FILES });
    h.fake.state.addDeployKey(other, { key: KEY, title: 'x' });
    const warnings: Record<string, unknown>[] = [];
    const ctx = {
      ...h.ctx,
      logger: { ...h.ctx.logger, warn: (f: Record<string, unknown>) => void warnings.push(f) },
    };
    const d = driver<import('@git-migrator/canonical').DeployKeys>(h, 'deploy-keys');
    const out = await all(
      d.apply?.(
        ctx,
        h.target('r'),
        { keys: [{ publicKey: KEY, title: 'ci', readOnly: true }] },
        { keys: [] },
        [],
      ),
    );
    expect(out).toEqual([]);
    expect(warnings[0]).toMatchObject({ finding: 'deploy-keys.key-in-use' });
  });
});

describe('environments, variables and secrets', () => {
  it('[FAC-ENV] reads and applies environments with custom deployment branches', async () => {
    const h = await setup();
    const repo = h.fake.state.addRepository('acme', { name: 'r', files: FILES });
    h.fake.state.addEnvironment(repo, 'Production');
    const { first } = await roundTrip(h, 'environments', h.target('r'), {
      environments: [
        { name: 'Production', category: null, deploymentBranches: ['main', 'release/*'] },
        { name: 'staging', category: null, deploymentBranches: null },
      ],
    });
    expect(first.map((m) => m.action)).toEqual(['update', 'create']);
  });

  it('[FAC-ENV] a subset apply warns about the target-only deployment branch policies and removes none', async () => {
    const warnings: Record<string, unknown>[] = [];
    const h = await setup();
    h.fake.state.addRepository('acme', { name: 'r', files: FILES });
    const d = driver<{
      environments: { name: string; category: null; deploymentBranches: string[] | null }[];
    }>(h, 'environments');
    await roundTrip(h, 'environments', h.target('r'), {
      environments: [
        { name: 'prod', category: null, deploymentBranches: ['dev', 'main', 'release/*'] },
      ],
    });
    const ctx = {
      ...h.ctx,
      logger: { ...noopLogger, warn: (f: Record<string, unknown>) => warnings.push(f) },
    };
    const read = await d.read(h.ctx, h.target('r'));
    const out = await all(
      d.apply?.(
        ctx,
        h.target('r'),
        { environments: [{ name: 'prod', category: null, deploymentBranches: ['main'] }] },
        read.data,
        [],
      ),
    );
    expect(out).toEqual([]);
    expect(warnings).toEqual([
      expect.objectContaining({ environment: 'prod', extraPolicies: ['dev', 'release/*'] }),
    ]);
    expect(
      ((await d.read(h.ctx, h.target('r'))).data.environments[0]?.deploymentBranches ?? []).sort(),
    ).toEqual(['dev', 'main', 'release/*']);
  });

  it('[FAC-ENV] a policy POST that fails after the PUT still leaves the environment create ledgered', async () => {
    const h = await setup({
      intercept: (r) =>
        r.method === 'POST' && r.url.includes('/deployment-branch-policies')
          ? new Response('{"message":"Validation Failed"}', {
              status: 422,
              headers: { 'content-type': 'application/json' },
            })
          : undefined,
    });
    h.fake.state.addRepository('acme', { name: 'r', files: FILES });
    const d = driver<{
      environments: { name: string; category: null; deploymentBranches: string[] | null }[];
    }>(h, 'environments');
    const yielded: string[] = [];
    await expect(
      (async () => {
        for await (const m of d.apply?.(
          h.ctx,
          h.target('r'),
          { environments: [{ name: 'staging', category: null, deploymentBranches: ['main'] }] },
          null,
          [],
        ) ?? []) {
          yielded.push(`${m.action}:${String(m.resourceRef.name)}`);
        }
      })(),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(yielded).toEqual(['create:staging']);
  });

  it('[FAC-ENV] never sends reviewers or wait timers', async () => {
    const h = await setup({ config: { environmentProtection: 'reject' } });
    h.fake.state.addRepository('acme', { name: 'r', private: true, files: FILES });
    await roundTrip(h, 'environments', h.target('r'), {
      environments: [{ name: 'e', category: null, deploymentBranches: null }],
    });
  });

  it('[FAC-VAR-002] reads and writes repository and environment variables', async () => {
    const h = await setup();
    const repo = h.fake.state.addRepository('acme', { name: 'r', files: FILES });
    h.fake.state.addEnvironment(repo, 'prod');
    h.fake.state.addVariable(repo, 'KEEP', 'k');
    const desired = {
      variables: [
        {
          key: scopedKey('environment:prod', 'REGION'),
          scope: 'environment:prod',
          name: 'REGION',
          value: 'eu',
        },
        { key: scopedKey('repository', 'KEEP'), scope: 'repository', name: 'KEEP', value: 'k2' },
        { key: scopedKey('repository', 'NEW'), scope: 'repository', name: 'NEW', value: 'n' },
      ],
    };
    const sorted = { variables: [...desired.variables].sort((a, b) => (a.key < b.key ? -1 : 1)) };
    const { first } = await roundTrip(h, 'variables', h.target('r'), sorted);
    expect(first.map((m) => m.action).sort()).toEqual(['create', 'create', 'update']);
  });

  it('[FAC-VAR-002] pages variables of 30', async () => {
    const h = await setup();
    const repo = h.fake.state.addRepository('acme', { name: 'r', files: FILES });
    for (let i = 0; i < 35; i++)
      h.fake.state.addVariable(repo, `V${String(i).padStart(2, '0')}`, String(i));
    const read = await driver<{ variables: unknown[] }>(h, 'variables').read(h.ctx, h.target('r'));
    expect(read.data.variables).toHaveLength(35);
  });

  it('[FAC-SEC-001] secrets are read as names only and are never written', async () => {
    const h = await setup();
    const repo = h.fake.state.addRepository('acme', { name: 'r', files: FILES });
    h.fake.state.addSecret(repo, 'TOKEN');
    h.fake.state.addEnvironment(repo, 'prod');
    const prod = repo.environments[0];
    if (prod) h.fake.state.addSecret(prod, 'DEPLOY');
    const d = driver<{ secrets: { key: string }[] }>(h, 'secrets');
    const read = await d.read(h.ctx, h.target('r'));
    expect(read.data.secrets.map((s) => s.key)).toEqual([
      'environment:prod/DEPLOY',
      'repository/TOKEN',
    ]);
    expect(d.apply).toBeUndefined();
  });

  it('[FAC-VAR] org variables and secrets (ADR-0087)', async () => {
    const h = await setup();
    h.fake.state.addSecret(h.fake.state.requireOrg('acme'), 'ORG_SECRET');
    await roundTrip(h, 'org-variables', h.endpointTarget(), {
      variables: [{ name: 'REGION', value: 'eu', visibility: 'all' as const }],
    });
    const secrets = await driver<{ secrets: { name: string }[] }>(h, 'org-secrets').read(
      h.ctx,
      h.endpointTarget(),
    );
    expect(secrets.data.secrets).toEqual([{ name: 'ORG_SECRET' }]);
  });
});

describe('pipelines, change-requests, members, teams', () => {
  it('[FAC-PIP-001] reads the workflow files of the default branch with their sha256', async () => {
    const h = await setup();
    h.fake.state.addRepository('acme', {
      name: 'r',
      files: {
        ...FILES,
        '.github/workflows/ci.yml': 'name: ci\n',
        '.github/workflows/notes.txt': 'x',
      },
    });
    const read = await driver<import('@git-migrator/canonical').Pipelines>(h, 'pipelines').read(
      h.ctx,
      h.target('r'),
    );
    expect(read.data.files).toEqual([
      { path: '.github/workflows/ci.yml', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);
    expect(driver(h, 'pipelines').apply).toBeUndefined();
  });

  it('[FAC-PIP-001] a repository without workflows has none', async () => {
    const h = await setup();
    h.fake.state.addRepository('acme', { name: 'r', files: FILES });
    h.fake.state.addRepository('acme', { name: 'empty' });
    for (const name of ['r', 'empty']) {
      const read = await driver<import('@git-migrator/canonical').Pipelines>(h, 'pipelines').read(
        h.ctx,
        h.target(name),
      );
      expect(read.data.files).toEqual([]);
    }
  });

  it('[FAC-CRQ] lists open change requests but ignores the framework ones', async () => {
    const h = await setup();
    const s = h.fake.state;
    const repo = s.addRepository('acme', { name: 'r', files: FILES });
    s.addBranch(repo, 'feature', { ...FILES, 'f.txt': 'f\n' }, { from: 'main', message: 'f' });
    s.addBranch(
      repo,
      'git-migrator/ci',
      { ...FILES, 'g.txt': 'g\n' },
      { from: 'main', message: 'g' },
    );
    s.addPull(repo, { title: 'Feature', head: 'feature' });
    s.addPull(repo, { title: 'Framework', head: 'git-migrator/ci' });
    const read = await driver<import('@git-migrator/canonical').ChangeRequests>(
      h,
      'change-requests',
    ).read(h.ctx, h.target('r'));
    expect(read.data.open).toEqual([expect.objectContaining({ id: '1', title: 'Feature' })]);
  });

  it('[FAC-END] members with roles', async () => {
    const h = await setup();
    const alice = h.fake.state.addMember('acme', 'alice', 'admin');
    const bob = h.fake.state.addMember('acme', 'bob');
    const read = await driver<import('@git-migrator/canonical').Members>(h, 'members').read(
      h.ctx,
      h.endpointTarget(),
    );
    expect(read.data.members).toEqual([
      { principal: { kind: 'identity', id: String(alice.id) }, role: 'admin' },
      { principal: { kind: 'identity', id: String(bob.id) }, role: 'member' },
    ]);
    expect(driver(h, 'members').apply).toBeUndefined();
  });

  it('[FAC-END] creates teams and adds only organization members (AUTH-061)', async () => {
    const h = await setup();
    const bob = h.fake.state.addMember('acme', 'bob');
    const carol = h.fake.state.addUser({ login: 'carol', email: 'c@test.local' });
    const desired = {
      teams: [
        {
          slug: 'platform',
          name: 'Platform',
          members: [{ principal: { kind: 'identity' as const, id: String(bob.id) } }],
        },
      ],
    };
    const { first } = await roundTrip(h, 'teams', h.endpointTarget(), desired);
    expect(first.map((m) => m.resourceRef.kind)).toEqual(['team', 'team-membership']);
    const d = driver<import('@git-migrator/canonical').Teams>(h, 'teams');
    const current = (await d.read(h.ctx, h.endpointTarget())).data;
    const out = await all(
      d.apply?.(
        h.ctx,
        h.endpointTarget(),
        {
          teams: [
            {
              ...desired.teams[0],
              members: [
                ...(desired.teams[0]?.members ?? []),
                { principal: { kind: 'identity', id: String(carol.id) } },
              ],
            } as never,
          ],
        },
        current,
        [],
      ),
    );
    expect(out).toEqual([]);
    expect(h.requests.filter((r) => r.url.includes('/memberships/carol'))).toHaveLength(0);
  });

  it('[FAC-END] a team whose name would not slugify to the slug is created under the slug', async () => {
    const h = await setup();
    await roundTrip(
      h,
      'teams',
      h.endpointTarget(),
      {
        teams: [{ slug: 'ops', name: 'Platform Ops', members: [] }],
      },
      { teams: [{ slug: 'ops', name: 'ops', members: [] }] },
    );
  });
});
