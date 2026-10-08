import type { BitbucketState } from './state.ts';
import type {
  FakeBranch,
  FakeBranchingModel,
  FakeBranchRestriction,
  FakeDeployKey,
  FakeEnvironment,
  FakeGroup,
  FakeProject,
  FakePullRequest,
  FakeRepository,
  FakeUser,
  FakeVariable,
  FakeWebhook,
  FakeWorkspace,
} from './types.ts';

export interface UrlContext {
  /** Public base of the REST API as the client sees it, e.g. `http://localhost:4010/2.0`. */
  apiBase: string;
  /** Base of the web UI links (`links.html`). */
  webBase: string;
  /** Base of the git HTTP server (T-040), used for `links.clone`. */
  gitBase: string;
}

type Obj = Record<string, unknown>;

const href = (h: string) => ({ href: h });

export class Serializer {
  private readonly state: BitbucketState;
  private readonly urls: UrlContext;

  constructor(state: BitbucketState, urls: UrlContext) {
    this.state = state;
    this.urls = urls;
  }

  account(user: FakeUser): Obj {
    return {
      type: 'user',
      uuid: user.uuid,
      account_id: user.accountId,
      nickname: user.nickname,
      display_name: user.displayName,
      links: {
        self: href(`${this.urls.apiBase}/users/${encodeURIComponent(user.uuid)}`),
        html: href(`${this.urls.webBase}/%7B${user.uuid.slice(1, -1)}%7D/`),
      },
    };
  }

  accountById(accountId: string): Obj {
    const user = this.state.user(accountId);
    return user
      ? this.account(user)
      : { type: 'user', account_id: accountId, display_name: accountId };
  }

  workspaceRef(ws: FakeWorkspace): Obj {
    return {
      type: 'workspace',
      uuid: ws.uuid,
      name: ws.name,
      slug: ws.slug,
      links: { html: href(`${this.urls.webBase}/${ws.slug}/`) },
    };
  }

  workspaceOwner(ws: FakeWorkspace): Obj {
    return {
      type: 'team',
      uuid: ws.uuid,
      display_name: ws.name,
      links: { html: href(`${this.urls.webBase}/${ws.slug}/`) },
    };
  }

  group(ws: FakeWorkspace, g: FakeGroup): Obj {
    return {
      type: 'group',
      name: g.name,
      slug: g.slug,
      full_slug: `${ws.slug}:${g.slug}`,
      workspace: this.workspaceRef(ws),
      links: { self: href(`${this.urls.apiBase}/workspaces/${ws.slug}/groups/${g.slug}`) },
    };
  }

  groupBySlug(ws: FakeWorkspace, slug: string): Obj {
    const g = ws.groups.find((x) => x.slug === slug);
    return g
      ? this.group(ws, g)
      : { type: 'group', name: slug, slug, full_slug: `${ws.slug}:${slug}` };
  }

  project(ws: FakeWorkspace, p: FakeProject): Obj {
    return {
      type: 'project',
      uuid: p.uuid,
      key: p.key,
      name: p.name,
      description: p.description,
      is_private: p.isPrivate,
      created_on: p.createdOn,
      updated_on: p.updatedOn,
      owner: this.workspaceOwner(ws),
      links: {
        html: href(`${this.urls.webBase}/${ws.slug}/workspace/projects/${p.key}`),
        avatar: href(`${this.urls.webBase}/account/projects/${p.key}/avatar/32`),
      },
    };
  }

  repository(ws: FakeWorkspace, r: FakeRepository): Obj {
    const project = ws.projects.find((p) => p.key === r.projectKey);
    const base = `${this.urls.apiBase}/repositories/${ws.slug}/${r.slug}`;
    return {
      type: 'repository',
      uuid: r.uuid,
      full_name: `${ws.slug}/${r.slug}`,
      name: r.name,
      slug: r.slug,
      description: r.description,
      is_private: r.isPrivate,
      scm: 'git',
      fork_policy: r.forkPolicy,
      language: r.language,
      has_issues: r.hasIssues,
      has_wiki: r.hasWiki,
      size: r.size,
      created_on: r.createdOn,
      updated_on: r.updatedOn,
      owner: this.workspaceOwner(ws),
      workspace: this.workspaceRef(ws),
      ...(project ? { project: this.project(ws, project) } : {}),
      mainbranch: r.mainbranch ? { type: 'branch', name: r.mainbranch } : null,
      links: {
        self: href(base),
        html: href(`${this.urls.webBase}/${ws.slug}/${r.slug}`),
        clone: [{ name: 'https', href: `${this.urls.gitBase}/${ws.slug}/${r.slug}.git` }],
        commits: href(`${base}/commits`),
        hooks: href(`${base}/hooks`),
      },
    };
  }

  repositoryRef(ws: FakeWorkspace, r: FakeRepository): Obj {
    return { type: 'repository', uuid: r.uuid, full_name: `${ws.slug}/${r.slug}`, name: r.name };
  }

  commitRef(hash: string): Obj {
    return { type: 'commit', hash };
  }

  branch(b: FakeBranch): Obj {
    return {
      type: 'branch',
      name: b.name,
      target: this.commitRef(b.hash),
      merge_strategies: b.mergeStrategies,
      default_merge_strategy: b.defaultMergeStrategy,
      links: {},
    };
  }

  branchRestriction(ws: FakeWorkspace, repo: FakeRepository, r: FakeBranchRestriction): Obj {
    return {
      type: 'branchrestriction',
      id: r.id,
      kind: r.kind,
      pattern: r.pattern,
      branch_match_kind: r.branchMatchKind,
      ...(r.branchType ? { branch_type: r.branchType } : {}),
      ...(r.value !== undefined ? { value: r.value } : {}),
      users: r.users.map((u) => this.accountById(u)),
      groups: r.groups.map((g) => this.groupBySlug(ws, g)),
      links: {
        self: href(
          `${this.urls.apiBase}/repositories/${ws.slug}/${repo.slug}/branch-restrictions/${r.id}`,
        ),
      },
    };
  }

  webhook(subject: Obj, h: FakeWebhook, subjectType: 'repository' | 'workspace'): Obj {
    // The real API never returns the secret, only `secret_set`.
    return {
      type: 'webhook_subscription',
      uuid: h.uuid,
      url: h.url,
      description: h.description,
      subject_type: subjectType,
      subject,
      active: h.active,
      created_at: h.createdAt,
      events: h.events,
      secret_set: h.secretSet,
    };
  }

  deployKey(ws: FakeWorkspace, repo: FakeRepository, k: FakeDeployKey): Obj {
    return {
      type: 'deploy_key',
      id: k.id,
      key: k.key,
      label: k.label,
      ...(k.comment ? { comment: k.comment } : {}),
      added_on: k.addedOn,
      ...(k.lastUsed ? { last_used: k.lastUsed } : {}),
      repository: this.repositoryRef(ws, repo),
      links: {
        self: href(`${this.urls.apiBase}/repositories/${ws.slug}/${repo.slug}/deploy-keys/${k.id}`),
      },
    };
  }

  projectDeployKey(ws: FakeWorkspace, project: FakeProject, k: FakeDeployKey): Obj {
    return {
      type: 'project_deploy_key',
      id: k.id,
      key: k.key,
      label: k.label,
      ...(k.comment ? { comment: k.comment } : {}),
      added_on: k.addedOn,
      ...(k.lastUsed ? { last_used: k.lastUsed } : {}),
      project: this.project(ws, project),
      links: {
        self: href(
          `${this.urls.apiBase}/workspaces/${ws.slug}/projects/${project.key}/deploy-keys/${k.id}`,
        ),
      },
    };
  }

  variable(v: FakeVariable, type: 'pipeline_variable' | 'deployment_variable'): Obj {
    // Secured variables never expose their value.
    return {
      type,
      uuid: v.uuid,
      key: v.key,
      secured: v.secured,
      ...(v.secured ? {} : { value: v.value }),
    };
  }

  environment(e: FakeEnvironment): Obj {
    return {
      type: 'deployment_environment',
      uuid: e.uuid,
      name: e.name,
      slug: e.slug,
      rank: e.rank,
      environment_type: {
        type: 'deployment_environment_type',
        name: e.environmentType,
        rank: e.rank,
      },
    };
  }

  pullRequest(ws: FakeWorkspace, repo: FakeRepository, pr: FakePullRequest): Obj {
    const endpoint = (branch: string) => ({
      branch: { name: branch },
      repository: this.repositoryRef(ws, repo),
    });
    return {
      type: 'pullrequest',
      id: pr.id,
      title: pr.title,
      state: pr.state,
      author: this.accountById(pr.authorAccountId),
      source: endpoint(pr.sourceBranch),
      destination: endpoint(pr.destinationBranch),
      created_on: pr.createdOn,
      updated_on: pr.updatedOn,
      links: {
        self: href(
          `${this.urls.apiBase}/repositories/${ws.slug}/${repo.slug}/pullrequests/${pr.id}`,
        ),
        html: href(`${this.urls.webBase}/${ws.slug}/${repo.slug}/pull-requests/${pr.id}`),
      },
    };
  }

  private branchTypes(m: FakeBranchingModel, withEnabled: boolean): Obj[] {
    return m.branchTypes
      .filter((t) => withEnabled || t.enabled)
      .map((t) =>
        withEnabled
          ? { kind: t.kind, prefix: t.prefix, enabled: t.enabled }
          : { kind: t.kind, prefix: t.prefix },
      );
  }

  effectiveBranchingModel(repo: FakeRepository): Obj {
    const m = repo.branchingModel;
    const find = (name: string | null) => repo.branches.find((b) => b.name === name);
    const devName = m.developmentUseMainbranch ? repo.mainbranch : m.developmentName;
    const dev = find(devName);
    const prodName = m.production.useMainbranch ? repo.mainbranch : m.production.name;
    const prod = find(prodName);
    return {
      type: 'effective_repository_branching_model',
      branch_types: this.branchTypes(m, false),
      development: {
        name: devName,
        use_mainbranch: m.developmentUseMainbranch,
        ...(dev ? { branch: this.branch(dev) } : {}),
      },
      ...(m.production.enabled
        ? {
            production: {
              name: prodName,
              use_mainbranch: m.production.useMainbranch,
              ...(prod ? { branch: this.branch(prod) } : {}),
            },
          }
        : {}),
      links: {},
    };
  }

  /**
   * `default_branch_deletion` is served as a string, like the real API, and is not in the OpenAPI
   * schema: validation in tests strips it (provider doc, merge settings row).
   */
  branchingModelSettings(m: FakeBranchingModel, mainbranch: string | null, selfHref: string): Obj {
    const devName = m.developmentUseMainbranch ? mainbranch : m.developmentName;
    const prodName = m.production.useMainbranch ? mainbranch : m.production.name;
    return {
      type: 'branching_model_settings',
      branch_types: this.branchTypes(m, true),
      development: {
        is_valid: true,
        ...(devName ? { name: devName } : {}),
        use_mainbranch: m.developmentUseMainbranch,
      },
      production: {
        enabled: m.production.enabled,
        is_valid: true,
        ...(prodName ? { name: prodName } : {}),
        use_mainbranch: m.production.useMainbranch,
      },
      default_branch_deletion: m.defaultBranchDeletion,
      links: { self: href(selfHref) },
    };
  }

  defaultReviewer(reviewerType: string, user: FakeUser): Obj {
    return {
      type: 'default_reviewer_and_type',
      reviewer_type: reviewerType,
      user: this.account(user),
    };
  }

  /** The `/1.0/groups/{ws}` shape (not in the OpenAPI document). */
  legacyGroup(ws: FakeWorkspace, g: FakeGroup): Obj {
    return {
      name: g.name,
      slug: g.slug,
      permission: g.defaultPermission,
      auto_add: g.autoAdd,
      owner: { username: ws.slug, display_name: ws.name },
      members: g.members.map((id) => {
        const u = this.state.user(id);
        return {
          username: u?.nickname ?? id,
          display_name: u?.displayName ?? id,
          uuid: u?.uuid,
          account_id: id,
        };
      }),
    };
  }
}
