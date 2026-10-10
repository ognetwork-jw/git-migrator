/** The adapter contract suite (TST-015) for the GitHub adapter, against the fake GitHub (TST-006). */
import { generateKeyPairSync } from 'node:crypto';
import { capabilities, createGitHubAdapter } from '@git-migrator/adapter-github';
import {
  type AdapterContext,
  type DriverContext,
  type FacetTarget,
  noopLogger,
} from '@git-migrator/adapter-sdk';
import {
  type BranchRule,
  type BranchRules,
  type CanonicalEvent,
  type FacetKey,
  scopedKey,
  type Webhook,
  webhookKey,
} from '@git-migrator/canonical';
import { createFakeGitHub } from '@git-migrator/provider-fakes';
import { expect } from 'vitest';
import {
  type AdapterContract,
  type ContractConnection,
  defineAdapterContract,
} from './contract.ts';

const BASE = 'http://localhost:4020';
const FILES = { 'README.md': '# hi\n', 'src/a.txt': 'a\n' };
const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';

type World = ReturnType<typeof createFakeGitHub>;

async function connect(): Promise<ContractConnection<World>> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const fake = createFakeGitHub({ appPublicKeyPem: publicKey, gitBaseUrl: BASE });
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
    leases: { acquire: async () => 1n, release: async () => {} },
    capture: { save: async () => 'raw' },
    logger: noopLogger,
    fetch: ((input: URL | string | Request, init?: RequestInit) =>
      fake.app.fetch(new Request(input, init))) as typeof fetch,
    environment: 'test',
    git,
    pool: 'interactive',
    signal: new AbortController().signal,
  };
  const conn = await createGitHubAdapter().connect(
    {
      id: 'gh',
      baseUrl: BASE,
      config: {
        org: 'acme',
        appId: fake.state.ownApp.id,
        installationId: [...fake.state.installations.keys()][0] as number,
        gitBaseUrl: BASE,
      },
      credential: privateKey,
      accountKey: 'acct',
    },
    adapterCtx,
  );
  const ctx: DriverContext = {
    http: conn.http,
    git,
    logger: noopLogger,
    pool: 'interactive',
    signal: adapterCtx.signal,
  };
  return { world: fake, conn, ctx };
}

const org = { providerId: '', slug: 'acme' };
const repoTarget = (name: string): FacetTarget => ({
  scope: 'repository',
  repository: { providerId: '', namespace: org, slug: name },
  namespace: org,
});

const KEY2 = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGRpZmZlcmVudGtleWJ5dGVzMDEyMzQ1Njc4OWFiY2RlZg';

async function seed(
  c: ContractConnection<World>,
  facet: FacetKey,
  target: FacetTarget,
  doc: unknown,
): Promise<void> {
  const driver = c.conn.facets[facet];
  for await (const _ of driver?.apply?.(c.ctx, target, doc, null, []) ?? []) void _;
}

const byKey = <T>(items: T[], key: (item: T) => string): T[] =>
  [...items].sort((a, b) => (key(a) < key(b) ? -1 : 1));

/** N3 (ADR-0231 section 1): apply keeps target-only items outside branch-rules. */
const keptTargetOnly = (expected: unknown) => ({
  id: 'N3' as const,
  adr: 'ADR-0250',
  reason: 'ADR-0231 section 1: apply keeps target-only items outside branch-rules',
  expected,
});
const endpointTarget: FacetTarget = { scope: 'endpoint', namespace: org };

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

const hook = (url: string, extra: Partial<Webhook> = {}): Webhook => ({
  key: webhookKey(url),
  url,
  events: ['push'] as CanonicalEvent[],
  active: true,
  hasSecret: false,
  verifyTls: true,
  ...extra,
});

const contract: AdapterContract<World> = {
  name: 'github',
  connect,
  capabilities,
  normalisations: { N1: 1, N2: 1, N3: 8, N4: 1 },
  scenarios: [
    {
      facet: 'repository-settings',
      name: 'description, features and forking',
      prepare: ({ world }) => {
        world.state.addRepository('acme', {
          name: 'r',
          private: true,
          description: 'a',
          files: FILES,
        });
        return {
          target: repoTarget('r'),
          desired: {
            description: 'new text',
            homepage: 'https://x.test',
            visibility: 'private',
            features: { issues: false, wiki: false },
            forking: 'disallowed',
          },
        };
      },
    },
    {
      facet: 'repository-settings',
      name: 'a private repository becomes public',
      prepare: ({ world }) => {
        world.state.addRepository('acme', {
          name: 'r',
          private: true,
          description: 'a',
          files: FILES,
        });
        return {
          target: repoTarget('r'),
          desired: {
            description: 'a',
            homepage: 'https://x.test',
            visibility: 'public',
            features: { issues: true, wiki: true },
            forking: 'allowed',
          },
        };
      },
    },
    {
      facet: 'merge-settings',
      name: 'strategies and delete-branch-on-merge',
      prepare: ({ world }) => {
        world.state.addRepository('acme', { name: 'r', files: FILES });
        return {
          target: repoTarget('r'),
          desired: { allowed: ['squash'], deleteBranchOnMerge: true },
        };
      },
    },
    {
      facet: 'access-control',
      name: 'a collaborator and a team',
      prepare: ({ world }) => {
        const s = world.state;
        s.addMember('acme', 'alice', 'admin');
        const bob = s.addMember('acme', 'bob');
        const team = s.addTeam('acme', { name: 'Platform', members: [] });
        s.addRepository('acme', { name: 'r', private: true, files: FILES });
        return {
          target: repoTarget('r'),
          desired: {
            grants: [
              { principal: { kind: 'group', id: String(team.id) }, role: 'admin' },
              { principal: { kind: 'identity', id: String(bob.id) }, role: 'triage' },
            ],
          },
        };
      },
    },
    {
      facet: 'branch-rules',
      name: 'two rules',
      prepare: ({ world }) => {
        world.state.addRepository('acme', { name: 'r', private: true, files: FILES });
        return {
          target: repoTarget('r'),
          desired: {
            rules: [
              rule('main'),
              rule('release/**/*', { blockForcePush: false, blockDeletion: false }),
            ],
          } satisfies BranchRules,
        };
      },
    },
    {
      facet: 'branch-rules',
      name: 'change-request rule with push restrictions and a force-push exemption',
      prepare: ({ world }) => {
        const s = world.state;
        const bob = s.addMember('acme', 'bob');
        const team = s.addTeam('acme', { name: 'devs', members: ['bob'] });
        const repo = s.addRepository('acme', { name: 'r', private: true, files: FILES });
        s.addCollaborator(repo, 'bob', 'push');
        s.grantTeam(repo, team, 'push');
        return {
          target: repoTarget('r'),
          desired: {
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
          } satisfies BranchRules,
        };
      },
    },
    {
      // ADR-0231 section 1: branch-rules is the one facet whose apply deletes target-only items,
      // so the read-back still equals the desired document without any normalisation.
      facet: 'branch-rules',
      name: 'a target-only rule is deleted',
      prepare: async ({ world, conn, ctx }) => {
        world.state.addRepository('acme', { name: 'r', private: true, files: FILES });
        const target = repoTarget('r');
        const driver = conn.facets['branch-rules'];
        const seeded: BranchRules = { rules: [rule('old/*')] };
        for await (const _ of driver?.apply?.(ctx, target, seeded, null, []) ?? []) void _;
        return { target, desired: { rules: [rule('main')] } satisfies BranchRules };
      },
    },
    {
      // ADR-0231 section 4: a refused force-push bypass list is dropped and the rule is created
      // without it, so the read-back has no exemption (ADR-0250, section 1).
      facet: 'branch-rules',
      name: 'a refused force-push bypass list yields exemptionsDropped',
      prepare: ({ world, conn, ctx }) => {
        const bob = world.state.addMember('acme', 'bob');
        const repo = world.state.addRepository('acme', { name: 'r', private: true, files: FILES });
        world.state.addCollaborator(repo, 'bob', 'push');
        const real = conn.http;
        const refusing = new Proxy(real, {
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
        });
        const desired: BranchRules = {
          rules: [
            rule('main', {
              forcePushExempt: [{ principal: { kind: 'identity', id: String(bob.id) } }],
            }),
          ],
        };
        return {
          target: repoTarget('r'),
          desired,
          ctx: { ...ctx, http: refusing },
          normalisation: {
            id: 'N2',
            adr: 'ADR-0250',
            reason: 'the provider refused the force-push bypass list, so it is dropped',
            expected: { rules: [rule('main')] } satisfies BranchRules,
          },
          checkRecords: (records) =>
            expect(records[0]?.resourceRef).toMatchObject({ exemptionsDropped: true }),
        };
      },
    },
    {
      facet: 'webhooks',
      name: 'a hook without a secret',
      prepare: ({ world }) => {
        world.state.addRepository('acme', { name: 'r', files: FILES });
        const events = ['cr.opened', 'cr.updated', 'cr.merged', 'cr.declined', 'push'] as const;
        return {
          target: repoTarget('r'),
          forbidden: ['abc123'],
          desired: {
            hooks: [
              hook('https://ci.example.test/hook?token=abc123', {
                events: [...events].sort() as CanonicalEvent[],
              }),
            ],
          },
        };
      },
    },
    {
      // FAC-WEB-003: a hook with a secret is created inactive; the secret value is unreadable, so
      // the read-back says `hasSecret` only when GitHub reports one.
      facet: 'webhooks',
      name: 'a hook with a secret is created inactive',
      prepare: ({ world }) => {
        world.state.addRepository('acme', { name: 'r', files: FILES });
        const desired = {
          hooks: [hook('https://ci.example.test/secret', { hasSecret: true, active: false })],
        };
        return {
          target: repoTarget('r'),
          desired,
          normalisation: {
            id: 'N1',
            adr: 'ADR-0250',
            reason:
              'FAC-WEB-003: a webhook with a secret is created inactive; the value is unreadable',
            expected: {
              hooks: [hook('https://ci.example.test/secret', { hasSecret: false, active: false })],
            },
          },
        };
      },
    },
    {
      facet: 'deploy-keys',
      name: 'a read-only key',
      prepare: ({ world }) => {
        world.state.addRepository('acme', { name: 'r', files: FILES });
        return {
          target: repoTarget('r'),
          desired: { keys: [{ publicKey: KEY, title: 'ci', readOnly: true }] },
        };
      },
    },
    {
      facet: 'variables',
      name: 'repository and environment variables',
      prepare: ({ world }) => {
        const repo = world.state.addRepository('acme', { name: 'r', files: FILES });
        world.state.addEnvironment(repo, 'prod');
        world.state.addVariable(repo, 'KEEP', 'k');
        const variables = [
          {
            key: scopedKey('environment:prod', 'REGION'),
            scope: 'environment:prod',
            name: 'REGION',
            value: 'eu',
          },
          { key: scopedKey('repository', 'KEEP'), scope: 'repository', name: 'KEEP', value: 'k2' },
          { key: scopedKey('repository', 'NEW'), scope: 'repository', name: 'NEW', value: 'n' },
        ].sort((a, b) => (a.key < b.key ? -1 : 1));
        return { target: repoTarget('r'), desired: { variables } };
      },
    },
    {
      // ADR-0231 section 1: apply never deletes a target-only variable, so it stays in the read-back.
      facet: 'variables',
      name: 'a target-only variable is kept',
      prepare: ({ world }) => {
        const repo = world.state.addRepository('acme', { name: 'r', files: FILES });
        world.state.addVariable(repo, 'MINE', 'm');
        const wanted = {
          key: scopedKey('repository', 'WANTED'),
          scope: 'repository',
          name: 'WANTED',
          value: 'w',
        };
        const mine = {
          key: scopedKey('repository', 'MINE'),
          scope: 'repository',
          name: 'MINE',
          value: 'm',
        };
        return {
          target: repoTarget('r'),
          desired: { variables: [wanted] },
          normalisation: {
            id: 'N3',
            adr: 'ADR-0250',
            reason: 'ADR-0231 section 1: apply keeps target-only items outside branch-rules',
            expected: { variables: [mine, wanted].sort((a, b) => (a.key < b.key ? -1 : 1)) },
          },
        };
      },
    },
    {
      facet: 'environments',
      name: 'custom deployment branches',
      prepare: ({ world }) => {
        const repo = world.state.addRepository('acme', { name: 'r', files: FILES });
        world.state.addEnvironment(repo, 'Production');
        return {
          target: repoTarget('r'),
          desired: {
            environments: [
              { name: 'Production', category: null, deploymentBranches: ['main', 'release/*'] },
              { name: 'staging', category: null, deploymentBranches: null },
            ],
          },
        };
      },
    },
    {
      // The Change Request that carries CODEOWNERS is merged between apply and the read-back
      // (fast-forward of the default branch), because the file only counts once it is on the
      // default branch (LIF-047).
      facet: 'code-ownership',
      name: 'CODEOWNERS delivered by a Change Request and merged',
      prepare: ({ world }) => {
        const s = world.state;
        const bob = s.addMember('acme', 'bob');
        const team = s.addTeam('acme', { name: 'devs' });
        const repo = s.addRepository('acme', { name: 'r', files: FILES });
        return {
          target: repoTarget('r'),
          desired: {
            owners: [
              {
                pattern: '*',
                principals: [
                  { principal: { kind: 'group', id: String(team.id) } },
                  { principal: { kind: 'identity', id: String(bob.id) } },
                ],
              },
            ],
          },
          settle: () => {
            const sha = repo.git.resolve('refs/heads/git-migrator/codeowners');
            if (!sha) throw new Error('the CODEOWNERS branch was not written');
            repo.git.refs.set(`refs/heads/${repo.defaultBranch}`, sha);
          },
        };
      },
    },
    {
      facet: 'teams',
      name: 'a team with an organization member',
      prepare: ({ world }) => {
        const bob = world.state.addMember('acme', 'bob');
        return {
          target: endpointTarget,
          desired: {
            teams: [
              {
                slug: 'platform',
                name: 'Platform',
                members: [{ principal: { kind: 'identity', id: String(bob.id) } }],
              },
            ],
          },
        };
      },
    },
    {
      facet: 'org-variables',
      name: 'an organization variable',
      prepare: () => ({
        target: endpointTarget,
        desired: { variables: [{ name: 'REGION', value: 'eu', visibility: 'all' }] },
      }),
    },
    {
      facet: 'org-webhooks',
      name: 'an organization hook',
      prepare: () => ({
        target: endpointTarget,
        desired: { hooks: [hook('https://ci.example.test/org')] },
      }),
    },
    {
      // N4: fields the capability matrix declares unsupported (ADP-014) are dropped by the
      // provider, and `enforcement` is always `enforced`. The outcome is asserted explicitly.
      facet: 'branch-rules',
      name: 'fields the provider cannot represent read back at their lossy values',
      prepare: ({ world }) => {
        const bob = world.state.addMember('acme', 'bob');
        const repo = world.state.addRepository('acme', { name: 'r', private: true, files: FILES });
        world.state.addCollaborator(repo, 'bob', 'push');
        const cr = {
          minApprovals: 1,
          requireCodeOwnerApproval: false,
          dismissStaleApprovals: false,
          requireNoChangesRequested: true,
          requireTasksResolved: false,
          requireUpToDate: false,
        };
        const exempt = [{ principal: { kind: 'identity' as const, id: String(bob.id) } }];
        return {
          target: repoTarget('r'),
          desired: {
            rules: [
              rule('main', {
                enforcement: 'advisory',
                restrictMerges: exempt,
                deletionExempt: exempt,
                changeRequest: { ...cr, minPassingBuilds: 3 },
              }),
            ],
          } satisfies BranchRules,
          normalisation: {
            id: 'N4',
            adr: 'ADR-0250',
            reason:
              'GitHub: enforcement is always enforced, merging is a push, no per-actor deletion exemption, build names unknown',
            expected: {
              rules: [
                rule('main', {
                  enforcement: 'enforced',
                  restrictMerges: null,
                  deletionExempt: [],
                  changeRequest: { ...cr, minPassingBuilds: 0 },
                }),
              ],
            } satisfies BranchRules,
          },
        };
      },
    },
    {
      // N3 (ADR-0231 section 1): target-only items are kept by apply, outside branch-rules.
      facet: 'webhooks',
      name: 'a target-only hook is kept',
      prepare: async (c) => {
        c.world.state.addRepository('acme', { name: 'r', files: FILES });
        const mine = hook('https://ci.example.test/mine');
        const wanted = hook('https://ci.example.test/wanted');
        await seed(c, 'webhooks', repoTarget('r'), { hooks: [mine] });
        return {
          target: repoTarget('r'),
          desired: { hooks: [wanted] },
          normalisation: keptTargetOnly({ hooks: byKey([mine, wanted], (h) => h.key) }),
        };
      },
    },
    {
      facet: 'org-webhooks',
      name: 'a target-only organization hook is kept',
      prepare: async (c) => {
        const mine = hook('https://ci.example.test/org-mine');
        const wanted = hook('https://ci.example.test/org-wanted');
        await seed(c, 'org-webhooks', endpointTarget, { hooks: [mine] });
        return {
          target: endpointTarget,
          desired: { hooks: [wanted] },
          normalisation: keptTargetOnly({ hooks: byKey([mine, wanted], (h) => h.key) }),
        };
      },
    },
    {
      facet: 'deploy-keys',
      name: 'a target-only key is kept',
      prepare: async (c) => {
        c.world.state.addRepository('acme', { name: 'r', files: FILES });
        const mine = { publicKey: KEY2, title: 'mine', readOnly: true };
        const wanted = { publicKey: KEY, title: 'ci', readOnly: true };
        await seed(c, 'deploy-keys', repoTarget('r'), { keys: [mine] });
        return {
          target: repoTarget('r'),
          desired: { keys: [wanted] },
          normalisation: keptTargetOnly({ keys: byKey([mine, wanted], (k) => k.publicKey) }),
        };
      },
    },
    {
      facet: 'environments',
      name: 'a target-only environment is kept',
      prepare: async (c) => {
        c.world.state.addRepository('acme', { name: 'r', files: FILES });
        const mine = { name: 'legacy', category: null, deploymentBranches: null };
        const wanted = { name: 'staging', category: null, deploymentBranches: ['main'] };
        await seed(c, 'environments', repoTarget('r'), { environments: [mine] });
        return {
          target: repoTarget('r'),
          desired: { environments: [wanted] },
          normalisation: keptTargetOnly({
            environments: byKey([mine, wanted], (e) => e.name),
          }),
        };
      },
    },
    {
      facet: 'teams',
      name: 'a target-only team is kept',
      prepare: async (c) => {
        const bob = c.world.state.addMember('acme', 'bob');
        const mine = { slug: 'legacy', name: 'legacy', members: [] };
        const wanted = {
          slug: 'platform',
          name: 'Platform',
          members: [{ principal: { kind: 'identity' as const, id: String(bob.id) } }],
        };
        await seed(c, 'teams', endpointTarget, { teams: [mine] });
        return {
          target: endpointTarget,
          desired: { teams: [wanted] },
          normalisation: keptTargetOnly({ teams: byKey([mine, wanted], (t) => t.slug) }),
        };
      },
    },
    {
      facet: 'org-variables',
      name: 'a target-only organization variable is kept',
      prepare: async (c) => {
        const mine = { name: 'MINE', value: 'm', visibility: 'all' as const };
        const wanted = { name: 'WANTED', value: 'w', visibility: 'all' as const };
        await seed(c, 'org-variables', endpointTarget, { variables: [mine] });
        return {
          target: endpointTarget,
          desired: { variables: [wanted] },
          normalisation: keptTargetOnly({ variables: byKey([mine, wanted], (v) => v.name) }),
        };
      },
    },
    {
      facet: 'access-control',
      name: 'a target-only grant is kept',
      prepare: async (c) => {
        const s = c.world.state;
        const bob = s.addMember('acme', 'bob');
        const dana = s.addMember('acme', 'dana');
        s.addRepository('acme', { name: 'r', private: true, files: FILES });
        const mine = {
          principal: { kind: 'identity' as const, id: String(bob.id) },
          role: 'write' as const,
        };
        const wanted = {
          principal: { kind: 'identity' as const, id: String(dana.id) },
          role: 'read' as const,
        };
        await seed(c, 'access-control', repoTarget('r'), { grants: [mine] });
        return {
          target: repoTarget('r'),
          desired: { grants: [wanted] },
          normalisation: keptTargetOnly({
            grants: byKey([mine, wanted], (g) => `${g.principal.kind}/${g.principal.id}`),
          }),
        };
      },
    },
    // Read-only Facets (write: false).
    {
      facet: 'git-refs',
      name: 'refs read through the git client',
      prepare: ({ world }) => {
        world.state.addRepository('acme', { name: 'r', files: FILES });
        return { target: repoTarget('r') };
      },
    },
    {
      facet: 'secrets',
      name: 'secret names, never values',
      prepare: ({ world }) => {
        const repo = world.state.addRepository('acme', { name: 'r', files: FILES });
        world.state.addSecret(repo, 'TOKEN');
        return { target: repoTarget('r') };
      },
    },
    {
      facet: 'pipelines',
      name: 'workflow files of the default branch',
      prepare: ({ world }) => {
        world.state.addRepository('acme', {
          name: 'r',
          files: { ...FILES, '.github/workflows/ci.yml': 'name: ci\n' },
        });
        return { target: repoTarget('r') };
      },
    },
    {
      facet: 'change-requests',
      name: 'an open pull request',
      prepare: ({ world }) => {
        const s = world.state;
        const repo = s.addRepository('acme', { name: 'r', files: FILES });
        s.addBranch(repo, 'feature', { ...FILES, 'f.txt': 'f\n' }, { from: 'main', message: 'f' });
        s.addPull(repo, { title: 'Feature', head: 'feature' });
        return { target: repoTarget('r') };
      },
    },
    {
      facet: 'members',
      name: 'organization members with roles',
      prepare: ({ world }) => {
        world.state.addMember('acme', 'alice', 'admin');
        world.state.addMember('acme', 'bob');
        return { target: endpointTarget };
      },
    },
    {
      facet: 'org-secrets',
      name: 'organization secret names',
      prepare: ({ world }) => {
        world.state.addSecret(world.state.requireOrg('acme'), 'ORG_SECRET');
        return { target: endpointTarget };
      },
    },
  ],
};

defineAdapterContract(contract);
