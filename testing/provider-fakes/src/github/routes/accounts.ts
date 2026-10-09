import type { RateLimiter, Resource } from '../rate-limit.ts';
import { orgFor, type Router } from '../router.ts';
import { GitHubState } from '../state.ts';
import type { InvitationRec, Permissions, RepoRec } from '../types.ts';
import { GhError, invalidField, notFound, validationFailed } from '../util.ts';

const RESOURCES = [
  'core',
  'graphql',
  'search',
  'code_search',
  'integration_manifest',
  'source_import',
  'actions_runner_registration',
  'scim',
  'dependency_snapshots',
  'dependency_sbom',
  'code_scanning_autofix',
  'copilot_usage_records',
] as const;

export function registerAccounts(r: Router, state: GitHubState, limiter: RateLimiter): void {
  // -- rate limit ---------------------------------------------------------------------------------

  r.get('/rate_limit', 'any', (q) => {
    const bucket = (res: Resource) => {
      const i = limiter.peek(q.auth, res);
      return { limit: i.limit, remaining: i.remaining, used: i.used, reset: i.reset };
    };
    const core = bucket('core');
    const resources: Record<string, unknown> = {};
    for (const name of RESOURCES) {
      resources[name] =
        name === 'core' || name === 'graphql' || name === 'search'
          ? bucket(name)
          : { limit: 0, remaining: 0, used: 0, reset: core.reset };
    }
    return { body: { resources, rate: core } };
  });

  // -- apps and installations ---------------------------------------------------------------------

  r.get('/app', 'jwt', (q) => ({ body: q.ser.integration(q.auth.app as never) }));

  r.get('/apps/:slug', 'public', (q) => {
    const app = [...state.apps.values()].find((a) => a.slug === q.param('slug'));
    if (!app) throw notFound();
    return { body: q.ser.integration(app) };
  });

  r.get('/orgs/:org/installation', 'jwt', (q) => {
    const inst = [...state.installations.values()].find(
      (i) => i.appId === q.auth.app?.id && i.account.toLowerCase() === q.param('org').toLowerCase(),
    );
    if (!inst) throw notFound();
    return { body: q.ser.installation(inst) };
  });

  r.get('/repos/:owner/:repo/installation', 'jwt', (q) => {
    const repo = state.findRepo(q.param('owner'), q.param('repo'));
    const inst = repo
      ? [...state.installations.values()].find(
          (i) => i.appId === q.auth.app?.id && i.account.toLowerCase() === repo.owner.toLowerCase(),
        )
      : undefined;
    if (!inst) throw notFound();
    return { body: q.ser.installation(inst) };
  });

  r.get('/installation/repositories', 'any', (q) => {
    const inst = q.auth.installation as NonNullable<typeof q.auth.installation>;
    const repos = visibleRepos(state, q);
    return q.page(
      repos,
      (repo) => q.ser.repoFull(repo),
      (items, total) => ({
        total_count: total,
        repository_selection: inst.repositorySelection,
        repositories: items,
      }),
    );
  });

  // JWT → installation token exchange (provider doc, Authentication).
  r.post('/app/installations/:id/access_tokens', 'jwt', async (q) => {
    const inst = state.installations.get(Number(q.param('id')));
    if (!inst || inst.appId !== q.auth.app?.id) throw notFound();
    if (inst.suspended) throw new GhError(403, 'This installation has been suspended');
    const body = await q.body();
    let permissions: Permissions = { ...inst.permissions };
    if (body.permissions !== undefined) {
      const asked = body.permissions as Record<string, unknown>;
      if (!asked || typeof asked !== 'object' || Array.isArray(asked))
        throw invalidField('Installation', 'permissions');
      const granted: Permissions = {};
      for (const [perm, level] of Object.entries(asked)) {
        if (level !== 'read' && level !== 'write' && level !== 'admin')
          throw invalidField('Installation', `permissions.${perm}`);
        if (!GitHubState.allows(inst.permissions, perm, level))
          throw new GhError(422, `The permissions requested are not granted to this installation.`);
        granted[perm] = level;
      }
      permissions = granted;
    }
    let repositoryIds: number[] | null = null;
    const names = body.repositories as string[] | undefined;
    const ids = body.repository_ids as number[] | undefined;
    if (names || ids) {
      repositoryIds = [];
      for (const n of names ?? []) {
        const repo = state.findRepo(inst.account, n);
        if (!repo || !covers(inst, repo))
          throw validationFailed({
            resource: 'Installation',
            code: 'invalid',
            field: 'repositories',
          });
        repositoryIds.push(repo.id);
      }
      for (const id of ids ?? []) {
        const repo = [...state.repos.values()].find((x) => x.id === id);
        if (!repo || !covers(inst, repo))
          throw validationFailed({
            resource: 'Installation',
            code: 'invalid',
            field: 'repository_ids',
          });
        repositoryIds.push(id);
      }
    }
    const { token, rec } = state.issueInstallationToken(inst.id, { permissions, repositoryIds });
    const repos = repositoryIds
      ? repositoryIds.map((id) => [...state.repos.values()].find((x) => x.id === id) as RepoRec)
      : [];
    return {
      status: 201,
      body: {
        token,
        expires_at: new Date(rec.expiresAt).toISOString().replace(/\.\d{3}Z$/, 'Z'),
        permissions: rec.permissions,
        repository_selection: repositoryIds ? 'selected' : inst.repositorySelection,
        ...(repositoryIds ? { repositories: repos.map((x) => q.ser.repoFull(x)) } : {}),
      },
    };
  });

  // -- organization -------------------------------------------------------------------------------

  r.get('/orgs/:org', 'any', (q) => {
    const org = orgFor(q, q.param('org'));
    const plan = GitHubState.allows(q.auth.permissions, 'organization_plan', 'read');
    return { body: q.ser.organizationFull(org, { plan }) };
  });

  r.get('/users/:login', 'public', (q) => {
    const user = state.findUser(q.param('login'));
    if (user) return { body: q.ser.publicUser(user) };
    const org = state.orgs.get(q.param('login').toLowerCase());
    if (org)
      return {
        body: {
          ...q.ser.orgAsOwner(org),
          name: org.login,
          email: null,
          public_repos: 0,
          public_gists: 0,
          followers: 0,
          following: 0,
          created_at: new Date(org.createdAt).toISOString(),
          updated_at: new Date(org.createdAt).toISOString(),
        },
      };
    throw notFound();
  });

  r.get('/orgs/:org/members', ['members', 'read'], (q) => {
    const org = orgFor(q, q.param('org'));
    const role = q.url.searchParams.get('role') ?? 'all';
    if (!['all', 'admin', 'member'].includes(role)) throw invalidField('Organization', 'role');
    const logins = [...org.members]
      .filter(([, rl]) => role === 'all' || rl === role)
      .map(([l]) => l)
      .sort((a, b) => a.localeCompare(b));
    return q.page(logins, (l) => q.ser.userByLogin(l));
  });

  r.get('/orgs/:org/memberships/:login', ['members', 'read'], (q) => {
    const org = orgFor(q, q.param('org'));
    const user = state.findUser(q.param('login'));
    const role = user && state.memberRole(org, user.login);
    if (!user || !role) throw notFound();
    return {
      body: {
        url: `${q.ser.base}/orgs/${org.login}/memberships/${user.login}`,
        state: 'active',
        role,
        organization_url: `${q.ser.base}/orgs/${org.login}`,
        organization: q.ser.orgSimple(org),
        user: q.ser.simpleUser(user),
      },
    };
  });

  r.get('/orgs/:org/outside_collaborators', ['members', 'read'], (q) => {
    const org = orgFor(q, q.param('org'));
    const logins = new Set<string>();
    for (const repo of state.repos.values())
      if (repo.owner.toLowerCase() === org.login.toLowerCase())
        for (const l of repo.collaborators.keys()) if (!state.isMember(org, l)) logins.add(l);
    return q.page([...logins].sort(), (l) => q.ser.userByLogin(l));
  });

  // -- invitations --------------------------------------------------------------------------------

  r.get('/orgs/:org/invitations', ['members', 'read'], (q) => {
    const org = orgFor(q, q.param('org'));
    state.purgeExpired(org);
    return q.page(org.invitations, (i) => q.ser.orgInvitation(org, i));
  });

  r.get('/orgs/:org/failed_invitations', ['members', 'read'], (q) => {
    const org = orgFor(q, q.param('org'));
    state.purgeExpired(org);
    return q.page(
      [...org.invitations.filter((i) => i.failedAt != null), ...org.expiredInvitations],
      (i) => q.ser.orgInvitation(org, i),
    );
  });

  r.post('/orgs/:org/invitations', ['members', 'write'], async (q) => {
    const org = orgFor(q, q.param('org'));
    const body = await q.body();
    const role = (body.role as InvitationRec['role'] | undefined) ?? 'direct_member';
    if (!['admin', 'direct_member', 'billing_manager', 'reinstate'].includes(role))
      throw invalidField('OrganizationInvitation', 'role');
    const teamIds = (body.team_ids as number[] | undefined) ?? [];
    for (const id of teamIds)
      if (!org.teams.some((t) => t.id === id))
        throw invalidField('OrganizationInvitation', 'team_ids');
    let target: { login?: string; email?: string };
    if (typeof body.invitee_id === 'number') {
      const user = [...state.users.values()].find((u) => u.id === body.invitee_id);
      if (!user) throw invalidField('OrganizationInvitation', 'invitee_id');
      target = { login: user.login };
    } else if (typeof body.email === 'string' && body.email) target = { email: body.email };
    else
      throw validationFailed({
        resource: 'OrganizationInvitation',
        code: 'missing_field',
        field: 'invitee_id',
      });
    const inv = state.invite(org, target, role, teamIds, q.auth.actor);
    return { status: 201, body: q.ser.orgInvitation(org, inv) };
  });

  r.delete('/orgs/:org/invitations/:id', ['members', 'write'], (q) => {
    const org = orgFor(q, q.param('org'));
    state.purgeExpired(org);
    const id = Number(q.param('id'));
    if (!org.invitations.some((i) => i.id === id)) throw notFound();
    org.invitations = org.invitations.filter((i) => i.id !== id);
    return {};
  });

  // -- teams --------------------------------------------------------------------------------------

  r.get('/orgs/:org/teams', ['members', 'read'], (q) => {
    const org = orgFor(q, q.param('org'));
    return q.page(org.teams, (t) => q.ser.team(org, t));
  });

  r.post('/orgs/:org/teams', ['members', 'write'], async (q) => {
    const org = orgFor(q, q.param('org'));
    const body = await q.body();
    if (typeof body.name !== 'string' || !body.name.trim())
      throw validationFailed({ resource: 'Team', code: 'missing_field', field: 'name' });
    const privacy =
      (body.privacy as string | undefined) ?? (body.parent_team_id ? 'closed' : 'secret');
    if (privacy !== 'secret' && privacy !== 'closed') throw invalidField('Team', 'privacy');
    const team = state.addTeam(org.login, {
      name: body.name,
      description: (body.description as string | undefined) ?? null,
      privacy,
      parentId: (body.parent_team_id as number | undefined) ?? null,
      maintainers: (body.maintainers as string[] | undefined) ?? [],
    });
    for (const slug of (body.repo_names as string[] | undefined) ?? []) {
      const repo = state.findRepo(org.login, slug.split('/').pop() as string);
      if (!repo) throw invalidField('Team', 'repo_names');
      state.grantTeam(repo, team, (body.permission as string | undefined) ?? 'pull');
    }
    return { status: 201, body: q.ser.teamFull(org, team) };
  });

  r.get('/orgs/:org/teams/:slug', ['members', 'read'], (q) => {
    const org = orgFor(q, q.param('org'));
    return { body: q.ser.teamFull(org, state.requireTeam(org, q.param('slug'))) };
  });

  // The child teams of a team (one level, as GitHub lists them).
  r.get('/orgs/:org/teams/:slug/teams', ['members', 'read'], (q) => {
    const org = orgFor(q, q.param('org'));
    const team = state.requireTeam(org, q.param('slug'));
    return q.page(
      org.teams.filter((t) => t.parentId === team.id),
      (t) => q.ser.team(org, t),
    );
  });

  // Deleting a team deletes its child teams too, and its memberships and repository grants go with it.
  r.delete('/orgs/:org/teams/:slug', ['members', 'write'], (q) => {
    const org = orgFor(q, q.param('org'));
    const team = state.requireTeam(org, q.param('slug'));
    const doomed = new Set<number>([team.id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const t of org.teams) {
        if (t.parentId !== null && doomed.has(t.parentId) && !doomed.has(t.id)) {
          doomed.add(t.id);
          grew = true;
        }
      }
    }
    org.teams = org.teams.filter((t) => !doomed.has(t.id));
    return {};
  });

  r.get('/orgs/:org/teams/:slug/members', ['members', 'read'], (q) => {
    const org = orgFor(q, q.param('org'));
    const team = state.requireTeam(org, q.param('slug'));
    const role = q.url.searchParams.get('role') ?? 'all';
    const logins = [...team.members]
      .filter(([, m]) => m.state === 'active' && (role === 'all' || m.role === role))
      .map(([l]) => l);
    return q.page(logins, (l) => q.ser.userByLogin(l));
  });

  r.get('/orgs/:org/teams/:slug/memberships/:login', ['members', 'read'], (q) => {
    const org = orgFor(q, q.param('org'));
    const team = state.requireTeam(org, q.param('slug'));
    const user = state.findUser(q.param('login'));
    const m = user && team.members.get(user.login);
    if (!user || !m) throw notFound();
    return { body: q.ser.teamMembership(org, team, user.login, m) };
  });

  r.put('/orgs/:org/teams/:slug/memberships/:login', ['members', 'write'], async (q) => {
    const org = orgFor(q, q.param('org'));
    const team = state.requireTeam(org, q.param('slug'));
    const body = await q.body();
    const role = (body.role as string | undefined) ?? 'member';
    if (role !== 'member' && role !== 'maintainer') throw invalidField('Team', 'role');
    const user = state.findUser(q.param('login'));
    if (!user) throw validationFailed({ resource: 'Team', code: 'invalid', field: 'username' });
    const m = state.setTeamMembership(org, team, user.login, role);
    return { body: q.ser.teamMembership(org, team, user.login, m) };
  });

  r.delete('/orgs/:org/teams/:slug/memberships/:login', ['members', 'write'], (q) => {
    const org = orgFor(q, q.param('org'));
    const team = state.requireTeam(org, q.param('slug'));
    const user = state.findUser(q.param('login'));
    if (user) team.members.delete(user.login);
    return {};
  });
}

function covers(
  inst: { repositorySelection: string; repositories: string[] },
  repo: RepoRec,
): boolean {
  return (
    inst.repositorySelection === 'all' ||
    inst.repositories
      .map((x) => x.toLowerCase())
      .includes(`${repo.owner}/${repo.name}`.toLowerCase())
  );
}

function visibleRepos(
  state: GitHubState,
  q: {
    auth: {
      installation?: { account: string; repositorySelection: string; repositories: string[] };
      token?: { repositoryIds: number[] | null };
    };
  },
): RepoRec[] {
  const inst = q.auth.installation;
  if (!inst) return [];
  const ids = q.auth.token?.repositoryIds;
  return [...state.repos.values()].filter(
    (repo) =>
      repo.owner.toLowerCase() === inst.account.toLowerCase() &&
      covers(inst, repo) &&
      (!ids || ids.includes(repo.id)),
  );
}
