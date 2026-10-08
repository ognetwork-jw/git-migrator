import { describe, expect, it } from 'vitest';
import { world } from './harness.ts';

const ED25519_A =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const ED25519_B =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

describe('repositories', () => {
  it('[TST-011] creates a private repository, empty by default, and gets it', async () => {
    const w = world();
    const created = await w.spec(
      '/orgs/{org}/repos',
      'post',
      '/orgs/acme/repos',
      { body: { name: 'new-one', private: true, description: 'd' } },
      201,
    );
    expect(created.body).toMatchObject({
      full_name: 'acme/new-one',
      private: true,
      default_branch: 'main',
      size: 0,
    });
    expect(created.body.clone_url).toBe('http://localhost:4030/target/acme/new-one.git');
    const got = await w.spec('/repos/{owner}/{repo}', 'get', '/repos/acme/NEW-ONE', {}, 200);
    expect(got.body.name).toBe('new-one');
    expect((await w.call('GET', '/repos/acme/new-one/branches')).body).toEqual([]);
  });

  it('[TST-011] auto_init creates the default branch; duplicate names are 422 with GitHub text', async () => {
    const w = world();
    await w.spec(
      '/orgs/{org}/repos',
      'post',
      '/orgs/acme/repos',
      { body: { name: 'init', private: true, auto_init: true } },
      201,
    );
    expect(
      (await w.call('GET', '/repos/acme/init/branches')).body.map((b: { name: string }) => b.name),
    ).toEqual(['main']);
    const dup = await w.spec(
      '/orgs/{org}/repos',
      'post',
      '/orgs/acme/repos',
      { body: { name: 'init' } },
      422,
    );
    expect(dup.body.errors[0]).toMatchObject({
      field: 'name',
      message: 'name already exists on this account',
    });
    await w.spec(
      '/orgs/{org}/repos',
      'post',
      '/orgs/acme/repos',
      { body: { name: 'bad name' } },
      422,
    );
    await w.spec('/orgs/{org}/repos', 'post', '/orgs/acme/repos', { body: {} }, 422);
  });

  it('[TST-011] private repository creation can be forbidden by organization policy', async () => {
    const w = world();
    w.fake.state.requireOrg('acme').membersCanCreatePrivateRepositories = false;
    await w.spec(
      '/orgs/{org}/repos',
      'post',
      '/orgs/acme/repos',
      { body: { name: 'p', private: true } },
      403,
    );
    await w.spec(
      '/orgs/{org}/repos',
      'post',
      '/orgs/acme/repos',
      { body: { name: 'pub', private: false } },
      201,
    );
  });

  it('[TST-011] PATCH updates settings, default_branch must exist, rename keeps team access', async () => {
    const w = world();
    const team = w.fake.state.addTeam('acme', { name: 'plat' });
    w.fake.state.grantTeam(w.repo, team, 'push');
    const r = await w.spec(
      '/repos/{owner}/{repo}',
      'patch',
      '/repos/acme/auto-ok',
      {
        body: {
          description: 'changed',
          default_branch: 'feature/x',
          has_wiki: false,
          archived: false,
        },
      },
      200,
    );
    expect(r.body).toMatchObject({
      description: 'changed',
      default_branch: 'feature/x',
      has_wiki: false,
    });
    await w.spec(
      '/repos/{owner}/{repo}',
      'patch',
      '/repos/acme/auto-ok',
      { body: { default_branch: 'nope' } },
      422,
    );
    await w.spec(
      '/repos/{owner}/{repo}',
      'patch',
      '/repos/acme/auto-ok',
      { body: { name: 'renamed' } },
      200,
    );
    expect((await w.call('GET', '/repos/acme/auto-ok')).status).toBe(404);
    expect(
      (await w.call('GET', '/repos/acme/renamed/teams')).body.map((t: { slug: string }) => t.slug),
    ).toEqual(['plat']);
  });

  it('[LIF-077] DELETE removes the repository and answers 403 when the organization forbids deletion', async () => {
    const w = world();
    await w.spec('/repos/{owner}/{repo}', 'delete', '/repos/acme/empty', {}, 204);
    expect((await w.call('GET', '/repos/acme/empty')).status).toBe(404);
    await w.call('POST', '/__config', { body: {} });
    w.fake.state.config.repositoryDeletion = 'forbidden';
    await w.spec('/repos/{owner}/{repo}', 'delete', '/repos/acme/auto-ok', {}, 403);
    w.fake.state.config.repositoryDeletion = 'allowed';
    w.fake.state.requireOrg('acme').membersCanDeleteRepositories = false;
    await w.spec('/repos/{owner}/{repo}', 'delete', '/repos/acme/auto-ok', {}, 403);
    expect((await w.call('GET', '/repos/acme/auto-ok')).status).toBe(200);
  });

  it('[TST-011] branches list with protected filter', async () => {
    const w = world();
    const all = await w.spec(
      '/repos/{owner}/{repo}/branches',
      'get',
      '/repos/acme/auto-ok/branches',
      {},
      200,
    );
    expect(all.body.map((b: { name: string }) => b.name)).toEqual(['feature/x', 'main']);
    const gql = `mutation { createBranchProtectionRule(input:{repositoryId:"${w.repo.nodeId}", pattern:"ma*"}) { clientMutationId } }`;
    expect(
      (await w.call('POST', '/graphql', { body: { query: gql } })).body.errors,
    ).toBeUndefined();
    const prot = await w.call('GET', '/repos/acme/auto-ok/branches?protected=true');
    expect(prot.body.map((b: { name: string }) => b.name)).toEqual(['main']);
    await w.spec('/repos/{owner}/{repo}/branches', 'get', '/repos/acme/empty/branches', {}, 200);
  });
});

describe('collaborators and teams on repositories', () => {
  it('[TST-011] affiliation direct includes outside collaborators regardless of org membership (FAC-ACL-002)', async () => {
    const w = world();
    const s = w.fake.state;
    s.addCollaborator(w.repo, 'bob', 'push');
    s.addCollaborator(w.repo, 'carol', 'triage');
    const direct = await w.spec(
      '/repos/{owner}/{repo}/collaborators',
      'get',
      '/repos/acme/auto-ok/collaborators?affiliation=direct',
      {},
      200,
    );
    expect(direct.body.map((u: { login: string }) => u.login)).toEqual(['bob', 'carol']);
    expect(direct.body[1]).toMatchObject({
      role_name: 'triage',
      permissions: { triage: true, push: false },
    });
    const outside = await w.call('GET', '/repos/acme/auto-ok/collaborators?affiliation=outside');
    expect(outside.body.map((u: { login: string }) => u.login)).toEqual(['carol']);
    const push = await w.call(
      'GET',
      '/repos/acme/auto-ok/collaborators?affiliation=direct&permission=push',
    );
    expect(push.body.map((u: { login: string }) => u.login)).toEqual(['bob']);
    s.requireOrg('acme').baseRole = 'pull';
    const all = await w.call('GET', '/repos/acme/auto-ok/collaborators');
    expect(all.body.map((u: { login: string }) => u.login)).toEqual(['alice', 'bob', 'carol']);
  });

  it('[TST-011] PUT for a member is 204, for a non-member a 7 day invitation (201); DELETE removes both', async () => {
    let now = Date.parse('2026-10-08T00:00:00Z');
    const w = world({ clock: () => now });
    await w.spec(
      '/repos/{owner}/{repo}/collaborators/{username}',
      'put',
      '/repos/acme/auto-ok/collaborators/bob',
      { body: { permission: 'push' } },
      204,
    );
    const inv = await w.spec(
      '/repos/{owner}/{repo}/collaborators/{username}',
      'put',
      '/repos/acme/auto-ok/collaborators/carol',
      { body: { permission: 'maintain' } },
      201,
    );
    expect(inv.body.permissions).toBe('maintain');
    const list = await w.spec(
      '/repos/{owner}/{repo}/invitations',
      'get',
      '/repos/acme/auto-ok/invitations',
      {},
      200,
    );
    expect(list.body).toHaveLength(1);
    await w.spec(
      '/repos/{owner}/{repo}/collaborators/{username}',
      'get',
      '/repos/acme/auto-ok/collaborators/bob',
      {},
      204,
    );
    await w.spec(
      '/repos/{owner}/{repo}/collaborators/{username}',
      'delete',
      '/repos/acme/auto-ok/collaborators/carol',
      {},
      204,
    );
    expect((await w.call('GET', '/repos/acme/auto-ok/invitations')).body).toEqual([]);
    await w.spec(
      '/repos/{owner}/{repo}/collaborators/{username}',
      'delete',
      '/repos/acme/auto-ok/collaborators/bob',
      {},
      204,
    );
    expect((await w.call('GET', '/repos/acme/auto-ok/collaborators/bob')).status).toBe(404);
    await w.call('PUT', '/repos/acme/auto-ok/collaborators/dave', { body: {} });
    now += 8 * 24 * 3600 * 1000;
    expect(
      (await w.call('GET', '/repos/acme/auto-ok/invitations', { token: w.fake.token() })).body,
    ).toEqual([]);
  });

  it('[TST-011] a permission below the organization base role is rejected with the GitHub text', async () => {
    const w = world();
    w.fake.state.requireOrg('acme').baseRole = 'push';
    const r = await w.spec(
      '/repos/{owner}/{repo}/collaborators/{username}',
      'put',
      '/repos/acme/auto-ok/collaborators/bob',
      { body: { permission: 'pull' } },
      422,
    );
    expect(JSON.stringify(r.body.errors)).toContain('Cannot assign bob permission of read');
    await w
      .call('PUT', '/repos/acme/auto-ok/collaborators/bob', { body: { permission: 'bogus' } })
      .then((x) => expect(x.status).toBe(422));
    await w
      .call('PUT', '/repos/acme/auto-ok/collaborators/nobody', { body: {} })
      .then((x) => expect(x.status).toBe(404));
  });

  it('[TST-011] custom role names are accepted when the organization defines them', async () => {
    const w = world();
    w.fake.state.requireOrg('acme').customRoles = { 'release-manager': 'maintain' };
    await w.call('PUT', '/repos/acme/auto-ok/collaborators/bob', {
      body: { permission: 'release-manager' },
    });
    const r = await w.call('GET', '/repos/acme/auto-ok/collaborators?affiliation=direct');
    expect(r.body[0]).toMatchObject({
      role_name: 'release-manager',
      permissions: { maintain: true, admin: false },
    });
  });

  it('[TST-011] team repository access: PUT, GET and DELETE', async () => {
    const w = world();
    w.fake.state.addTeam('acme', { name: 'plat' });
    await w.spec(
      '/orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}',
      'put',
      '/orgs/acme/teams/plat/repos/acme/auto-ok',
      { body: { permission: 'maintain' } },
      204,
    );
    const teams = await w.spec(
      '/repos/{owner}/{repo}/teams',
      'get',
      '/repos/acme/auto-ok/teams',
      {},
      200,
    );
    expect(teams.body).toMatchObject([{ slug: 'plat', permission: 'maintain' }]);
    await w
      .call('PUT', '/orgs/acme/teams/plat/repos/acme/auto-ok', { body: { permission: 'nope' } })
      .then((x) => expect(x.status).toBe(422));
    await w.spec(
      '/orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}',
      'delete',
      '/orgs/acme/teams/plat/repos/acme/auto-ok',
      {},
      204,
    );
    expect((await w.call('GET', '/repos/acme/auto-ok/teams')).body).toEqual([]);
  });
});

describe('deploy keys', () => {
  it('[FAC-DKY-002] keys are unique across repositories: "key is already in use" 422', async () => {
    const w = world();
    const created = await w.spec(
      '/repos/{owner}/{repo}/keys',
      'post',
      '/repos/acme/auto-ok/keys',
      { body: { title: 't', key: ED25519_A, read_only: true } },
      201,
    );
    expect(created.body).toMatchObject({ title: 't', read_only: true });
    const dup = await w.spec(
      '/repos/{owner}/{repo}/keys',
      'post',
      '/repos/acme/empty/keys',
      { body: { title: 'again', key: `${ED25519_A} comment` } },
      422,
    );
    expect(dup.body.message).toBe('Validation Failed');
    expect(dup.body.errors[0]).toMatchObject({
      resource: 'PublicKey',
      field: 'key',
      message: 'key is already in use',
    });
    await w.spec(
      '/repos/{owner}/{repo}/keys',
      'post',
      '/repos/acme/empty/keys',
      { body: { key: ED25519_B } },
      201,
    );
    await w.spec(
      '/repos/{owner}/{repo}/keys',
      'post',
      '/repos/acme/empty/keys',
      { body: { key: 'not a key' } },
      422,
    );
    await w.spec('/repos/{owner}/{repo}/keys', 'post', '/repos/acme/empty/keys', { body: {} }, 422);
  });

  it('[FAC-DKY-002] lists, gets and deletes keys; a deleted key can be reused elsewhere', async () => {
    const w = world();
    const k = await w.call('POST', '/repos/acme/auto-ok/keys', {
      body: { title: 'a', key: ED25519_A },
    });
    const list = await w.spec(
      '/repos/{owner}/{repo}/keys',
      'get',
      '/repos/acme/auto-ok/keys',
      {},
      200,
    );
    expect(list.body).toHaveLength(1);
    await w.spec(
      '/repos/{owner}/{repo}/keys/{key_id}',
      'get',
      `/repos/acme/auto-ok/keys/${k.body.id}`,
      {},
      200,
    );
    await w.spec(
      '/repos/{owner}/{repo}/keys/{key_id}',
      'get',
      '/repos/acme/auto-ok/keys/1',
      {},
      404,
    );
    await w.spec(
      '/repos/{owner}/{repo}/keys/{key_id}',
      'delete',
      `/repos/acme/auto-ok/keys/${k.body.id}`,
      {},
      204,
    );
    await w.spec(
      '/repos/{owner}/{repo}/keys',
      'post',
      '/repos/acme/empty/keys',
      { body: { key: ED25519_A } },
      201,
    );
  });
});

describe('REST branch protection', () => {
  it('[FAC-BRR-002] PUT only accepts existing branch names; GET and DELETE round trip', async () => {
    const w = world();
    w.fake.state.addCollaborator(w.repo, 'bob', 'push');
    const body = {
      required_status_checks: { strict: true, contexts: ['ci'] },
      enforce_admins: true,
      required_pull_request_reviews: {
        required_approving_review_count: 2,
        dismiss_stale_reviews: true,
        require_code_owner_reviews: true,
      },
      restrictions: { users: ['bob'], teams: [], apps: ['git-migrator-fake'] },
      allow_force_pushes: true,
      block_creations: true,
    };
    await w.spec(
      '/repos/{owner}/{repo}/branches/{branch}/protection',
      'put',
      '/repos/acme/auto-ok/branches/release/protection',
      { body },
      404,
    );
    const put = await w.spec(
      '/repos/{owner}/{repo}/branches/{branch}/protection',
      'put',
      '/repos/acme/auto-ok/branches/main/protection',
      { body },
      200,
    );
    expect(put.body.required_pull_request_reviews.required_approving_review_count).toBe(2);
    expect(put.body.allow_force_pushes.enabled).toBe(true);
    expect(put.body.block_creations.enabled).toBe(true);
    expect(put.body.restrictions.users.map((u: { login: string }) => u.login)).toEqual(['bob']);
    await w.spec(
      '/repos/{owner}/{repo}/branches/{branch}/protection',
      'get',
      '/repos/acme/auto-ok/branches/main/protection',
      {},
      200,
    );
    await w.spec(
      '/repos/{owner}/{repo}/branches/{branch}/protection',
      'get',
      '/repos/acme/auto-ok/branches/feature/x/protection',
      {},
      404,
    );
    await w.spec(
      '/repos/{owner}/{repo}/branches/{branch}/protection',
      'delete',
      '/repos/acme/auto-ok/branches/main/protection',
      {},
      204,
    );
    expect(w.repo.rules).toEqual([]);
    expect((await w.call('DELETE', '/repos/acme/auto-ok/branches/main/protection')).status).toBe(
      404,
    );
    await w.spec(
      '/repos/{owner}/{repo}/branches/{branch}/protection',
      'put',
      '/repos/acme/auto-ok/branches/main/protection',
      { body: { enforce_admins: true } },
      422,
    );
  });

  it('[FAC-BRR-002] REST PUT keeps GraphQL-only bypass lists and the rule identity', async () => {
    const w = world();
    const bob = w.fake.state.findUser('bob');
    w.fake.state.addCollaborator(w.repo, 'bob', 'push');
    const gql = `mutation { createBranchProtectionRule(input:{repositoryId:"${w.repo.nodeId}", pattern:"main", bypassForcePushActorIds:["${bob?.nodeId}"]}) { branchProtectionRule { id } } }`;
    const created = await w.call('POST', '/graphql', { body: { query: gql } });
    const id = created.body.data.createBranchProtectionRule.branchProtectionRule.id;
    await w.call('PUT', '/repos/acme/auto-ok/branches/main/protection', {
      body: {
        required_status_checks: null,
        enforce_admins: false,
        required_pull_request_reviews: null,
        restrictions: null,
      },
    });
    expect(w.repo.rules).toHaveLength(1);
    expect(w.repo.rules[0]?.nodeId).toBe(id);
    expect(w.repo.rules[0]?.bypassForcePushActorIds).toEqual([bob?.nodeId]);
  });
});
