/**
 * Facet driver `undo` (LIF-077, ADP-012): every record a driver yields can be reverted, newest
 * first, and the target reads as it did before the apply. Against the fake GitHub (TST-006).
 */
import { AdapterError, type FacetDriver, type MutationRecord } from '@git-migrator/adapter-sdk';
import { type FacetKey, scopedKey, webhookKey } from '@git-migrator/canonical';
import { describe, expect, it } from 'vitest';
import { all, type Harness, setup } from '../harness.test.ts';
import { undoDirectory } from './common.ts';

const FILES = { 'README.md': '# hi\n', 'src/a.txt': 'a\n' };
const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';

function driver<T>(h: Harness, key: FacetKey): FacetDriver<T> {
  const d = h.conn.facets[key];
  if (!d) throw new Error(`no driver ${key}`);
  return d as FacetDriver<T>;
}

/** apply, then undo what it yielded newest first: the document reads as before. */
async function undoRoundTrip<T>(
  h: Harness,
  key: FacetKey,
  target: Parameters<FacetDriver<T>['read']>[1],
  desired: T,
): Promise<MutationRecord[]> {
  const d = driver<T>(h, key);
  const before = (await d.read(h.ctx, target)).data;
  const records = await all(d.apply?.(h.ctx, target, desired, before, []));
  expect(records.length).toBeGreaterThan(0);
  expect((await d.read(h.ctx, target)).data).not.toEqual(before);
  for (const record of [...records].reverse()) await d.undo?.(h.ctx, target, record);
  expect((await d.read(h.ctx, target)).data).toEqual(before);
  // Idempotent: a second undo of every record finds nothing left to revert.
  for (const record of [...records].reverse()) await d.undo?.(h.ctx, target, record);
  expect((await d.read(h.ctx, target)).data).toEqual(before);
  return records;
}

describe('repository-settings and merge-settings', () => {
  it('[LIF-077] undo restores the settings the apply changed', async () => {
    const h = await setup();
    h.fake.state.addRepository('acme', {
      name: 'r',
      private: true,
      description: 'a',
      files: FILES,
    });
    await undoRoundTrip(h, 'repository-settings', h.target('r'), {
      description: 'new text',
      homepage: null,
      visibility: 'private',
      features: { issues: false, wiki: false },
      forking: 'disallowed',
    });
  });

  it('[LIF-077] undo restores the merge strategies and delete-branch-on-merge', async () => {
    const h = await setup();
    h.fake.state.addRepository('acme', { name: 'r', files: FILES });
    await undoRoundTrip(h, 'merge-settings', h.target('r'), {
      allowed: ['squash'],
      deleteBranchOnMerge: true,
    });
  });
});

describe('webhooks', () => {
  const hook = (url: string, extra: Partial<import('@git-migrator/canonical').Webhook> = {}) => ({
    key: webhookKey(url),
    url,
    events: ['push'] as import('@git-migrator/canonical').CanonicalEvent[],
    active: true,
    hasSecret: false,
    verifyTls: true,
    ...extra,
  });

  it('[LIF-077] undo deletes a created hook', async () => {
    const h = await setup();
    const repo = h.fake.state.addRepository('acme', { name: 'r', files: FILES });
    await undoRoundTrip(h, 'webhooks', h.target('r'), {
      hooks: [hook('https://ci.example.test/hook')],
    });
    expect(repo.hooks).toHaveLength(0);
  });

  it('[LIF-077] undo of an update removes only the events it added and restores TLS', async () => {
    const h = await setup();
    const repo = h.fake.state.addRepository('acme', { name: 'r', files: FILES });
    const url = 'https://ci.example.test/h';
    h.fake.state.addHook(repo, { url, events: ['push', 'issues'], secret: 'shh-shh-shh' });
    const d = driver<{ hooks: ReturnType<typeof hook>[] }>(h, 'webhooks');
    const read = await d.read(h.ctx, h.target('r'));
    const out = await all(
      d.apply?.(
        h.ctx,
        h.target('r'),
        {
          hooks: [
            hook(url, {
              events: ['issue.any', 'push', 'repo.fork'],
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
    expect(repo.hooks[0]?.events.sort()).toEqual(['fork', 'issues', 'push']);
    for (const record of out) await d.undo?.(h.ctx, h.target('r'), record);
    expect(repo.hooks[0]?.events.sort()).toEqual(['issues', 'push']);
    expect(repo.hooks[0]?.config.insecure_ssl).toBe('0');
    expect(repo.hooks[0]?.config.secret).toBe('shh-shh-shh');
  });
});

describe('deploy-keys, environments and variables', () => {
  it('[LIF-077] undo deletes a created deploy key', async () => {
    const h = await setup();
    const repo = h.fake.state.addRepository('acme', { name: 'r', files: FILES });
    await undoRoundTrip(h, 'deploy-keys', h.target('r'), {
      keys: [{ publicKey: KEY, title: 'ci', readOnly: true }],
    });
    expect(repo.keys).toHaveLength(0);
  });

  it('[LIF-077] undo deletes a created environment and restores an updated one', async () => {
    const h = await setup();
    const repo = h.fake.state.addRepository('acme', { name: 'r', files: FILES });
    h.fake.state.addEnvironment(repo, 'Production');
    const records = await undoRoundTrip(h, 'environments', h.target('r'), {
      environments: [
        { name: 'Production', category: null, deploymentBranches: ['main', 'release/*'] },
        { name: 'staging', category: null, deploymentBranches: null },
      ],
    });
    expect(records.map((r) => r.action)).toEqual(['update', 'create']);
  });

  it('[LIF-077] undo deletes created variables and restores updated ones, in a repository and an environment', async () => {
    const h = await setup();
    const repo = h.fake.state.addRepository('acme', { name: 'r', files: FILES });
    h.fake.state.addEnvironment(repo, 'prod');
    h.fake.state.addVariable(repo, 'KEEP', 'k');
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
    const records = await undoRoundTrip(h, 'variables', h.target('r'), { variables });
    expect(records.map((r) => r.action).sort()).toEqual(['create', 'create', 'update']);
  });

  it('[LIF-077] undo of organization variables', async () => {
    const h = await setup();
    h.fake.state.addVariable(h.fake.state.requireOrg('acme'), 'KEEP', 'k');
    await undoRoundTrip(h, 'org-variables', h.endpointTarget(), {
      variables: [
        { name: 'KEEP', value: 'k2', visibility: 'all' as const },
        { name: 'NEW', value: 'n', visibility: 'all' as const },
      ],
    });
  });
});

describe('access-control', () => {
  it('[LIF-077] undo removes created grants and restores the role of an updated one', async () => {
    const h = await setup();
    const s = h.fake.state;
    s.addMember('acme', 'alice', 'admin');
    const bob = s.addMember('acme', 'bob');
    s.addMember('acme', 'dana');
    const team = s.addTeam('acme', { name: 'Platform', members: ['dana'] });
    const repo = s.addRepository('acme', { name: 'r', private: true, files: FILES });
    s.addCollaborator(repo, 'bob', 'push');
    const records = await undoRoundTrip(h, 'access-control', h.target('r'), {
      grants: [
        { principal: { kind: 'group' as const, id: String(team.id) }, role: 'admin' as const },
        { principal: { kind: 'identity' as const, id: String(bob.id) }, role: 'triage' as const },
      ],
    });
    expect(records.map((r) => r.action).sort()).toEqual(['create', 'update']);
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

  it('[LIF-077] undo deletes a created rule', async () => {
    const h = await setup();
    const repo = h.fake.state.addRepository('acme', { name: 'r', private: true, files: FILES });
    await undoRoundTrip(h, 'branch-rules', h.target('r'), { rules: [rule('main'), rule('dev')] });
    expect(repo.rules).toHaveLength(0);
  });

  it('[LIF-077] undo restores an updated rule and makes a lifted rule again', async () => {
    const h = await setup();
    const repo = h.fake.state.addRepository('acme', { name: 'r', private: true, files: FILES });
    const d = driver<import('@git-migrator/canonical').BranchRules>(h, 'branch-rules');
    await all(d.apply?.(h.ctx, h.target('r'), { rules: [rule('main'), rule('old')] }, null, []));
    const before = (await d.read(h.ctx, h.target('r'))).data;
    // The lift of step 3a and a later update.
    const lifted = await all(d.apply?.(h.ctx, h.target('r'), { rules: [rule('main')] }, null, []));
    expect(lifted.map((r) => r.action)).toEqual(['delete']);
    const changed = await all(
      d.apply?.(
        h.ctx,
        h.target('r'),
        { rules: [rule('main', { blockDeletion: false })] },
        null,
        [],
      ),
    );
    expect(changed.map((r) => r.action)).toEqual(['update']);
    for (const record of [...lifted, ...changed].reverse()) {
      await d.undo?.(h.ctx, h.target('r'), record);
    }
    expect((await d.read(h.ctx, h.target('r'))).data).toEqual(before);
    expect(repo.rules.map((r) => r.pattern).sort()).toEqual(['main', 'old']);
  });

  it('[LIF-077] undo does not delete a rule that was made again under the same pattern', async () => {
    const h = await setup();
    const repo = h.fake.state.addRepository('acme', { name: 'r', private: true, files: FILES });
    const d = driver<import('@git-migrator/canonical').BranchRules>(h, 'branch-rules');
    const [created] = await all(
      d.apply?.(h.ctx, h.target('r'), { rules: [rule('main')] }, null, []),
    );
    if (!created) throw new Error('no record');
    // Somebody deleted the rule and made a new one.
    await all(d.apply?.(h.ctx, h.target('r'), { rules: [] }, null, []));
    await all(d.apply?.(h.ctx, h.target('r'), { rules: [rule('main')] }, null, []));
    await d.undo?.(h.ctx, h.target('r'), created);
    expect(repo.rules.map((r) => r.pattern)).toEqual(['main']);
  });
});

describe('teams', () => {
  it('[LIF-077] undo removes a created membership, then the created team', async () => {
    const h = await setup();
    const bob = h.fake.state.addMember('acme', 'bob');
    const records = await undoRoundTrip(h, 'teams', h.endpointTarget(), {
      teams: [
        {
          slug: 'platform',
          name: 'Platform',
          members: [{ principal: { kind: 'identity' as const, id: String(bob.id) } }],
        },
      ],
    });
    expect(records.map((r) => r.resourceRef.kind)).toEqual(['team', 'team-membership']);
  });
});

describe('undo touches only what its record names (ADR-0467 round 2)', () => {
  const rule = (pattern: string, blockDeletion = true) => ({
    pattern,
    enforcement: 'enforced' as const,
    restrictPushes: null,
    restrictMerges: null,
    blockForcePush: true,
    forcePushExempt: [],
    blockDeletion,
    deletionExempt: [],
    changeRequest: null,
  });

  it('[LIF-077] a rule on another pattern that an operator tightened is not rewritten by an undo', async () => {
    const h = await setup();
    const repo = h.fake.state.addRepository('acme', { name: 'r', private: true, files: FILES });
    const d = driver<import('@git-migrator/canonical').BranchRules>(h, 'branch-rules');
    await all(d.apply?.(h.ctx, h.target('r'), { rules: [rule('main'), rule('ops')] }, null, []));
    const ops = repo.rules.find((r) => r.pattern === 'ops');
    if (!ops) throw new Error('no ops rule');
    const changed = await all(
      d.apply?.(h.ctx, h.target('r'), { rules: [rule('main', false), rule('ops')] }, null, []),
    );
    const mine = changed.find((c) => String(c.resourceRef.pattern) === 'main');
    if (!mine) throw new Error('no record for main');
    // Not representable in the canonical document: the framework does not manage it.
    ops.isAdminEnforced = true;
    ops.requireLastPushApproval = true;
    ops.allowsDeletions = true;
    const idBefore = ops.id;
    expect(await d.undo?.(h.ctx, h.target('r'), mine)).toBeUndefined();
    expect(repo.rules.find((r) => r.pattern === 'main')?.allowsDeletions).toBe(false);
    const after = repo.rules.find((r) => r.pattern === 'ops');
    expect(after?.id).toBe(idBefore);
    expect(after?.isAdminEnforced).toBe(true);
    expect(after?.requireLastPushApproval).toBe(true);
    expect(after?.allowsDeletions).toBe(true);
  });

  it('[LIF-077] a rule replaced since the update is left, and so is a lifted rule that exists again', async () => {
    const h = await setup();
    const repo = h.fake.state.addRepository('acme', { name: 'r', private: true, files: FILES });
    const d = driver<import('@git-migrator/canonical').BranchRules>(h, 'branch-rules');
    await all(d.apply?.(h.ctx, h.target('r'), { rules: [rule('main')] }, null, []));
    const [update] = await all(
      d.apply?.(h.ctx, h.target('r'), { rules: [rule('main', false)] }, null, []),
    );
    if (!update) throw new Error('no record');
    await all(d.apply?.(h.ctx, h.target('r'), { rules: [] }, null, []));
    await all(d.apply?.(h.ctx, h.target('r'), { rules: [rule('main')] }, null, []));
    expect(await d.undo?.(h.ctx, h.target('r'), update)).toEqual({
      left: { kind: 'branch-rule-replaced', name: 'main' },
    });
    const lifted = { ...update, action: 'delete' as const };
    expect(await d.undo?.(h.ctx, h.target('r'), lifted)).toEqual({
      left: { kind: 'branch-rule-exists', name: 'main' },
    });
    expect(repo.rules).toHaveLength(1);
  });

  async function teamWorld() {
    const h = await setup();
    const bob = h.fake.state.addMember('acme', 'bob');
    const d = driver<import('@git-migrator/canonical').Teams>(h, 'teams');
    const records = await all(
      d.apply?.(
        h.ctx,
        h.endpointTarget(),
        {
          teams: [
            {
              slug: 'platform',
              name: 'Platform',
              members: [{ principal: { kind: 'identity' as const, id: String(bob.id) } }],
            },
          ],
        },
        null,
        [],
      ),
    );
    const team = records.find((r) => r.resourceRef.kind === 'team');
    const membership = records.find((r) => r.resourceRef.kind === 'team-membership');
    if (!team || !membership) throw new Error('missing records');
    return { h, d, team, membership };
  }
  const slugs = (h: Harness) => h.fake.state.requireOrg('acme').teams.map((t) => t.slug);

  it('[LIF-077] the team record names the team by id, and a hand-made team that holds the slug now is never deleted', async () => {
    const { h, d, team, membership } = await teamWorld();
    expect(team.resourceRef.id).toEqual(expect.any(String));
    expect(membership.resourceRef.teamId).toBe(team.resourceRef.id);
    const org = h.fake.state.requireOrg('acme');
    org.teams.length = 0;
    h.fake.state.addTeam('acme', { name: 'Platform' });
    expect(slugs(h)).toEqual(['platform']);
    // Ours is gone: nothing to undo, and the hand-made team is untouched.
    expect(await d.undo?.(h.ctx, h.endpointTarget(), membership)).toBeUndefined();
    expect(await d.undo?.(h.ctx, h.endpointTarget(), team)).toBeUndefined();
    expect(slugs(h)).toEqual(['platform']);
  });

  it('[LIF-077] a team that has child teams is left: deleting it would delete them', async () => {
    const { h, d, team, membership } = await teamWorld();
    const parent = h.fake.state.requireOrg('acme').teams.find((t) => t.slug === 'platform');
    h.fake.state.addTeam('acme', { name: 'Child', parentId: parent?.id ?? null });
    await d.undo?.(h.ctx, h.endpointTarget(), membership);
    expect(await d.undo?.(h.ctx, h.endpointTarget(), team)).toEqual({
      left: { kind: 'group-has-children', name: 'platform' },
    });
    expect(slugs(h).sort()).toEqual(['child', 'platform']);
  });

  it('[LIF-077] a renamed team is left, not deleted under its new name', async () => {
    const { h, d, team } = await teamWorld();
    const rec = h.fake.state.requireOrg('acme').teams.find((t) => t.slug === 'platform');
    if (!rec) throw new Error('no team');
    rec.slug = 'platform-renamed';
    expect(await d.undo?.(h.ctx, h.endpointTarget(), team)).toEqual({
      left: { kind: 'group-renamed', name: 'platform-renamed' },
    });
    expect(slugs(h)).toEqual(['platform-renamed']);
  });

  it('[LIF-077] a grant for a principal nobody by that id holds is gone: undone, not left', async () => {
    const h = await setup();
    h.fake.state.addRepository('acme', { name: 'r', private: true, files: FILES });
    const record: MutationRecord = {
      facetKey: 'access-control',
      action: 'create',
      resourceRef: { kind: 'access-grant', repository: 'r', principal: 'identity:999999' },
      paths: [],
      before: null,
      after: { principal: { kind: 'identity', id: '999999' }, role: 'write' },
    };
    expect(await driver(h, 'access-control').undo?.(h.ctx, h.target('r'), record)).toBeUndefined();
  });

  it('[LIF-077] a user who left the organization but still holds a direct grant is matched by id on the repository and revoked', async () => {
    const h = await setup();
    const repo = h.fake.state.addRepository('acme', { name: 'r', private: true, files: FILES });
    // Not an organization member and not an outside collaborator of the organization listing,
    // but a direct collaborator of the repository.
    h.fake.state.addCollaborator(repo, 'carol', 'push');
    const carol = h.fake.state.findUser('carol');
    const record: MutationRecord = {
      facetKey: 'access-control',
      action: 'create',
      resourceRef: {
        kind: 'access-grant',
        repository: 'r',
        principal: `identity:${String(carol?.id)}`,
      },
      paths: [],
      before: null,
      after: { principal: { kind: 'identity', id: String(carol?.id) }, role: 'write' },
    };
    expect(await driver(h, 'access-control').undo?.(h.ctx, h.target('r'), record)).toBeUndefined();
    expect(repo.collaborators.has('carol')).toBe(false);
  });

  it('[LIF-077] a team or membership record without a provider id: gone when no team holds the slug, left when one does', async () => {
    const { h, d, team, membership } = await teamWorld();
    const legacy = (r: MutationRecord): MutationRecord => {
      const { id: _id, teamId: _teamId, ...rest } = r.resourceRef as Record<string, unknown>;
      return { ...r, resourceRef: rest };
    };
    // A team holds the slug: not provably ours, so it stays.
    expect(await d.undo?.(h.ctx, h.endpointTarget(), legacy(membership))).toEqual({
      left: { kind: 'group-unproven', name: 'platform' },
    });
    expect(await d.undo?.(h.ctx, h.endpointTarget(), legacy(team))).toEqual({
      left: { kind: 'group-unproven', name: 'platform' },
    });
    expect(slugs(h)).toEqual(['platform']);
    // Nobody holds it: gone.
    h.fake.state.requireOrg('acme').teams.length = 0;
    // (A new context is a new Run: the team list is read again.)
    const next = { ...h.ctx };
    expect(await d.undo?.(next, h.endpointTarget(), legacy(membership))).toBeUndefined();
    expect(await d.undo?.(next, h.endpointTarget(), legacy(team))).toBeUndefined();
  });

  it('[LIF-077] the team list is read once for all the records of a Run, and again after a team is deleted', async () => {
    const { h, d, team, membership } = await teamWorld();
    const lists = () =>
      h.requests.filter((r) => r.method === 'GET' && new URL(r.url).pathname === '/orgs/acme/teams')
        .length;
    const before = lists();
    await d.undo?.(h.ctx, h.endpointTarget(), membership);
    await d.undo?.(h.ctx, h.endpointTarget(), team);
    expect(lists() - before).toBe(1);
  });

  it('[LIF-077] a child team made after the team list was read is not deleted with its parent: the team is left', async () => {
    const { h, d, team, membership } = await teamWorld();
    // The membership's undo reads the team list for the Run.
    expect(await d.undo?.(h.ctx, h.endpointTarget(), membership)).toBeUndefined();
    const parent = h.fake.state.requireOrg('acme').teams.find((t) => t.slug === 'platform');
    h.fake.state.addTeam('acme', { name: 'Late', parentId: parent?.id ?? null });
    expect(await d.undo?.(h.ctx, h.endpointTarget(), team)).toEqual({
      left: { kind: 'group-has-children', name: 'platform' },
    });
    expect(slugs(h).sort()).toEqual(['late', 'platform']);
  });

  it('[LIF-077] a team renamed after the team list was read is left, not deleted and not counted as undone', async () => {
    const { h, d, team, membership } = await teamWorld();
    expect(await d.undo?.(h.ctx, h.endpointTarget(), membership)).toBeUndefined();
    const rec = h.fake.state.requireOrg('acme').teams.find((t) => t.slug === 'platform');
    if (!rec) throw new Error('no team');
    rec.slug = 'platform-later';
    expect(await d.undo?.(h.ctx, h.endpointTarget(), team)).toEqual({
      left: { kind: 'group-changed', name: 'platform' },
    });
    expect(slugs(h)).toEqual(['platform-later']);
    // The next attempt reads the list again and names the team as renamed.
    expect(await d.undo?.(h.ctx, h.endpointTarget(), team)).toEqual({
      left: { kind: 'group-renamed', name: 'platform-later' },
    });
  });

  it('[LIF-077] an environment goes back to the policy mode it had, and only the branch policies this apply added are removed', async () => {
    const h = await setup();
    const repo = h.fake.state.addRepository('acme', { name: 'r', files: FILES });
    const env = h.fake.state.addEnvironment(repo, 'Production');
    env.deploymentBranchPolicy = { protectedBranches: true, customBranchPolicies: false };
    const d = driver<import('@git-migrator/canonical').Environments>(h, 'environments');
    const [record] = await all(
      d.apply?.(
        h.ctx,
        h.target('r'),
        { environments: [{ name: 'Production', category: null, deploymentBranches: ['main'] }] },
        null,
        [],
      ),
    );
    if (!record) throw new Error('no record');
    expect(env.deploymentBranchPolicy?.customBranchPolicies).toBe(true);
    // An operator adds a policy after the apply.
    env.branchPolicies.push({ id: 9001, nodeId: 'BP_9001', name: 'ops/*', type: 'branch' });
    await d.undo?.(h.ctx, h.target('r'), record);
    expect(env.deploymentBranchPolicy).toEqual({
      protectedBranches: true,
      customBranchPolicies: false,
    });
    expect(env.branchPolicies.map((p) => p.name)).toEqual(['ops/*']);
  });
});

describe('findRepositoryById (ADR-0465 round 2)', () => {
  it('[LIF-077] finds a repository under its new name, says null only when the installation sees every repository, and refuses to tell otherwise', async () => {
    const h = await setup();
    const repo = h.fake.state.addRepository('acme', { name: 'r', files: FILES });
    const find = h.conn.inventory.findRepositoryById;
    if (!find) throw new Error('no findRepositoryById');
    const found = await find(repo.nodeId);
    expect(found?.slug).toBe('r');
    await expect(find('')).rejects.toSatisfy(
      (e) => e instanceof AdapterError && e.code === 'invalid',
    );
    const renamed = await h.fake.app.fetch(
      new Request('http://localhost:4020/repos/acme/r', {
        method: 'PATCH',
        headers: { authorization: `Bearer ${h.fake.token()}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'renamed' }),
      }),
    );
    expect(renamed.status).toBe(200);
    expect((await find(repo.nodeId))?.slug).toBe('renamed');
    h.fake.state.deleteRepository(repo);
    expect(await find(repo.nodeId)).toBeNull();
    // An installation limited to some repositories cannot tell "gone" from "not visible".
    const installation = [...h.fake.state.installations.values()][0];
    if (!installation) throw new Error('no installation');
    installation.repositorySelection = 'selected';
    await expect(find(repo.nodeId)).rejects.toSatisfy(
      (e) => e instanceof AdapterError && e.code === 'forbidden',
    );
  });
});

describe('a repository transferred to another owner (ADR-0465 round 4)', () => {
  it('[LIF-077] findRepositoryById says a public repository now under another owner is gone from the organization, even with a new repository on the old name', async () => {
    const h = await setup();
    h.fake.state.addOrg({ login: 'other' });
    const repo = h.fake.state.addRepository('acme', { name: 'app', private: false, files: FILES });
    h.fake.state.transferRepository(repo, 'other');
    const find = h.conn.inventory.findRepositoryById;
    if (!find) throw new Error('no findRepositoryById');
    // Still readable by id and by name to this installation, because it is public.
    expect(h.fake.state.findRepo('other', 'app')?.nodeId).toBe(repo.nodeId);
    expect(await find(repo.nodeId)).toBeNull();
    const fresh = h.fake.state.addRepository('acme', { name: 'app', files: FILES });
    expect(await find(repo.nodeId)).toBeNull();
    expect((await find(fresh.nodeId))?.slug).toBe('app');
  });

  it('[LIF-077] repositories.delete refuses with conflict when the name leads to a repository of another owner, and deletes nothing', async () => {
    const h = await setup();
    h.fake.state.addOrg({ login: 'other' });
    const repo = h.fake.state.addRepository('acme', { name: 'app', private: false, files: FILES });
    h.fake.state.transferRepository(repo, 'other');
    // The read of the old name follows the redirect to other/app, which has the same node id.
    await expect(
      h.conn.repositories.delete({
        providerId: repo.nodeId,
        namespace: { providerId: '', slug: 'acme' },
        slug: 'app',
      }),
    ).rejects.toSatisfy((e) => e instanceof AdapterError && e.code === 'conflict');
    expect(h.fake.state.findRepo('other', 'app')).toBeDefined();
    expect(
      h.requests.filter((r) => r.method === 'DELETE' && new URL(r.url).pathname.includes('/app')),
    ).toEqual([]);
  });
});

describe('owners and teams are compared by provider id (ADR-0465 round 5)', () => {
  it('[LIF-077] a repository of a renamed organization is still deleted: the owner is compared by id, not by login', async () => {
    const h = await setup();
    const repo = h.fake.state.addRepository('acme', { name: 'app', files: FILES });
    const orgId = String(h.fake.state.requireOrg('acme').id);
    h.fake.state.renameOrg('acme', 'acme-renamed');
    await h.conn.repositories.delete({
      providerId: repo.nodeId,
      namespace: { providerId: orgId, slug: 'acme' },
      slug: 'app',
    });
    expect(h.fake.state.findRepo('acme-renamed', 'app')).toBeUndefined();
  });

  async function renamedAndReplaced() {
    const h = await setup();
    const bob = h.fake.state.addMember('acme', 'bob');
    h.fake.state.addRepository('acme', { name: 'r', private: true, files: FILES });
    const teams = driver<import('@git-migrator/canonical').Teams>(h, 'teams');
    const records = await all(
      teams.apply?.(
        h.ctx,
        h.endpointTarget(),
        {
          teams: [
            {
              slug: 'platform',
              name: 'Platform',
              members: [{ principal: { kind: 'identity' as const, id: String(bob.id) } }],
            },
          ],
        },
        null,
        [],
      ),
    );
    const team = records.find((r) => r.resourceRef.kind === 'team');
    const membership = records.find((r) => r.resourceRef.kind === 'team-membership');
    if (!team || !membership) throw new Error('missing records');
    const org = h.fake.state.requireOrg('acme');
    const ours = org.teams.find((t) => t.slug === 'platform');
    if (!ours) throw new Error('no team');
    // The team list is read for the Run, then the team is renamed and another made on its slug.
    await undoDirectory(h.ctx, 'acme').teams();
    ours.slug = 'platform-old';
    const handMade = h.fake.state.addTeam('acme', { name: 'Platform' });
    handMade.members.set('bob', { role: 'member', state: 'active' });
    return { h, team, membership, ours, handMade };
  }

  it('[LIF-077] a membership undo reads the team again: a hand-made team on the slug keeps its member', async () => {
    const { h, membership, handMade } = await renamedAndReplaced();
    expect(await driver(h, 'teams').undo?.(h.ctx, h.endpointTarget(), membership)).toEqual({
      left: { kind: 'group-changed', name: 'platform' },
    });
    expect(handMade.members.has('bob')).toBe(true);
  });

  it('[LIF-077] a group grant undo reads the team again: a hand-made team on the slug keeps its grant', async () => {
    const { h, ours, handMade } = await renamedAndReplaced();
    const repo = h.fake.state.requireRepo('acme', 'r');
    h.fake.state.grantTeam(repo, handMade, 'push');
    const record: MutationRecord = {
      facetKey: 'access-control',
      action: 'create',
      resourceRef: { kind: 'access-grant', repository: 'r', principal: `group:${ours.id}` },
      paths: [],
      before: null,
      after: { principal: { kind: 'group', id: String(ours.id) }, role: 'write' },
    };
    expect(await driver(h, 'access-control').undo?.(h.ctx, h.target('r'), record)).toEqual({
      left: { kind: 'group-changed', name: 'platform' },
    });
    expect(handMade.repos.size).toBe(1);
  });
});

describe('a record the driver did not yield', () => {
  it('[LIF-077] is refused with invalid', async () => {
    const h = await setup();
    h.fake.state.addRepository('acme', { name: 'r', files: FILES });
    const record: MutationRecord = {
      facetKey: 'deploy-keys',
      action: 'update',
      resourceRef: { kind: 'something-else' },
      paths: [],
      before: null,
      after: null,
    };
    await expect(driver(h, 'deploy-keys').undo?.(h.ctx, h.target('r'), record)).rejects.toSatisfy(
      (e) => e instanceof AdapterError && e.code === 'invalid',
    );
  });
});
