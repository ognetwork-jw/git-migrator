import { readFileSync } from 'node:fs';
import { buildSchema, parse, validate } from 'graphql';
import { describe, expect, it } from 'vitest';
import { must, type World, world } from './harness.ts';
import { canForcePush } from './rules.ts';

const gql = (w: World, query: string, variables?: Record<string, unknown>) =>
  w.call('POST', '/graphql', { body: { query, variables } });

const CREATE = `mutation($input: CreateBranchProtectionRuleInput!) {
  createBranchProtectionRule(input: $input) {
    clientMutationId
    branchProtectionRule {
      id pattern allowsForcePushes blocksCreations restrictsPushes allowsDeletions isAdminEnforced
      requiresApprovingReviews requiredApprovingReviewCount requiresStatusChecks requiresStrictStatusChecks
      requiredStatusCheckContexts requiredStatusChecks { context app { slug } }
      bypassForcePushAllowances(first: 10) { totalCount nodes { actor { __typename ... on User { login } ... on Team { slug } ... on App { slug } } } }
      pushAllowances(first: 10) { nodes { actor { __typename ... on User { login } ... on Team { combinedSlug } ... on App { slug } } } }
    }
  }
}`;

function setup() {
  const w = world();
  const s = w.fake.state;
  const bob = must(s.findUser('bob'));
  const team = s.addTeam('acme', { name: 'plat', members: ['bob'] });
  s.addCollaborator(w.repo, 'bob', 'push');
  s.grantTeam(w.repo, team, 'push');
  return { w, s, bob, team, app: s.ownApp };
}

describe('GraphQL branch protection subset', () => {
  it('[FAC-BRR-002] createBranchProtectionRule round trips every mapped field (ADR-0014)', async () => {
    const { w, bob, team, app } = setup();
    const res = await gql(w, CREATE, {
      input: {
        repositoryId: w.repo.nodeId,
        pattern: 'release/**/*',
        clientMutationId: 'm1',
        requiresApprovingReviews: true,
        requiredApprovingReviewCount: 2,
        requiresStatusChecks: true,
        requiresStrictStatusChecks: true,
        requiredStatusChecks: [{ context: 'ci/build' }, { context: 'lint', appId: app.nodeId }],
        restrictsPushes: true,
        pushActorIds: [bob.nodeId, team.nodeId, app.nodeId],
        allowsForcePushes: false,
        bypassForcePushActorIds: [bob.nodeId],
        allowsDeletions: false,
        isAdminEnforced: true,
        blocksCreations: true,
      },
    });
    expect(res.body.errors).toBeUndefined();
    const rule = res.body.data.createBranchProtectionRule.branchProtectionRule;
    expect(res.body.data.createBranchProtectionRule.clientMutationId).toBe('m1');
    expect(rule).toMatchObject({
      pattern: 'release/**/*',
      allowsForcePushes: false,
      blocksCreations: true,
      restrictsPushes: true,
      requiredApprovingReviewCount: 2,
      requiresStrictStatusChecks: true,
      isAdminEnforced: true,
      requiredStatusCheckContexts: ['ci/build', 'lint'],
    });
    expect(rule.bypassForcePushAllowances.nodes[0].actor).toEqual({
      __typename: 'User',
      login: 'bob',
    });
    expect(
      rule.pushAllowances.nodes.map((n: { actor: { __typename: string } }) => n.actor.__typename),
    ).toEqual(['User', 'Team', 'App']);
    expect(rule.pushAllowances.nodes[1].actor.combinedSlug).toBe('acme/plat');
    expect(rule.requiredStatusChecks[1]).toEqual({
      context: 'lint',
      app: { slug: 'git-migrator-fake' },
    });
  });

  it('[FAC-BRR-002] allowsForcePushes and the bypass list are stored independently (ADR-0040)', async () => {
    const { w, bob } = setup();
    const created = await gql(w, CREATE, {
      input: {
        repositoryId: w.repo.nodeId,
        pattern: 'main',
        allowsForcePushes: true,
        bypassForcePushActorIds: [bob.nodeId],
      },
    });
    const rule = created.body.data.createBranchProtectionRule.branchProtectionRule;
    expect(rule.allowsForcePushes).toBe(true);
    expect(rule.bypassForcePushAllowances.totalCount).toBe(1);
    const upd = await gql(
      w,
      `mutation($id: ID!) { updateBranchProtectionRule(input:{branchProtectionRuleId:$id, allowsForcePushes:false}) { branchProtectionRule { allowsForcePushes bypassForcePushAllowances(first:5) { totalCount } } } }`,
      { id: rule.id },
    );
    expect(upd.body.data.updateBranchProtectionRule.branchProtectionRule).toEqual({
      allowsForcePushes: false,
      bypassForcePushAllowances: { totalCount: 1 },
    });
    const clear = await gql(
      w,
      `mutation($id: ID!) { updateBranchProtectionRule(input:{branchProtectionRuleId:$id, bypassForcePushActorIds:[]}) { branchProtectionRule { allowsForcePushes bypassForcePushAllowances(first:5) { totalCount } } } }`,
      { id: rule.id },
    );
    expect(clear.body.data.updateBranchProtectionRule.branchProtectionRule).toEqual({
      allowsForcePushes: false,
      bypassForcePushAllowances: { totalCount: 0 },
    });
  });

  it('[FAC-BRR-002] canForcePush: bypass actors may force push when allowsForcePushes is false (fail-closed for everybody else)', async () => {
    const { w, bob } = setup();
    await gql(w, CREATE, {
      input: {
        repositoryId: w.repo.nodeId,
        pattern: 'main',
        allowsForcePushes: false,
        bypassForcePushActorIds: [bob.nodeId],
      },
    });
    expect(canForcePush(w.repo, 'main', [bob.nodeId])).toBe(true);
    expect(canForcePush(w.repo, 'main', ['someone-else'])).toBe(false);
    expect(canForcePush(w.repo, 'feature/x', [])).toBe(true);
    must(w.repo.rules[0]).allowsForcePushes = true;
    expect(canForcePush(w.repo, 'main', [])).toBe(true);
  });

  it('[FAC-BRR-002] blocksCreations is its own flag, not implied by restrictsPushes (ADR-0041)', async () => {
    const { w, bob } = setup();
    const a = await gql(w, CREATE, {
      input: {
        repositoryId: w.repo.nodeId,
        pattern: 'a',
        restrictsPushes: true,
        pushActorIds: [bob.nodeId],
      },
    });
    expect(a.body.data.createBranchProtectionRule.branchProtectionRule).toMatchObject({
      restrictsPushes: true,
      blocksCreations: false,
    });
    const b = await gql(w, CREATE, {
      input: { repositoryId: w.repo.nodeId, pattern: 'b', blocksCreations: true },
    });
    expect(b.body.data.createBranchProtectionRule.branchProtectionRule).toMatchObject({
      restrictsPushes: false,
      blocksCreations: true,
    });
  });

  it('[FAC-BRR-002] defaults and review count', async () => {
    const { w } = setup();
    const a = await gql(w, CREATE, { input: { repositoryId: w.repo.nodeId, pattern: 'a' } });
    expect(a.body.data.createBranchProtectionRule.branchProtectionRule).toMatchObject({
      allowsForcePushes: false,
      allowsDeletions: false,
      requiresApprovingReviews: false,
      requiredApprovingReviewCount: null,
      requiresStatusChecks: false,
      requiredStatusCheckContexts: [],
    });
    const b = await gql(w, CREATE, {
      input: { repositoryId: w.repo.nodeId, pattern: 'b', requiresApprovingReviews: true },
    });
    expect(
      b.body.data.createBranchProtectionRule.branchProtectionRule.requiredApprovingReviewCount,
    ).toBe(1);
    const c = await gql(w, CREATE, {
      input: { repositoryId: w.repo.nodeId, pattern: 'c', requiredStatusCheckContexts: ['ci'] },
    });
    expect(c.body.data.createBranchProtectionRule.branchProtectionRule).toMatchObject({
      requiresStatusChecks: true,
      requiredStatusCheckContexts: ['ci'],
    });
  });

  it('[FAC-BRR-002] reads rules with first/after pagination and requires a boundary', async () => {
    const { w } = setup();
    for (const p of ['a', 'b', 'c'])
      await gql(w, CREATE, { input: { repositoryId: w.repo.nodeId, pattern: p } });
    const q = `query($after: String) { repository(owner:"acme", name:"auto-ok") { id isEmpty isPrivate nameWithOwner databaseId name branchProtectionRules(first: 2, after: $after) { totalCount nodes { pattern } edges { cursor } pageInfo { hasNextPage endCursor hasPreviousPage startCursor } } } }`;
    const first = await gql(w, q);
    const rules = first.body.data.repository.branchProtectionRules;
    expect(rules.nodes.map((n: { pattern: string }) => n.pattern)).toEqual(['a', 'b']);
    expect(rules.totalCount).toBe(3);
    expect(rules.pageInfo).toMatchObject({ hasNextPage: true, hasPreviousPage: false });
    expect(first.body.data.repository).toMatchObject({
      isEmpty: false,
      isPrivate: true,
      nameWithOwner: 'acme/auto-ok',
    });
    const second = await gql(w, q, { after: rules.pageInfo.endCursor });
    expect(
      second.body.data.repository.branchProtectionRules.nodes.map(
        (n: { pattern: string }) => n.pattern,
      ),
    ).toEqual(['c']);
    expect(second.body.data.repository.branchProtectionRules.pageInfo.hasNextPage).toBe(false);
    const last = await gql(
      w,
      `{ repository(owner:"acme", name:"auto-ok") { branchProtectionRules(last: 1) { nodes { pattern } } } }`,
    );
    expect(last.body.data.repository.branchProtectionRules.nodes).toEqual([{ pattern: 'c' }]);
    const none = await gql(
      w,
      `{ repository(owner:"acme", name:"auto-ok") { branchProtectionRules { totalCount } } }`,
    );
    expect(none.body.errors[0].type).toBe('MISSING_PAGINATION_BOUNDARIES');
    const big = await gql(
      w,
      `{ repository(owner:"acme", name:"auto-ok") { branchProtectionRules(first: 101) { totalCount } } }`,
    );
    expect(big.body.errors[0].message).toContain('exceeds the `first` limit of 100');
    const empty = await gql(
      w,
      `{ repository(owner:"acme", name:"empty") { isEmpty branchProtectionRules(first: 1) { nodes { id } pageInfo { startCursor endCursor } } } }`,
    );
    expect(empty.body.data.repository).toMatchObject({
      isEmpty: true,
      branchProtectionRules: { nodes: [], pageInfo: { startCursor: null, endCursor: null } },
    });
  });

  it('[FAC-BRR-002] update changes the pattern; duplicate patterns are rejected like GitHub', async () => {
    const { w } = setup();
    const a = await gql(w, CREATE, { input: { repositoryId: w.repo.nodeId, pattern: 'a' } });
    await gql(w, CREATE, { input: { repositoryId: w.repo.nodeId, pattern: 'b' } });
    const id = a.body.data.createBranchProtectionRule.branchProtectionRule.id;
    const dupe = await gql(w, CREATE, { input: { repositoryId: w.repo.nodeId, pattern: 'a' } });
    expect(dupe.body.errors[0]).toMatchObject({
      message: 'Name already protected: a',
      type: 'UNPROCESSABLE',
    });
    expect(dupe.body.data.createBranchProtectionRule).toBeNull();
    const clash = await gql(
      w,
      `mutation($id: ID!) { updateBranchProtectionRule(input:{branchProtectionRuleId:$id, pattern:"b"}) { clientMutationId } }`,
      { id },
    );
    expect(clash.body.errors[0].message).toBe('Name already protected: b');
    const ok = await gql(
      w,
      `mutation($id: ID!) { updateBranchProtectionRule(input:{branchProtectionRuleId:$id, pattern:"c", requiresLinearHistory:true}) { branchProtectionRule { pattern } } }`,
      { id },
    );
    expect(ok.body.data.updateBranchProtectionRule.branchProtectionRule.pattern).toBe('c');
    expect(w.repo.rules.find((r) => r.nodeId === id)?.requiresLinearHistory).toBe(true);
  });

  it('[FAC-BRR-002] deleteBranchProtectionRule removes the rule', async () => {
    const { w } = setup();
    const a = await gql(w, CREATE, { input: { repositoryId: w.repo.nodeId, pattern: 'a' } });
    const id = a.body.data.createBranchProtectionRule.branchProtectionRule.id;
    const del = await gql(
      w,
      `mutation($id: ID!) { deleteBranchProtectionRule(input:{branchProtectionRuleId:$id, clientMutationId:"x"}) { clientMutationId } }`,
      { id },
    );
    expect(del.body.data.deleteBranchProtectionRule.clientMutationId).toBe('x');
    expect(w.repo.rules).toEqual([]);
    const again = await gql(
      w,
      `mutation($id: ID!) { deleteBranchProtectionRule(input:{branchProtectionRuleId:$id}) { clientMutationId } }`,
      { id },
    );
    expect(again.body.errors[0].type).toBe('NOT_FOUND');
  });

  it('[FAC-BRR-002] actors must exist and have write access (provider doc, actor IDs)', async () => {
    const { w, s, team } = setup();
    const dave = must(s.findUser('dave'));
    const noAccess = await gql(w, CREATE, {
      input: {
        repositoryId: w.repo.nodeId,
        pattern: 'a',
        restrictsPushes: true,
        pushActorIds: [dave.nodeId],
      },
    });
    expect(noAccess.body.errors[0].message).toBe('dave must have write access to acme/auto-ok.');
    s.addCollaborator(w.repo, 'carol', 'pull');
    const read = await gql(w, CREATE, {
      input: {
        repositoryId: w.repo.nodeId,
        pattern: 'a',
        pushActorIds: [must(s.findUser('carol')).nodeId],
      },
    });
    expect(read.body.errors[0].message).toContain('write access');
    const bogus = await gql(w, CREATE, {
      input: { repositoryId: w.repo.nodeId, pattern: 'a', pushActorIds: ['bogus'] },
    });
    expect(bogus.body.errors[0]).toMatchObject({ type: 'NOT_FOUND' });
    const other = s.addTeam('acme', { name: 'other' });
    const teamNoAccess = await gql(w, CREATE, {
      input: { repositoryId: w.repo.nodeId, pattern: 'a', pushActorIds: [other.nodeId] },
    });
    expect(teamNoAccess.body.errors[0].message).toContain('Team other must have write access');
    const okTeam = await gql(w, CREATE, {
      input: { repositoryId: w.repo.nodeId, pattern: 'a', pushActorIds: [team.nodeId] },
    });
    expect(okTeam.body.errors).toBeUndefined();
    expect(w.repo.rules).toHaveLength(1);
    const org = await gql(w, CREATE, {
      input: {
        repositoryId: w.repo.nodeId,
        pattern: 'b',
        pushActorIds: [w.fake.state.requireOrg('acme').nodeId],
      },
    });
    expect(org.body.errors[0].type).toBe('NOT_FOUND');
  });

  it('[TST-011] unknown repositories and node ids', async () => {
    const { w } = setup();
    const repo = await gql(w, `{ repository(owner:"acme", name:"missing") { id } }`);
    expect(repo.body.errors[0].type).toBe('NOT_FOUND');
    expect(repo.body.data.repository).toBeNull();
    const create = await gql(w, CREATE, { input: { repositoryId: 'nope', pattern: 'a' } });
    expect(create.body.errors[0].type).toBe('NOT_FOUND');
    const node = await gql(
      w,
      `query($id: ID!) { node(id: $id) { __typename id ... on Repository { name } ... on User { login } ... on Organization { login } ... on Team { slug } ... on App { slug } } }`,
      { id: w.repo.nodeId },
    );
    expect(node.body.data.node).toMatchObject({ __typename: 'Repository', name: 'auto-ok' });
    const user = await gql(
      w,
      `{ user(login:"bob") { id login databaseId } organization(login:"acme") { id login } }`,
    );
    expect(user.body.data.user.login).toBe('bob');
    expect(user.body.data.organization.login).toBe('acme');
    expect((await gql(w, `{ user(login:"ghost") { id } }`)).body.errors[0].type).toBe('NOT_FOUND');
    expect((await gql(w, `{ organization(login:"ghost") { id } }`)).body.errors[0].type).toBe(
      'NOT_FOUND',
    );
    expect((await gql(w, `{ node(id:"bogus") { id } }`)).body.data.node).toBeNull();
    w.fake.state.addOrg({ login: 'other' });
    const foreign = w.fake.state.addRepository('other', { name: 'f' });
    expect((await gql(w, `{ node(id:"${foreign.nodeId}") { id } }`)).body.data.node).toBeNull();
    expect(
      (await gql(w, `{ repository(owner:"other", name:"f") { id } }`)).body.errors[0].type,
    ).toBe('NOT_FOUND');
  });

  it('[TST-011] operations are validated against the saved schema', async () => {
    const { w } = setup();
    const unknownField = await gql(
      w,
      `{ repository(owner:"acme", name:"auto-ok") { stargazerCount } }`,
    );
    expect(unknownField.body.errors[0].message).toContain('Cannot query field "stargazerCount"');
    const wrongInput = await gql(w, CREATE, {
      input: { repositoryId: w.repo.nodeId, pattern: 'a', nonsense: true },
    });
    expect(wrongInput.body.errors[0].message).toContain('nonsense');
    const missing = await gql(w, CREATE, { input: { repositoryId: w.repo.nodeId } });
    expect(missing.body.errors[0].message).toContain('pattern');
    expect((await gql(w, '{ ')).body.errors[0].message).toContain('Syntax Error');
    // The saved schema agrees with graphql-js's own validation of a known-good operation.
    const schema = buildSchema(
      readFileSync(new URL('../../specs/github.graphql', import.meta.url), 'utf8'),
    );
    expect(validate(schema, parse(CREATE))).toEqual([]);
  });

  it('[TST-011] request errors: no auth, bad JSON, no query, JWT', async () => {
    const { w } = setup();
    expect(
      (await w.call('POST', '/graphql', { token: null, body: { query: '{ rateLimit { cost } }' } }))
        .status,
    ).toBe(401);
    const bad = await w.fake.app.request('/graphql', {
      method: 'POST',
      headers: { authorization: `Bearer ${w.token}` },
      body: '{nope',
    });
    expect(bad.status).toBe(400);
    expect((await w.call('POST', '/graphql', { body: {} })).status).toBe(400);
    expect((await w.call('POST', '/graphql', { body: { query: 5 } })).body.message).toContain(
      'query attribute',
    );
    const named = await w.call('POST', '/graphql', {
      body: {
        query: 'query A { rateLimit { cost } } query B { rateLimit { limit } }',
        operationName: 'B',
      },
    });
    expect(named.body.data.rateLimit).toEqual({ limit: 5000 });
  });
});

describe('operation selection and webhook delivery stubs', () => {
  it('[JOB-045] only the executed operation counts as a mutation', async () => {
    const { isMutation } = await import('./graphql.ts');
    const doc =
      'query Q { rateLimit { cost } } mutation M { deleteBranchProtectionRule(input:{branchProtectionRuleId:"x"}) { clientMutationId } }';
    expect(isMutation(doc, 'Q')).toBe(false);
    expect(isMutation(doc, 'M')).toBe(true);
    expect(isMutation('# mutation\nquery { rateLimit { cost } }')).toBe(false);
    expect(isMutation('{ nope')).toBe(false);
  });

  it('[TST-011] webhook delivery detail and redelivery answer 404 (the fake keeps no deliveries)', async () => {
    const w = world();
    const repoHook = await w.call('POST', '/repos/acme/auto-ok/hooks', {
      body: { config: { url: 'https://example.test/a' } },
    });
    const orgHook = await w.call('POST', '/orgs/acme/hooks', {
      body: { config: { url: 'https://example.test/a' } },
    });
    for (const base of [
      `/repos/acme/auto-ok/hooks/${repoHook.body.id}`,
      `/orgs/acme/hooks/${orgHook.body.id}`,
    ]) {
      expect((await w.call('GET', `${base}/deliveries/1`)).status).toBe(404);
      expect((await w.call('POST', `${base}/deliveries/1/attempts`)).status).toBe(404);
    }
  });
});
