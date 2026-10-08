import type { GitCommit } from './git-store.ts';
import type { GitHubState } from './state.ts';
import {
  type AppRec,
  type BranchRule,
  type DeployKeyRec,
  type EnvironmentRec,
  type HookRec,
  type InstallationRec,
  type InvitationRec,
  type OrgRec,
  type PullRec,
  type RepoInvitationRec,
  type RepoRec,
  ROLES,
  type Role,
  type SecretRec,
  type TeamRec,
  type UserRec,
  type VariableRec,
} from './types.ts';
import { iso } from './util.ts';

/** Builds JSON bodies in the shapes of GitHub's REST OpenAPI description. `base` is the API origin. */
export class Serializer {
  readonly state: GitHubState;
  readonly base: string;

  constructor(state: GitHubState, base: string) {
    this.state = state;
    this.base = base;
  }

  private t(ms: number): string {
    return iso(ms);
  }

  // -- accounts ---------------------------------------------------------------------------------

  simpleUser(user: UserRec | { login: string; id: number; nodeId: string; type?: string }) {
    const b = this.base;
    const login = user.login;
    return {
      login,
      id: user.id,
      node_id: user.nodeId,
      avatar_url: `${b}/avatars/u/${user.id}`,
      gravatar_id: '',
      url: `${b}/users/${login}`,
      html_url: `${b}/${login}`,
      followers_url: `${b}/users/${login}/followers`,
      following_url: `${b}/users/${login}/following{/other_user}`,
      gists_url: `${b}/users/${login}/gists{/gist_id}`,
      starred_url: `${b}/users/${login}/starred{/owner}{/repo}`,
      subscriptions_url: `${b}/users/${login}/subscriptions`,
      organizations_url: `${b}/users/${login}/orgs`,
      repos_url: `${b}/users/${login}/repos`,
      events_url: `${b}/users/${login}/events{/privacy}`,
      received_events_url: `${b}/users/${login}/received_events`,
      type: user.type ?? 'User',
      site_admin: false,
    };
  }

  userByLogin(login: string) {
    const u = this.state.findUser(login);
    return u ? this.simpleUser(u) : null;
  }

  /** `GET /users/{login}` (private-user excluded; public profile only). */
  publicUser(user: UserRec) {
    return {
      ...this.simpleUser(user),
      name: user.name,
      company: null,
      blog: '',
      location: null,
      email: user.publicEmail,
      hireable: null,
      bio: null,
      twitter_username: null,
      public_repos: 0,
      public_gists: 0,
      followers: 0,
      following: 0,
      created_at: this.t(0),
      updated_at: this.t(0),
    };
  }

  orgSimple(org: OrgRec) {
    const b = this.base;
    const l = org.login;
    return {
      login: l,
      id: org.id,
      node_id: org.nodeId,
      url: `${b}/orgs/${l}`,
      repos_url: `${b}/orgs/${l}/repos`,
      events_url: `${b}/orgs/${l}/events`,
      hooks_url: `${b}/orgs/${l}/hooks`,
      issues_url: `${b}/orgs/${l}/issues`,
      members_url: `${b}/orgs/${l}/members{/member}`,
      public_members_url: `${b}/orgs/${l}/public_members{/member}`,
      avatar_url: `${b}/avatars/u/${org.id}`,
      description: org.description,
    };
  }

  orgAsOwner(org: OrgRec) {
    return this.simpleUser({
      login: org.login,
      id: org.id,
      nodeId: org.nodeId,
      type: 'Organization',
    });
  }

  /** Plan data needs the Organization plan permission; settings are for owners (provider doc). */
  organizationFull(org: OrgRec, opts: { plan: boolean }) {
    const repos = [...this.state.repos.values()].filter(
      (r) => r.owner.toLowerCase() === org.login.toLowerCase(),
    );
    return {
      ...this.orgSimple(org),
      html_url: `${this.base}/${org.login}`,
      name: org.login,
      has_organization_projects: true,
      has_repository_projects: true,
      public_repos: repos.filter((r) => !r.private).length,
      public_gists: 0,
      followers: 0,
      following: 0,
      type: 'Organization',
      created_at: this.t(org.createdAt),
      updated_at: this.t(org.createdAt),
      archived_at: null,
      ...(org.exposeSettings
        ? {
            members_can_create_repositories: true,
            members_can_create_private_repositories: org.membersCanCreatePrivateRepositories,
            members_can_create_public_repositories: true,
            members_can_fork_private_repositories: org.membersCanForkPrivateRepositories,
            default_repository_permission:
              org.baseRole === 'pull' ? 'read' : org.baseRole === 'push' ? 'write' : org.baseRole,
          }
        : {}),
      ...(opts.plan
        ? {
            plan: {
              name: org.plan.name,
              space: org.plan.space,
              private_repos: org.plan.privateRepos,
              filled_seats: org.members.size,
              seats: org.plan.seats ?? 0,
            },
          }
        : {}),
    };
  }

  // -- repositories -----------------------------------------------------------------------------

  private repoUrls(r: RepoRec) {
    const api = `${this.base}/repos/${r.owner}/${r.name}`;
    return {
      url: api,
      archive_url: `${api}/{archive_format}{/ref}`,
      assignees_url: `${api}/assignees{/user}`,
      blobs_url: `${api}/git/blobs{/sha}`,
      branches_url: `${api}/branches{/branch}`,
      collaborators_url: `${api}/collaborators{/collaborator}`,
      comments_url: `${api}/comments{/number}`,
      commits_url: `${api}/commits{/sha}`,
      compare_url: `${api}/compare/{base}...{head}`,
      contents_url: `${api}/contents/{+path}`,
      contributors_url: `${api}/contributors`,
      deployments_url: `${api}/deployments`,
      downloads_url: `${api}/downloads`,
      events_url: `${api}/events`,
      forks_url: `${api}/forks`,
      git_commits_url: `${api}/git/commits{/sha}`,
      git_refs_url: `${api}/git/refs{/sha}`,
      git_tags_url: `${api}/git/tags{/sha}`,
      hooks_url: `${api}/hooks`,
      issue_comment_url: `${api}/issues/comments{/number}`,
      issue_events_url: `${api}/issues/events{/number}`,
      issues_url: `${api}/issues{/number}`,
      keys_url: `${api}/keys{/key_id}`,
      labels_url: `${api}/labels{/name}`,
      languages_url: `${api}/languages`,
      merges_url: `${api}/merges`,
      milestones_url: `${api}/milestones{/number}`,
      notifications_url: `${api}/notifications{?since,all,participating}`,
      pulls_url: `${api}/pulls{/number}`,
      releases_url: `${api}/releases{/id}`,
      stargazers_url: `${api}/stargazers`,
      statuses_url: `${api}/statuses/{sha}`,
      subscribers_url: `${api}/subscribers`,
      subscription_url: `${api}/subscription`,
      tags_url: `${api}/tags`,
      teams_url: `${api}/teams`,
      trees_url: `${api}/git/trees{/sha}`,
    };
  }

  private repoOwner(r: RepoRec) {
    const org = this.state.orgs.get(r.owner.toLowerCase());
    return org ? this.orgAsOwner(org) : (this.userByLogin(r.owner) as object);
  }

  repoMinimal(r: RepoRec) {
    return {
      id: r.id,
      node_id: r.nodeId,
      name: r.name,
      full_name: `${r.owner}/${r.name}`,
      owner: this.repoOwner(r),
      private: r.private,
      html_url: `${this.base}/${r.owner}/${r.name}`,
      description: r.description,
      fork: false,
      ...this.repoUrls(r),
    };
  }

  repoFull(r: RepoRec) {
    const full = `${r.owner}/${r.name}`;
    const clone = `${this.state.gitBaseUrl}/${full}.git`;
    return {
      ...this.repoMinimal(r),
      homepage: r.homepage,
      language: null,
      forks_count: 0,
      forks: 0,
      stargazers_count: 0,
      watchers_count: 0,
      watchers: 0,
      size: this.sizeKb(r),
      default_branch: r.defaultBranch,
      open_issues_count: 0,
      open_issues: 0,
      is_template: false,
      topics: [] as string[],
      has_issues: r.hasIssues,
      has_projects: r.hasProjects,
      has_wiki: r.hasWiki,
      has_pages: false,
      has_downloads: true,
      has_discussions: false,
      archived: r.archived,
      disabled: false,
      visibility: r.visibility,
      pushed_at: this.t(r.pushedAt ?? r.createdAt),
      created_at: this.t(r.createdAt),
      updated_at: this.t(r.updatedAt),
      allow_forking: r.allowForking,
      allow_merge_commit: r.allowMergeCommit,
      allow_squash_merge: r.allowSquashMerge,
      allow_rebase_merge: r.allowRebaseMerge,
      delete_branch_on_merge: r.deleteBranchOnMerge,
      web_commit_signoff_required: false,
      permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
      clone_url: clone,
      git_url: `git://github.invalid/${full}.git`,
      ssh_url: `git@github.invalid:${full}.git`,
      svn_url: `${this.base}/${full}`,
      mirror_url: null,
      license: null,
      organization: undefined,
      network_count: 0,
      subscribers_count: 0,
    };
  }

  private sizeKb(r: RepoRec): number {
    let bytes = 0;
    for (const b of r.git.blobs.values()) bytes += b.length;
    return Math.ceil(bytes / 1024);
  }

  // -- teams ------------------------------------------------------------------------------------

  private teamBase(org: OrgRec, t: TeamRec) {
    const api = `${this.base}/organizations/${org.id}/team/${t.id}`;
    return {
      id: t.id,
      node_id: t.nodeId,
      url: api,
      html_url: `${this.base}/orgs/${org.login}/teams/${t.slug}`,
      name: t.name,
      slug: t.slug,
      description: t.description,
      privacy: t.privacy,
      notification_setting: 'notifications_enabled',
      permission: 'pull',
      members_url: `${api}/members{/member}`,
      repositories_url: `${api}/repos`,
      type: 'organization' as const,
    };
  }

  teamSimple(org: OrgRec, t: TeamRec) {
    return this.teamBase(org, t);
  }

  team(org: OrgRec, t: TeamRec) {
    const parent = t.parentId == null ? undefined : org.teams.find((p) => p.id === t.parentId);
    return { ...this.teamBase(org, t), parent: parent ? this.teamBase(org, parent) : null };
  }

  teamFull(org: OrgRec, t: TeamRec) {
    return {
      ...this.team(org, t),
      created_at: this.t(t.createdAt),
      updated_at: this.t(t.updatedAt),
      members_count: [...t.members.values()].filter((m) => m.state === 'active').length,
      repos_count: t.repos.size,
      organization: {
        ...this.orgSimple(org),
        html_url: `${this.base}/${org.login}`,
        has_organization_projects: true,
        has_repository_projects: true,
        public_repos: 0,
        public_gists: 0,
        followers: 0,
        following: 0,
        type: 'Organization',
        created_at: this.t(org.createdAt),
        updated_at: this.t(org.createdAt),
        archived_at: null,
      },
    };
  }

  teamMembership(org: OrgRec, t: TeamRec, login: string, m: { role: string; state: string }) {
    return {
      url: `${this.base}/organizations/${org.id}/team/${t.id}/memberships/${login}`,
      role: m.role,
      state: m.state,
    };
  }

  // -- invitations ------------------------------------------------------------------------------

  orgInvitation(org: OrgRec, i: InvitationRec) {
    const inviter = this.state.findUser(i.inviter);
    return {
      id: i.id,
      node_id: i.nodeId,
      login: i.login,
      email: i.email,
      role: i.role,
      created_at: this.t(i.createdAt),
      failed_at: i.failedAt == null ? null : this.t(i.failedAt),
      failed_reason: i.failedReason,
      inviter: inviter
        ? this.simpleUser(inviter)
        : this.simpleUser({
            login: i.inviter,
            id: this.state.ownApp.id,
            nodeId: this.state.ownApp.nodeId,
            type: 'Bot',
          }),
      team_count: i.teamIds.length,
      invitation_teams_url: `${this.base}/organizations/${org.id}/invitations/${i.id}/teams`,
      invitation_team_url: `${this.base}/organizations/${org.id}/invitations/${i.id}/teams`,
    };
  }

  repoInvitation(repo: RepoRec, i: RepoInvitationRec) {
    const inv = this.state.findUser(i.invitee);
    const by = this.state.findUser(i.inviter);
    const permissions = (
      {
        pull: 'read',
        triage: 'triage',
        push: 'write',
        maintain: 'maintain',
        admin: 'admin',
      } as Record<Role, string>
    )[i.permission];
    return {
      id: i.id,
      node_id: i.nodeId,
      repository: this.repoMinimal(repo),
      invitee: inv ? this.simpleUser(inv) : null,
      inviter: by ? this.simpleUser(by) : null,
      permissions,
      created_at: this.t(i.createdAt),
      expired: i.expiresAt <= this.state.clock(),
      url: `${this.base}/user/repository_invitations/${i.id}`,
      html_url: `${this.base}/${repo.owner}/${repo.name}/invitations`,
    };
  }

  // -- collaborators ----------------------------------------------------------------------------

  collaborator(repo: RepoRec, user: UserRec) {
    const role = this.state.userRole(repo, user.login) ?? 'pull';
    const rank = ROLES.indexOf(role);
    const raw = [...repo.collaborators].find(
      ([l]) => l.toLowerCase() === user.login.toLowerCase(),
    )?.[1];
    const names: Record<Role, string> = {
      pull: 'read',
      triage: 'triage',
      push: 'write',
      maintain: 'maintain',
      admin: 'admin',
    };
    return {
      ...this.simpleUser(user),
      permissions: {
        pull: rank >= 0,
        triage: rank >= 1,
        push: rank >= 2,
        maintain: rank >= 3,
        admin: rank >= 4,
      },
      role_name:
        raw && !(ROLES as readonly string[]).includes(raw) && !['read', 'write'].includes(raw)
          ? raw
          : names[role],
    };
  }

  // -- apps -------------------------------------------------------------------------------------

  integration(app: AppRec) {
    const owner = this.state.orgs.get(app.ownerLogin.toLowerCase());
    return {
      id: app.id,
      slug: app.slug,
      node_id: app.nodeId,
      client_id: this.state.appClientId,
      owner: owner
        ? this.orgAsOwner(owner)
        : this.simpleUser({ login: app.ownerLogin, id: 1, nodeId: nodeIdFor(app.ownerLogin) }),
      name: app.name,
      description: app.description,
      external_url: `${this.base}/apps/${app.slug}`,
      html_url: `${this.base}/apps/${app.slug}`,
      created_at: this.t(0),
      updated_at: this.t(0),
      permissions: app.permissions,
      events: app.events,
    };
  }

  installation(i: InstallationRec) {
    const org = this.state.orgs.get(i.account.toLowerCase()) as OrgRec;
    const app = this.state.apps.get(i.appId) as AppRec;
    return {
      id: i.id,
      account: this.orgAsOwner(org),
      repository_selection: i.repositorySelection,
      access_tokens_url: `${this.base}/app/installations/${i.id}/access_tokens`,
      repositories_url: `${this.base}/installation/repositories`,
      html_url: `${this.base}/organizations/${org.login}/settings/installations/${i.id}`,
      app_id: i.appId,
      app_slug: app.slug,
      target_id: org.id,
      target_type: 'Organization',
      permissions: i.permissions,
      events: [] as string[],
      created_at: this.t(0),
      updated_at: this.t(0),
      single_file_name: null,
      suspended_by: null,
      suspended_at: null,
    };
  }

  // -- keys, hooks, environments, secrets -------------------------------------------------------

  deployKey(repo: RepoRec, k: DeployKeyRec) {
    return {
      id: k.id,
      key: k.key,
      url: `${this.base}/repos/${repo.owner}/${repo.name}/keys/${k.id}`,
      title: k.title,
      verified: k.verified,
      created_at: this.t(k.createdAt),
      read_only: k.readOnly,
      added_by: null,
      last_used: null,
    };
  }

  hook(urlBase: string, h: HookRec) {
    const api = `${urlBase}/hooks/${h.id}`;
    return {
      type: 'Repository',
      id: h.id,
      name: h.name,
      active: h.active,
      events: h.events,
      config: this.hookConfig(h),
      updated_at: this.t(h.updatedAt),
      created_at: this.t(h.createdAt),
      url: api,
      test_url: `${api}/test`,
      ping_url: `${api}/pings`,
      deliveries_url: `${api}/deliveries`,
      last_response: { code: null, status: 'unused', message: null },
    };
  }

  hookConfig(h: HookRec) {
    const { secret, ...rest } = h.config;
    return { ...rest, ...(secret ? { secret: '********' } : {}) };
  }

  environment(repo: RepoRec, e: EnvironmentRec) {
    const rules: unknown[] = [];
    if (e.waitTimer)
      rules.push({
        id: e.id * 10 + 1,
        node_id: `${e.nodeId}w`,
        type: 'wait_timer',
        wait_timer: e.waitTimer,
      });
    if (e.reviewers.length)
      rules.push({
        id: e.id * 10 + 2,
        node_id: `${e.nodeId}r`,
        type: 'required_reviewers',
        prevent_self_review: e.preventSelfReview,
        reviewers: e.reviewers.map((r) => {
          const user =
            r.type === 'User'
              ? [...this.state.users.values()].find((u) => u.id === r.id)
              : undefined;
          return { type: r.type, reviewer: user ? this.simpleUser(user) : { id: r.id } };
        }),
      });
    if (e.deploymentBranchPolicy)
      rules.push({ id: e.id * 10 + 3, node_id: `${e.nodeId}b`, type: 'branch_policy' });
    return {
      id: e.id,
      node_id: e.nodeId,
      name: e.name,
      url: `${this.base}/repos/${repo.owner}/${repo.name}/environments/${e.name}`,
      html_url: `${this.base}/${repo.owner}/${repo.name}/deployments/activity_log?environments_filter=${e.name}`,
      created_at: this.t(e.createdAt),
      updated_at: this.t(e.updatedAt),
      protection_rules: rules,
      deployment_branch_policy: e.deploymentBranchPolicy
        ? {
            protected_branches: e.deploymentBranchPolicy.protectedBranches,
            custom_branch_policies: e.deploymentBranchPolicy.customBranchPolicies,
          }
        : null,
    };
  }

  secret(s: SecretRec, org = false) {
    return {
      name: s.name,
      created_at: this.t(s.createdAt),
      updated_at: this.t(s.updatedAt),
      ...(org
        ? {
            visibility: s.visibility,
            ...(s.visibility === 'selected' ? { selected_repositories_url: '' } : {}),
          }
        : {}),
    };
  }

  variable(v: VariableRec, org = false) {
    return {
      name: v.name,
      value: v.value,
      created_at: this.t(v.createdAt),
      updated_at: this.t(v.updatedAt),
      ...(org ? { visibility: v.visibility } : {}),
    };
  }

  // -- git data ---------------------------------------------------------------------------------

  private sig(s: { name: string; email: string; date: string }) {
    return { name: s.name, email: s.email, date: s.date };
  }

  gitCommit(repo: RepoRec, c: GitCommit) {
    const api = `${this.base}/repos/${repo.owner}/${repo.name}`;
    return {
      sha: c.sha,
      node_id: `C_${c.sha.slice(0, 20)}`,
      url: `${api}/git/commits/${c.sha}`,
      html_url: `${this.base}/${repo.owner}/${repo.name}/commit/${c.sha}`,
      author: this.sig(c.author),
      committer: this.sig(c.committer),
      tree: { sha: c.tree, url: `${api}/git/trees/${c.tree}` },
      message: c.message,
      parents: c.parents.map((p) => ({
        sha: p,
        url: `${api}/git/commits/${p}`,
        html_url: `${this.base}/${repo.owner}/${repo.name}/commit/${p}`,
      })),
      verification: {
        verified: false,
        reason: 'unsigned',
        signature: null,
        payload: null,
        verified_at: null,
      },
    };
  }

  /** The `commit` schema of the commits and compare endpoints. */
  commit(repo: RepoRec, c: GitCommit) {
    const api = `${this.base}/repos/${repo.owner}/${repo.name}`;
    const g = this.gitCommit(repo, c);
    return {
      url: `${api}/commits/${c.sha}`,
      sha: c.sha,
      node_id: g.node_id,
      html_url: g.html_url,
      comments_url: `${api}/commits/${c.sha}/comments`,
      commit: {
        url: g.url,
        author: g.author,
        committer: g.committer,
        message: c.message,
        comment_count: 0,
        tree: g.tree,
        verification: g.verification,
      },
      author: null,
      committer: null,
      parents: g.parents.map((p) => ({
        sha: p.sha,
        url: `${api}/commits/${p.sha}`,
        html_url: p.html_url,
      })),
    };
  }

  // -- pulls ------------------------------------------------------------------------------------

  pullSimple(repo: RepoRec, p: PullRec) {
    const api = `${this.base}/repos/${repo.owner}/${repo.name}`;
    const html = `${this.base}/${repo.owner}/${repo.name}/pull/${p.number}`;
    const userRec = this.state.findUser(p.user);
    const user = userRec
      ? this.simpleUser(userRec)
      : this.simpleUser({
          login: p.user,
          id: this.state.ownApp.id,
          nodeId: this.state.ownApp.nodeId,
          type: 'Bot',
        });
    const side = (ref: string, sha: string) => ({
      label: `${repo.owner}:${ref}`,
      ref,
      sha,
      user: this.repoOwner(repo),
      repo: this.repoFull(repo),
    });
    const href = (h: string) => ({ href: h });
    return {
      url: `${api}/pulls/${p.number}`,
      id: p.id,
      node_id: p.nodeId,
      html_url: html,
      diff_url: `${html}.diff`,
      patch_url: `${html}.patch`,
      issue_url: `${api}/issues/${p.number}`,
      commits_url: `${api}/pulls/${p.number}/commits`,
      review_comments_url: `${api}/pulls/${p.number}/comments`,
      review_comment_url: `${api}/pulls/comments{/number}`,
      comments_url: `${api}/issues/${p.number}/comments`,
      statuses_url: `${api}/statuses/${p.headSha}`,
      number: p.number,
      state: p.state,
      locked: false,
      title: p.title,
      user,
      body: p.body,
      labels: [] as unknown[],
      milestone: null,
      active_lock_reason: null,
      created_at: this.t(p.createdAt),
      updated_at: this.t(p.updatedAt),
      closed_at: p.closedAt == null ? null : this.t(p.closedAt),
      merged_at: p.merged && p.closedAt !== null ? this.t(p.closedAt) : null,
      merge_commit_sha: null,
      assignee: null,
      assignees: [] as unknown[],
      requested_reviewers: [] as unknown[],
      requested_teams: [] as unknown[],
      head: side(p.headRef, p.headSha),
      base: side(p.baseRef, p.baseSha),
      _links: {
        self: href(`${api}/pulls/${p.number}`),
        html: href(html),
        issue: href(`${api}/issues/${p.number}`),
        comments: href(`${api}/issues/${p.number}/comments`),
        review_comments: href(`${api}/pulls/${p.number}/comments`),
        review_comment: href(`${api}/pulls/comments{/number}`),
        commits: href(`${api}/pulls/${p.number}/commits`),
        statuses: href(`${api}/statuses/${p.headSha}`),
      },
      author_association: 'OWNER',
      auto_merge: null,
      draft: p.draft,
    };
  }

  pull(repo: RepoRec, p: PullRec) {
    const commits = repo.git.range(p.baseSha, p.headSha);
    return {
      ...this.pullSimple(repo, p),
      merged: p.merged,
      mergeable: true,
      rebaseable: true,
      mergeable_state: 'clean',
      merged_by: null,
      comments: 0,
      review_comments: 0,
      maintainer_can_modify: false,
      commits: commits.length,
      additions: 0,
      deletions: 0,
      changed_files: 0,
    };
  }

  // -- branch protection (REST) -----------------------------------------------------------------

  /** `rule` is a GraphQL-model rule; actors are node ids. */
  restProtection(repo: RepoRec, branch: string, r: BranchRule) {
    const api = `${this.base}/repos/${repo.owner}/${repo.name}/branches/${branch}/protection`;
    const actors = [...r.pushActorIds].map((id) => this.state.findNode(id));
    const toggle = (enabled: boolean) => ({ enabled });
    return {
      url: api,
      required_status_checks: r.requiresStatusChecks
        ? {
            url: `${api}/required_status_checks`,
            strict: r.requiresStrictStatusChecks,
            contexts: r.requiredStatusChecks.map((c) => c.context),
            contexts_url: `${api}/required_status_checks/contexts`,
            checks: r.requiredStatusChecks.map((c) => ({
              context: c.context,
              app_id: c.appId == null ? null : Number(c.appId),
            })),
          }
        : undefined,
      required_pull_request_reviews: r.requiresApprovingReviews
        ? {
            url: `${api}/required_pull_request_reviews`,
            dismiss_stale_reviews: r.dismissesStaleReviews,
            require_code_owner_reviews: r.requiresCodeOwnerReviews,
            required_approving_review_count: r.requiredApprovingReviewCount ?? 0,
            require_last_push_approval: r.requireLastPushApproval,
          }
        : undefined,
      required_signatures: {
        url: `${api}/required_signatures`,
        enabled: r.requiresCommitSignatures,
      },
      enforce_admins: { url: `${api}/enforce_admins`, enabled: r.isAdminEnforced },
      required_linear_history: toggle(r.requiresLinearHistory),
      allow_force_pushes: toggle(r.allowsForcePushes),
      allow_deletions: toggle(r.allowsDeletions),
      block_creations: toggle(r.blocksCreations),
      required_conversation_resolution: toggle(r.requiresConversationResolution),
      lock_branch: toggle(r.lockBranch),
      allow_fork_syncing: toggle(r.lockAllowsFetchAndMerge),
      restrictions: r.restrictsPushes
        ? {
            url: `${api}/restrictions`,
            users_url: `${api}/restrictions/users`,
            teams_url: `${api}/restrictions/teams`,
            apps_url: `${api}/restrictions/apps`,
            users: actors.flatMap((a) => (a?.type === 'User' ? [this.simpleUser(a.rec)] : [])),
            teams: actors.flatMap((a) => (a?.type === 'Team' ? [this.team(a.org, a.rec)] : [])),
            apps: actors.flatMap((a) =>
              a?.type === 'App'
                ? [{ ...this.integration(a.rec), description: a.rec.description ?? '' }]
                : [],
            ),
          }
        : undefined,
    };
  }
}

function nodeIdFor(login: string): string {
  return Buffer.from(`04:User${login}`).toString('base64');
}
