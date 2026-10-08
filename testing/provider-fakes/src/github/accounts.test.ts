import { describe, expect, it } from 'vitest';
import { world } from './harness.ts';

describe('organization, users, apps', () => {
  it('[TST-011] GET /orgs/{org} serves plan seats with the plan permission and validates against the spec', async () => {
    const w = world();
    w.fake.state.requireOrg('acme').plan.seats = 10;
    const r = await w.spec('/orgs/{org}', 'get', '/orgs/acme', {}, 200);
    expect(r.body.plan).toMatchObject({ name: 'team', seats: 10, filled_seats: 2 });
    expect(r.body.members_can_create_private_repositories).toBe(true);
  });

  it('[TST-011] omits plan without Organization plan permission and settings when not exposed', async () => {
    const w = world();
    w.fake.state.requireOrg('acme').exposeSettings = false;
    const token = w.fake.token({ permissions: { metadata: 'read', members: 'read' } });
    const r = await w.call('GET', '/orgs/acme', { token });
    expect(r.status).toBe(200);
    expect(r.body.plan).toBeUndefined();
    expect(r.body.members_can_create_private_repositories).toBeUndefined();
  });

  it('[TST-011] another account organization is a 404', async () => {
    const w = world();
    w.fake.state.addOrg({ login: 'other' });
    expect((await w.call('GET', '/orgs/other')).status).toBe(404);
  });

  it('[TST-011] GET /users/{login} returns name and public email only', async () => {
    const w = world();
    const dave = await w.spec('/users/{username}', 'get', '/users/dave', {}, 200);
    expect(dave.body).toMatchObject({ login: 'dave', name: 'Dave D', email: 'dave@test.local' });
    const carol = await w.spec('/users/{username}', 'get', '/users/carol', {}, 200);
    expect(carol.body.email).toBeNull();
    await w.spec('/users/{username}', 'get', '/users/nobody', {}, 404);
  });

  it('[TST-011] GET /apps/{slug} exposes the node_id for GraphQL actors; /app needs a JWT', async () => {
    const w = world();
    const app = await w.spec('/apps/{app_slug}', 'get', '/apps/git-migrator-fake', {}, 200);
    expect(app.body.node_id).toBe(w.fake.state.ownApp.nodeId);
    await w.spec('/apps/{app_slug}', 'get', '/apps/nope', {}, 404);
    expect((await w.call('GET', '/app')).status).toBe(401);
  });

  it('[TST-011] installation endpoints work with the App JWT', async () => {
    const w = world();
    const { fakeAppJwt } = await import('./jwt.ts');
    const jwt = fakeAppJwt({ appId: w.fake.state.ownApp.id });
    await w.spec('/app', 'get', '/app', { token: jwt }, 200);
    const inst = await w.spec(
      '/orgs/{org}/installation',
      'get',
      '/orgs/acme/installation',
      { token: jwt },
      200,
    );
    expect(inst.body.app_slug).toBe('git-migrator-fake');
    await w.spec(
      '/repos/{owner}/{repo}/installation',
      'get',
      '/repos/acme/auto-ok/installation',
      { token: jwt },
      200,
    );
    const repos = await w.spec(
      '/installation/repositories',
      'get',
      '/installation/repositories',
      {},
      200,
    );
    expect(repos.body.total_count).toBe(2);
  });
});

describe('members and invitations', () => {
  it('[TST-011] lists members with role filter and Link pagination', async () => {
    const w = world();
    const all = await w.spec('/orgs/{org}/members', 'get', '/orgs/acme/members', {}, 200);
    expect(all.body.map((u: { login: string }) => u.login)).toEqual(['alice', 'bob']);
    const admins = await w.call('GET', '/orgs/acme/members?role=admin');
    expect(admins.body.map((u: { login: string }) => u.login)).toEqual(['alice']);
    const page1 = await w.call('GET', '/orgs/acme/members?per_page=1');
    expect(page1.body).toHaveLength(1);
    const link = page1.headers.get('link') as string;
    expect(link).toContain('rel="next"');
    expect(link).toContain('rel="last"');
    expect(link).toContain('http://localhost/orgs/acme/members?per_page=1&page=2');
    const page2 = await w.call('GET', '/orgs/acme/members?per_page=1&page=2');
    expect(page2.body[0].login).toBe('bob');
    expect(page2.headers.get('link')).toContain('rel="prev"');
    expect(page2.headers.get('link')).not.toContain('rel="next"');
  });

  it('[TST-011] outside collaborators are collaborators who are not members', async () => {
    const w = world();
    w.fake.state.addCollaborator(w.repo, 'carol', 'push');
    w.fake.state.addCollaborator(w.repo, 'bob', 'push');
    const r = await w.spec(
      '/orgs/{org}/outside_collaborators',
      'get',
      '/orgs/acme/outside_collaborators',
      {},
      200,
    );
    expect(r.body.map((u: { login: string }) => u.login)).toEqual(['carol']);
  });

  it('[TST-011] membership endpoint', async () => {
    const w = world();
    const r = await w.spec(
      '/orgs/{org}/memberships/{username}',
      'get',
      '/orgs/acme/memberships/alice',
      {},
      200,
    );
    expect(r.body.role).toBe('admin');
    await w.spec(
      '/orgs/{org}/memberships/{username}',
      'get',
      '/orgs/acme/memberships/carol',
      {},
      404,
    );
  });

  it('[TST-011] creates, lists and deletes invitations; 7-day expiry removes them', async () => {
    let now = Date.parse('2026-10-08T00:00:00Z');
    const w = world({ clock: () => now });
    const created = await w.spec(
      '/orgs/{org}/invitations',
      'post',
      '/orgs/acme/invitations',
      { body: { invitee_id: w.fake.state.findUser('carol')?.id, role: 'direct_member' } },
      201,
    );
    expect(created.body.login).toBe('carol');
    const byEmail = await w.spec(
      '/orgs/{org}/invitations',
      'post',
      '/orgs/acme/invitations',
      { body: { email: 'new@test.local' } },
      201,
    );
    expect(byEmail.body.email).toBe('new@test.local');
    const list = await w.spec('/orgs/{org}/invitations', 'get', '/orgs/acme/invitations', {}, 200);
    expect(list.body).toHaveLength(2);
    await w.spec(
      '/orgs/{org}/invitations/{invitation_id}',
      'delete',
      `/orgs/acme/invitations/${byEmail.body.id}`,
      {},
      204,
    );
    expect((await w.call('GET', '/orgs/acme/invitations')).body).toHaveLength(1);
    now += 7 * 24 * 3600 * 1000 + 1000;
    expect((await w.call('GET', '/orgs/acme/invitations', { token: w.fake.token() })).body).toEqual(
      [],
    );
    await w.spec(
      '/orgs/{org}/invitations/{invitation_id}',
      'delete',
      `/orgs/acme/invitations/${created.body.id}`,
      { token: w.fake.token() },
      404,
    );
    await w.spec(
      '/orgs/{org}/failed_invitations',
      'get',
      '/orgs/acme/failed_invitations',
      { token: w.fake.token() },
      200,
    );
  });

  it('[TST-011] invitation validation: existing member, duplicates, missing invitee', async () => {
    const w = world();
    const bob = w.fake.state.findUser('bob')?.id;
    const member = await w.spec(
      '/orgs/{org}/invitations',
      'post',
      '/orgs/acme/invitations',
      { body: { invitee_id: bob } },
      422,
    );
    expect(JSON.stringify(member.body.errors)).toContain('already a part');
    await w.call('POST', '/orgs/acme/invitations', { body: { email: 'x@test.local' } });
    expect(
      (await w.call('POST', '/orgs/acme/invitations', { body: { email: 'x@test.local' } })).status,
    ).toBe(422);
    expect((await w.call('POST', '/orgs/acme/invitations', { body: {} })).status).toBe(422);
    expect(
      (
        await w.call('POST', '/orgs/acme/invitations', {
          body: { email: 'y@test.local', role: 'bogus' },
        })
      ).status,
    ).toBe(422);
  });

  it('[TST-011] invitation limit: 50 per 24 h for a young free org, 500 for a paid one', async () => {
    const now = Date.parse('2026-10-08T00:00:00Z');
    const free = world({ clock: () => now });
    const org = free.fake.state.requireOrg('acme');
    org.plan.name = 'free';
    org.createdAt = now - 3600_000;
    expect(free.fake.state.invitationLimit(org)).toBe(50);
    for (let i = 0; i < 50; i++) free.fake.state.invite(org, { email: `u${i}@test.local` });
    const over = await free.call('POST', '/orgs/acme/invitations', {
      body: { email: 'over@test.local' },
    });
    expect(over.status).toBe(422);
    expect(JSON.stringify(over.body.errors)).toContain('limit');
    const paid = world({ clock: () => now });
    expect(paid.fake.state.invitationLimit(paid.fake.state.requireOrg('acme'))).toBe(500);
    paid.fake.state.requireOrg('acme').plan.name = 'free';
    paid.fake.state.requireOrg('acme').createdAt = now - 31 * 24 * 3600_000;
    expect(paid.fake.state.invitationLimit(paid.fake.state.requireOrg('acme'))).toBe(500);
    // 24 h later the window is empty again.
  });

  it('[TST-011] a per-seat org without a free license cannot invite', async () => {
    const w = world();
    w.fake.state.requireOrg('acme').plan.seats = 2; // alice and bob fill both seats
    const r = await w.call('POST', '/orgs/acme/invitations', { body: { email: 'z@test.local' } });
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body.errors)).toContain('seats');
  });

  it('[TST-011] accepting an invitation makes the invitee a member', async () => {
    const w = world();
    const inv = await w.call('POST', '/orgs/acme/invitations', {
      body: { invitee_id: w.fake.state.findUser('carol')?.id },
    });
    w.fake.state.acceptInvitation('acme', inv.body.id);
    expect(
      (await w.call('GET', '/orgs/acme/members')).body.map((u: { login: string }) => u.login),
    ).toContain('carol');
  });
});

describe('teams', () => {
  it('[TST-011] creates, lists and reads teams; slugs derive from the name', async () => {
    const w = world();
    const created = await w.spec(
      '/orgs/{org}/teams',
      'post',
      '/orgs/acme/teams',
      { body: { name: 'Platform Team', description: 'p', privacy: 'closed' } },
      201,
    );
    expect(created.body.slug).toBe('platform-team');
    await w.spec(
      '/orgs/{org}/teams',
      'post',
      '/orgs/acme/teams',
      { body: { name: 'Platform Team' } },
      422,
    );
    const list = await w.spec('/orgs/{org}/teams', 'get', '/orgs/acme/teams', {}, 200);
    expect(list.body).toHaveLength(1);
    await w.spec('/orgs/{org}/teams/{team_slug}', 'get', '/orgs/acme/teams/platform-team', {}, 200);
    await w.spec('/orgs/{org}/teams/{team_slug}', 'get', '/orgs/acme/teams/nope', {}, 404);
  });

  it('[TST-011] team membership for members is active, for non-members pending with an invitation', async () => {
    const w = world();
    await w.call('POST', '/orgs/acme/teams', { body: { name: 'plat' } });
    const active = await w.spec(
      '/orgs/{org}/teams/{team_slug}/memberships/{username}',
      'put',
      '/orgs/acme/teams/plat/memberships/bob',
      { body: { role: 'maintainer' } },
      200,
    );
    expect(active.body).toMatchObject({ state: 'active', role: 'maintainer' });
    const pending = await w.spec(
      '/orgs/{org}/teams/{team_slug}/memberships/{username}',
      'put',
      '/orgs/acme/teams/plat/memberships/carol',
      {},
      200,
    );
    expect(pending.body.state).toBe('pending');
    expect(
      (await w.call('GET', '/orgs/acme/invitations')).body.map((i: { login: string }) => i.login),
    ).toEqual(['carol']);
    const members = await w.spec(
      '/orgs/{org}/teams/{team_slug}/members',
      'get',
      '/orgs/acme/teams/plat/members',
      {},
      200,
    );
    expect(members.body.map((u: { login: string }) => u.login)).toEqual(['bob']);
    await w.spec(
      '/orgs/{org}/teams/{team_slug}/memberships/{username}',
      'get',
      '/orgs/acme/teams/plat/memberships/bob',
      {},
      200,
    );
    // The description documents this 404 without a body schema; GitHub still sends the usual JSON.
    expect((await w.call('GET', '/orgs/acme/teams/plat/memberships/dave')).status).toBe(404);
    await w.spec(
      '/orgs/{org}/teams/{team_slug}/memberships/{username}',
      'delete',
      '/orgs/acme/teams/plat/memberships/bob',
      {},
      204,
    );
    expect((await w.call('GET', '/orgs/acme/teams/plat/members')).body).toEqual([]);
    // Accepting turns the pending membership active.
    w.fake.state.acceptInvitation(
      'acme',
      (await w.call('GET', '/orgs/acme/invitations')).body[0].id,
    );
    expect(
      (await w.call('GET', '/orgs/acme/teams/plat/members')).body.map(
        (u: { login: string }) => u.login,
      ),
    ).toEqual(['carol']);
  });
});
