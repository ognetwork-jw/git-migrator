import { orgFor, type Router } from '../router.ts';
import {
  applyRuleInput,
  createRule,
  defaultRule,
  deleteRule,
  isProtected,
  type RuleInput,
} from '../rules.ts';
import { type GitHubState, INVITATION_TTL_MS, nodeId, roleRank } from '../state.ts';
import { type RepoRec, ROLES, type Role } from '../types.ts';
import {
  forbidden,
  GhError,
  invalidField,
  notFound,
  RuleError,
  validationFailed,
} from '../util.ts';

const API_ROLE_NAME: Record<Role, string> = {
  pull: 'read',
  triage: 'triage',
  push: 'write',
  maintain: 'maintain',
  admin: 'admin',
};

function ruleErrorToHttp(e: unknown): never {
  if (e instanceof RuleError) throw new GhError(422, 'Validation Failed', { errors: [e.message] });
  throw e;
}

export function registerRepos(r: Router, state: GitHubState): void {
  // -- create / get / update / delete -------------------------------------------------------------

  r.post('/orgs/:org/repos', ['administration', 'write'], async (q) => {
    const org = orgFor(q, q.param('org'));
    const body = await q.body();
    const name = body.name;
    if (typeof name !== 'string' || !name)
      throw validationFailed({ resource: 'Repository', code: 'missing_field', field: 'name' });
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || name === '.' || name === '..')
      throw invalidField('Repository', 'name');
    const visibility =
      (body.visibility as string | undefined) ?? (body.private === true ? 'private' : 'public');
    if (!['public', 'private', 'internal'].includes(visibility))
      throw invalidField('Repository', 'visibility');
    if (visibility === 'internal' && org.plan.name !== 'enterprise')
      throw invalidField(
        'Repository',
        'visibility',
        'internal repositories need an enterprise plan',
      );
    if (visibility !== 'public' && !org.membersCanCreatePrivateRepositories)
      throw forbidden('You are not permitted to create private repositories.');
    const repo = state.addRepository(org.login, {
      name,
      description: (body.description as string | undefined) ?? null,
      homepage: (body.homepage as string | undefined) ?? null,
      visibility: visibility as RepoRec['visibility'],
      hasIssues: body.has_issues as boolean | undefined,
      hasProjects: body.has_projects as boolean | undefined,
      hasWiki: body.has_wiki as boolean | undefined,
      files: body.auto_init === true ? { 'README.md': `# ${name}\n` } : undefined,
    });
    try {
      await state.options.repositoryHooks?.created?.(repo);
    } catch (e) {
      state.deleteRepository(repo); // no record without its bare repository
      throw e;
    }
    return { status: 201, body: q.ser.repoFull(repo) };
  });

  r.get('/repos/:owner/:repo', ['metadata', 'read'], (q) => ({ body: q.ser.repoFull(q.repo()) }));

  r.patch('/repos/:owner/:repo', ['administration', 'write'], async (q) => {
    const repo = q.repo();
    const body = await q.body();
    // Validate everything first so a rejected request changes nothing.
    const newName =
      typeof body.name === 'string' && body.name !== repo.name ? body.name : undefined;
    if (newName !== undefined) {
      if (!/^[A-Za-z0-9_.-]+$/.test(newName)) throw invalidField('Repository', 'name');
      if (state.findRepo(repo.owner, newName))
        throw validationFailed({
          resource: 'Repository',
          code: 'custom',
          field: 'name',
          message: 'name already exists on this account',
        });
    }
    if (
      body.default_branch !== undefined &&
      (typeof body.default_branch !== 'string' ||
        !repo.git.refs.has(`refs/heads/${body.default_branch}`))
    )
      throw invalidField(
        'Repository',
        'default_branch',
        'Cannot set default branch: branch does not exist',
      );
    if (
      typeof body.visibility === 'string' &&
      !['public', 'private', 'internal'].includes(body.visibility)
    )
      throw invalidField('Repository', 'visibility');
    if (body.visibility === 'internal' && state.requireOrg(repo.owner).plan.name !== 'enterprise')
      throw invalidField(
        'Repository',
        'visibility',
        'internal repositories need an enterprise plan',
      );

    if (newName !== undefined) {
      const oldName = repo.name;
      const oldKey = state.repoKey(repo.owner, oldName);
      const newKey = state.repoKey(repo.owner, newName);
      state.repos.delete(oldKey);
      repo.name = newName;
      state.repos.set(newKey, repo);
      for (const org of state.orgs.values())
        for (const t of org.teams) {
          const role = t.repos.get(oldKey);
          if (role) {
            t.repos.delete(oldKey);
            t.repos.set(newKey, role);
          }
        }
      await state.options.repositoryHooks?.renamed?.(repo, oldName);
    }
    if (typeof body.default_branch === 'string') repo.defaultBranch = body.default_branch;
    if ('description' in body) repo.description = (body.description as string | null) ?? null;
    if ('homepage' in body) repo.homepage = (body.homepage as string | null) ?? null;
    if (typeof body.archived === 'boolean') repo.archived = body.archived;
    if (typeof body.has_issues === 'boolean') repo.hasIssues = body.has_issues;
    if (typeof body.has_projects === 'boolean') repo.hasProjects = body.has_projects;
    if (typeof body.has_wiki === 'boolean') repo.hasWiki = body.has_wiki;
    if (typeof body.visibility === 'string') {
      repo.visibility = body.visibility as RepoRec['visibility'];
      repo.private = repo.visibility !== 'public';
    } else if (typeof body.private === 'boolean') {
      repo.private = body.private;
      repo.visibility = body.private ? 'private' : 'public';
    }
    repo.updatedAt = state.clock();
    return { body: q.ser.repoFull(repo) };
  });

  // LIF-077: a 403 on delete means the organization forbids deletion; the Run fails with guidance.
  r.delete('/repos/:owner/:repo', ['administration', 'write'], async (q) => {
    const repo = q.repo();
    const org = state.requireOrg(repo.owner);
    if (state.config.repositoryDeletion === 'forbidden' || !org.membersCanDeleteRepositories)
      throw forbidden('Repository deletion is restricted by organization policy.');
    state.deleteRepository(repo);
    await state.options.repositoryHooks?.deleted?.(repo);
    return {};
  });

  // -- collaborators ------------------------------------------------------------------------------

  r.get('/repos/:owner/:repo/collaborators', ['metadata', 'read'], (q) => {
    const repo = q.repo();
    const org = state.requireOrg(repo.owner);
    const affiliation = q.url.searchParams.get('affiliation') ?? 'all';
    if (!['outside', 'direct', 'all'].includes(affiliation))
      throw invalidField('Repository', 'affiliation');
    const permission = q.url.searchParams.get('permission');
    if (permission && !(ROLES as readonly string[]).includes(permission))
      throw invalidField('Repository', 'permission');
    const logins = new Set<string>(repo.collaborators.keys());
    if (affiliation === 'all')
      for (const l of org.members.keys()) if (state.userRole(repo, l)) logins.add(l);
    const users = [...logins]
      .filter((l) => affiliation !== 'outside' || !state.isMember(org, l))
      .map((l) => state.findUser(l))
      .filter((u): u is NonNullable<typeof u> => !!u)
      .filter((u) => !permission || roleRank(state.userRole(repo, u.login)) >= roleRank(permission))
      .sort((a, b) => a.login.localeCompare(b.login));
    return q.page(users, (u) => q.ser.collaborator(repo, u));
  });

  r.get('/repos/:owner/:repo/collaborators/:login', ['metadata', 'read'], (q) => {
    const repo = q.repo();
    if (!state.userRole(repo, q.param('login'))) throw notFound();
    return {};
  });

  r.put('/repos/:owner/:repo/collaborators/:login', ['administration', 'write'], async (q) => {
    const repo = q.repo();
    const org = state.requireOrg(repo.owner);
    const body = await q.body();
    const requested = (body.permission as string | undefined) ?? 'push';
    const role = state.resolveRole(org, requested);
    if (!role) throw invalidField('Repository', 'permission');
    const user = state.findUser(q.param('login'));
    if (!user) throw notFound();
    const isMember = state.isMember(org, user.login);
    if (isMember && org.baseRole !== 'none' && roleRank(org.baseRole) > roleRank(role))
      throw validationFailed({
        resource: 'Repository',
        code: 'custom',
        message: `Cannot assign ${user.login} permission of ${API_ROLE_NAME[role]}`,
      });
    const stored = (ROLES as readonly string[]).includes(requested) ? requested : requested;
    const hasDirect = [...repo.collaborators.keys()].some(
      (l) => l.toLowerCase() === user.login.toLowerCase(),
    );
    if (isMember || hasDirect) {
      repo.collaborators.set(user.login, stored);
      return {};
    }
    // Outside collaborator: an invitation, valid for 7 days.
    state.purgeExpired(org);
    const now = state.clock();
    let inv = repo.repoInvitations.find(
      (i) => i.invitee.toLowerCase() === user.login.toLowerCase(),
    );
    if (inv) inv.permission = role;
    else {
      const id = state.nextId('repoInvitation', 65000);
      inv = {
        id,
        nodeId: nodeId('RepositoryInvitation', id),
        invitee: user.login,
        inviter: q.auth.actor,
        permission: role,
        createdAt: now,
        expiresAt: now + INVITATION_TTL_MS,
      };
      repo.repoInvitations.push(inv);
    }
    return { status: 201, body: q.ser.repoInvitation(repo, inv) };
  });

  r.delete('/repos/:owner/:repo/collaborators/:login', ['administration', 'write'], (q) => {
    const repo = q.repo();
    const login = q.param('login').toLowerCase();
    for (const l of [...repo.collaborators.keys()])
      if (l.toLowerCase() === login) repo.collaborators.delete(l);
    repo.repoInvitations = repo.repoInvitations.filter((i) => i.invitee.toLowerCase() !== login);
    return {};
  });

  r.get('/repos/:owner/:repo/invitations', ['administration', 'read'], (q) => {
    const repo = q.repo();
    state.purgeExpired(state.requireOrg(repo.owner));
    return q.page(repo.repoInvitations, (i) => q.ser.repoInvitation(repo, i));
  });

  // -- teams on repositories ----------------------------------------------------------------------

  r.get('/repos/:owner/:repo/teams', ['metadata', 'read'], (q) => {
    const repo = q.repo();
    const org = state.requireOrg(repo.owner);
    const key = state.repoKey(repo.owner, repo.name);
    const teams = org.teams.filter((t) => t.repos.has(key));
    return q.page(teams, (t) => ({
      ...q.ser.team(org, t),
      permission: t.repos.get(key) as string,
    }));
  });

  r.put('/orgs/:org/teams/:slug/repos/:owner/:repo', ['administration', 'write'], async (q) => {
    const org = orgFor(q, q.param('org'));
    const team = state.requireTeam(org, q.param('slug'));
    const repo = q.repo();
    const body = await q.body();
    const requested = (body.permission as string | undefined) ?? 'push';
    if (!state.resolveRole(org, requested)) throw invalidField('Repository', 'permission');
    state.grantTeam(repo, team, requested);
    return {};
  });

  r.delete('/orgs/:org/teams/:slug/repos/:owner/:repo', ['administration', 'write'], (q) => {
    const org = orgFor(q, q.param('org'));
    const team = state.requireTeam(org, q.param('slug'));
    const repo = q.repo();
    team.repos.delete(state.repoKey(repo.owner, repo.name));
    return {};
  });

  // -- deploy keys --------------------------------------------------------------------------------

  r.get('/repos/:owner/:repo/keys', ['administration', 'read'], (q) => {
    const repo = q.repo();
    return q.page(repo.keys, (k) => q.ser.deployKey(repo, k));
  });

  r.post('/repos/:owner/:repo/keys', ['administration', 'write'], async (q) => {
    const repo = q.repo();
    const body = await q.body();
    if (typeof body.key !== 'string' || !body.key)
      throw validationFailed({ resource: 'PublicKey', code: 'missing_field', field: 'key' });
    const key = state.addDeployKey(repo, {
      key: body.key,
      title: (body.title as string | undefined) ?? '',
      readOnly: body.read_only === true,
    });
    return { status: 201, body: q.ser.deployKey(repo, key) };
  });

  r.get('/repos/:owner/:repo/keys/:id', ['administration', 'read'], (q) => {
    const repo = q.repo();
    const key = repo.keys.find((k) => k.id === Number(q.param('id')));
    if (!key) throw notFound();
    return { body: q.ser.deployKey(repo, key) };
  });

  r.delete('/repos/:owner/:repo/keys/:id', ['administration', 'write'], (q) => {
    const repo = q.repo();
    const id = Number(q.param('id'));
    if (!repo.keys.some((k) => k.id === id)) throw notFound();
    repo.keys = repo.keys.filter((k) => k.id !== id);
    return {};
  });

  // -- branches and REST protection ---------------------------------------------------------------

  r.get('/repos/:owner/:repo/branches', ['metadata', 'read'], (q) => {
    const repo = q.repo();
    const onlyProtected = q.url.searchParams.get('protected');
    const branches = repo.git
      .branches()
      .filter((b) => onlyProtected !== 'true' || isProtected(repo, b));
    const api = `${q.ser.base}/repos/${repo.owner}/${repo.name}`;
    return q.page(branches, (b) => ({
      name: b,
      commit: {
        sha: repo.git.refs.get(`refs/heads/${b}`),
        url: `${api}/commits/${repo.git.refs.get(`refs/heads/${b}`)}`,
      },
      protected: isProtected(repo, b),
    }));
  });

  const restRule = (repo: RepoRec, branch: string) => repo.rules.find((x) => x.pattern === branch);
  const branchExists = (repo: RepoRec, branch: string) => {
    if (!repo.git.refs.has(`refs/heads/${branch}`)) throw notFound('Branch not found');
  };

  r.get('/repos/:owner/:repo/branches/:branch{.+}/protection', ['administration', 'read'], (q) => {
    const repo = q.repo();
    const branch = q.param('branch');
    branchExists(repo, branch);
    const rule = restRule(repo, branch);
    if (!rule) throw notFound('Branch not protected');
    return { body: q.ser.restProtection(repo, branch, rule) };
  });

  r.delete(
    '/repos/:owner/:repo/branches/:branch{.+}/protection',
    ['administration', 'write'],
    (q) => {
      const repo = q.repo();
      const branch = q.param('branch');
      branchExists(repo, branch);
      const rule = restRule(repo, branch);
      if (!rule) throw notFound('Branch not protected');
      deleteRule(state, repo, rule);
      return {};
    },
  );

  // REST only accepts existing branch names, pattern rules go through GraphQL (ADR-0014).
  r.put(
    '/repos/:owner/:repo/branches/:branch{.+}/protection',
    ['administration', 'write'],
    async (q) => {
      const repo = q.repo();
      const branch = q.param('branch');
      branchExists(repo, branch);
      const body = await q.body();
      for (const key of [
        'required_status_checks',
        'enforce_admins',
        'required_pull_request_reviews',
        'restrictions',
      ])
        if (!(key in body))
          throw new GhError(422, 'Validation Failed', {
            errors: [`Invalid request.\n\nFor 'properties/${key}', nil is not an object.`],
          });
      const input: RuleInput = {
        isAdminEnforced: body.enforce_admins === true,
        requiresStatusChecks: false,
        requiredStatusChecks: [],
        requiresApprovingReviews: false,
        restrictsPushes: false,
        pushActorIds: [],
        allowsForcePushes: toggle(body.allow_force_pushes),
        allowsDeletions: toggle(body.allow_deletions),
        blocksCreations: toggle(body.block_creations),
        requiresLinearHistory: toggle(body.required_linear_history),
        requiresConversationResolution: toggle(body.required_conversation_resolution),
        lockBranch: toggle(body.lock_branch),
        lockAllowsFetchAndMerge: toggle(body.allow_fork_syncing),
      };
      const sc = body.required_status_checks as {
        strict?: boolean;
        contexts?: string[];
        checks?: { context: string; app_id?: number | null }[];
      } | null;
      if (sc) {
        input.requiresStatusChecks = true;
        input.requiresStrictStatusChecks = sc.strict === true;
        input.requiredStatusChecks = (
          sc.checks ?? (sc.contexts ?? []).map((context) => ({ context }))
        ).map((c) => ({
          context: c.context,
          appId: 'app_id' in c && c.app_id != null ? String(c.app_id) : null,
        }));
      }
      const pr = body.required_pull_request_reviews as Record<string, unknown> | null;
      if (pr) {
        input.requiresApprovingReviews = true;
        input.requiredApprovingReviewCount =
          typeof pr.required_approving_review_count === 'number'
            ? pr.required_approving_review_count
            : 1;
        input.dismissesStaleReviews = pr.dismiss_stale_reviews === true;
        input.requiresCodeOwnerReviews = pr.require_code_owner_reviews === true;
        input.requireLastPushApproval = pr.require_last_push_approval === true;
      }
      const rs = body.restrictions as {
        users?: string[];
        teams?: string[];
        apps?: string[];
      } | null;
      if (rs) {
        input.restrictsPushes = true;
        const org = state.requireOrg(repo.owner);
        const ids: string[] = [];
        for (const l of rs.users ?? []) {
          const u = state.findUser(l);
          if (!u) throw invalidField('ProtectedBranch', 'restrictions.users');
          ids.push(u.nodeId);
        }
        for (const s of rs.teams ?? []) ids.push(state.requireTeam(org, s).nodeId);
        for (const s of rs.apps ?? []) {
          const app = [...state.apps.values()].find((a) => a.slug === s);
          if (!app) throw invalidField('ProtectedBranch', 'restrictions.apps');
          ids.push(app.nodeId);
        }
        input.pushActorIds = ids;
      }
      try {
        let rule = restRule(repo, branch);
        if (rule) {
          // REST has no bypass lists: keep what GraphQL stored.
          applyRuleInput(state, repo, rule, defaultsFor(input));
        } else rule = createRule(state, repo, branch, defaultsFor(input));
        return { body: q.ser.restProtection(repo, branch, rule) };
      } catch (e) {
        return ruleErrorToHttp(e);
      }
    },
  );
}

const toggle = (v: unknown): boolean =>
  typeof v === 'boolean'
    ? v
    : !!(v && typeof v === 'object' && (v as { enabled?: boolean }).enabled);

/** REST `PUT` replaces the rule: every field returns to its default unless given (bypass lists are kept). */
const defaultsFor = (input: RuleInput): RuleInput => {
  const {
    id: _id,
    nodeId: _node,
    pattern: _pattern,
    bypassForcePushActorIds: _bf,
    bypassPullRequestActorIds: _bp,
    reviewDismissalActorIds: _rd,
    ...defaults
  } = defaultRule(0, '');
  return { ...defaults, ...input };
};
