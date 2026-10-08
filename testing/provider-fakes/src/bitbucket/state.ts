import { createHash } from 'node:crypto';
import type {
  FakeBranch,
  FakeBranchingModel,
  FakeBranchRestriction,
  FakeCredential,
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
  StateData,
} from './types.ts';

export const FIXED_TIME = '2026-01-01T00:00:00.000000+00:00';

function uuid(n: number): string {
  return `{00000000-0000-4000-8000-${String(n).padStart(12, '0')}}`;
}

export function defaultBranchingModel(): FakeBranchingModel {
  return {
    developmentUseMainbranch: true,
    developmentName: null,
    production: { enabled: false, useMainbranch: true, name: null },
    branchTypes: [
      { kind: 'feature', prefix: 'feature/', enabled: true },
      { kind: 'bugfix', prefix: 'bugfix/', enabled: true },
      { kind: 'release', prefix: 'release/', enabled: true },
      { kind: 'hotfix', prefix: 'hotfix/', enabled: true },
    ],
    defaultBranchDeletion: 'false',
  };
}

export function fakeHash(...parts: string[]): string {
  return createHash('sha1').update(parts.join('\0')).digest('hex');
}

export interface CredentialInput {
  email: string;
  token: string;
  accountId?: string;
  nickname?: string;
  displayName?: string;
  /** Granted scopes; omit for all. Scopes do not imply each other. */
  scopes?: string[];
}

/** The credential the 'empty' fixture and every test starts with. A dummy, not a secret. */
export const DEFAULT_CREDENTIAL = {
  email: 'operator@test.local',
  token: 'fake-bitbucket-api-token',
} as const;

type Patch<T, K extends keyof T> = Partial<T> & Pick<T, K>;

/**
 * Mutable in-memory state plus builders. Builders return the created record so a fixture can
 * adjust it afterwards. Ids and timestamps are deterministic (counter based) so snapshots are
 * stable; `reset()` restarts the counter.
 */
export class BitbucketState {
  data: StateData;
  private readonly initialCredentials: CredentialInput[];

  constructor(initialCredentials: CredentialInput[] = []) {
    this.initialCredentials = initialCredentials;
    this.data = this.blank('empty');
  }

  private blank(fixture: string): StateData {
    const data: StateData = { fixture, seq: 0, users: [], credentials: [], workspaces: [] };
    this.data = data;
    const creds = this.initialCredentials;
    if (creds.length === 0) {
      this.addCredential({ ...DEFAULT_CREDENTIAL, displayName: 'Operator', nickname: 'operator' });
    } else {
      for (const c of creds) {
        this.addCredential(c);
      }
    }
    return data;
  }

  /** Drops every record and re-creates the configured credentials. Returns the new data. */
  reset(fixture = 'empty'): StateData {
    return this.blank(fixture);
  }

  nextId(): number {
    this.data.seq += 1;
    return this.data.seq;
  }

  // ---- identities ---------------------------------------------------------------------------

  addUser(input: Patch<FakeUser, 'nickname'>): FakeUser {
    const n = this.nextId();
    const user: FakeUser = {
      accountId: input.accountId ?? `acct-${String(n).padStart(6, '0')}`,
      uuid: input.uuid ?? uuid(n),
      nickname: input.nickname,
      displayName: input.displayName ?? input.nickname,
      ...(input.email ? { email: input.email } : {}),
    };
    this.data.users.push(user);
    return user;
  }

  user(accountId: string): FakeUser | undefined {
    return this.data.users.find((u) => u.accountId === accountId);
  }

  /** Registers (or reuses) the user for `accountId` and a Basic-auth credential for it. */
  addCredential(input: CredentialInput): FakeCredential {
    let user = input.accountId ? this.user(input.accountId) : undefined;
    user ??= this.addUser({
      nickname: input.nickname ?? input.email.split('@')[0] ?? 'user',
      displayName: input.displayName,
      email: input.email,
      ...(input.accountId ? { accountId: input.accountId } : {}),
    });
    const cred: FakeCredential = {
      email: input.email,
      token: input.token,
      accountId: user.accountId,
      ...(input.scopes ? { scopes: [...input.scopes] } : {}),
    };
    this.data.credentials.push(cred);
    return cred;
  }

  // ---- workspace level ----------------------------------------------------------------------

  addWorkspace(input: Patch<FakeWorkspace, 'slug'>): FakeWorkspace {
    const n = this.nextId();
    const ws: FakeWorkspace = {
      uuid: input.uuid ?? uuid(n),
      slug: input.slug,
      name: input.name ?? input.slug,
      isPrivate: input.isPrivate ?? true,
      createdOn: input.createdOn ?? FIXED_TIME,
      members: input.members ?? [],
      admins: input.admins ?? [],
      groups: input.groups ?? [],
      projects: input.projects ?? [],
      repositories: input.repositories ?? [],
      webhooks: input.webhooks ?? [],
      variables: input.variables ?? [],
    };
    this.data.workspaces.push(ws);
    return ws;
  }

  workspace(slug: string): FakeWorkspace | undefined {
    return this.data.workspaces.find((w) => w.slug === slug);
  }

  private ws(slug: string): FakeWorkspace {
    const ws = this.workspace(slug);
    if (!ws) throw new Error(`fake bitbucket: unknown workspace ${slug}`);
    return ws;
  }

  addMember(workspace: string, accountId: string, opts: { admin?: boolean } = {}): void {
    const ws = this.ws(workspace);
    if (!ws.members.includes(accountId)) ws.members.push(accountId);
    if (opts.admin && !ws.admins.includes(accountId)) ws.admins.push(accountId);
  }

  /** Makes every configured credential's account a member (`admin` for a workspace admin). */
  addCredentialMembers(workspace: string, opts: { admin?: boolean } = {}): void {
    for (const c of this.data.credentials) this.addMember(workspace, c.accountId, opts);
  }

  addGroup(workspace: string, input: Patch<FakeGroup, 'name'>): FakeGroup {
    const group: FakeGroup = {
      slug: input.slug ?? input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      name: input.name,
      members: input.members ?? [],
      defaultPermission: input.defaultPermission ?? 'none',
      autoAdd: input.autoAdd ?? false,
    };
    this.ws(workspace).groups.push(group);
    return group;
  }

  addProject(workspace: string, input: Patch<FakeProject, 'key'>): FakeProject {
    const n = this.nextId();
    const project: FakeProject = {
      uuid: input.uuid ?? uuid(n),
      key: input.key,
      name: input.name ?? input.key,
      description: input.description ?? '',
      isPrivate: input.isPrivate ?? true,
      createdOn: input.createdOn ?? FIXED_TIME,
      updatedOn: input.updatedOn ?? FIXED_TIME,
      userPermissions: input.userPermissions ?? [],
      groupPermissions: input.groupPermissions ?? [],
      deployKeys: input.deployKeys ?? [],
      branchingModel: input.branchingModel ?? defaultBranchingModel(),
    };
    this.ws(workspace).projects.push(project);
    return project;
  }

  addWorkspaceVariable(workspace: string, input: Patch<FakeVariable, 'key'>): FakeVariable {
    const v = this.makeVariable(input);
    this.ws(workspace).variables.push(v);
    return v;
  }

  addWorkspaceWebhook(workspace: string, input: Patch<FakeWebhook, 'url'>): FakeWebhook {
    const hook = this.makeWebhook(input);
    this.ws(workspace).webhooks.push(hook);
    return hook;
  }

  // ---- repository level ---------------------------------------------------------------------

  addRepository(
    workspace: string,
    input: Patch<FakeRepository, 'slug' | 'projectKey'>,
  ): FakeRepository {
    const ws = this.ws(workspace);
    const n = this.nextId();
    const mainbranch = input.mainbranch === undefined ? 'main' : input.mainbranch;
    const repo: FakeRepository = {
      uuid: input.uuid ?? uuid(n),
      slug: input.slug,
      name: input.name ?? input.slug,
      projectKey: input.projectKey,
      description: input.description ?? '',
      isPrivate: input.isPrivate ?? true,
      forkPolicy: input.forkPolicy ?? 'no_public_forks',
      hasIssues: input.hasIssues ?? false,
      hasWiki: input.hasWiki ?? false,
      language: input.language ?? '',
      size: input.size ?? 0,
      mainbranch,
      createdOn: input.createdOn ?? FIXED_TIME,
      updatedOn: input.updatedOn ?? FIXED_TIME,
      gitRoot: input.gitRoot ?? null,
      files: input.files ?? {},
      branches:
        input.branches ?? (mainbranch ? [this.makeBranch(workspace, input.slug, mainbranch)] : []),
      userPermissions: input.userPermissions ?? [],
      groupPermissions: input.groupPermissions ?? [],
      branchRestrictions: input.branchRestrictions ?? [],
      deployKeys: input.deployKeys ?? [],
      webhooks: input.webhooks ?? [],
      pipelinesEnabled: input.pipelinesEnabled ?? false,
      variables: input.variables ?? [],
      environments: input.environments ?? [],
      pullRequests: input.pullRequests ?? [],
      issueCount: input.issueCount ?? 0,
      downloadCount: input.downloadCount ?? 0,
      branchingModel: input.branchingModel ?? defaultBranchingModel(),
      defaultReviewers: input.defaultReviewers ?? [],
    };
    ws.repositories.push(repo);
    return repo;
  }

  repository(workspace: string, slug: string): FakeRepository | undefined {
    return this.workspace(workspace)?.repositories.find((r) => r.slug === slug);
  }

  private repo(workspace: string, slug: string): FakeRepository {
    const repo = this.repository(workspace, slug);
    if (!repo) throw new Error(`fake bitbucket: unknown repository ${workspace}/${slug}`);
    return repo;
  }

  makeBranch(
    workspace: string,
    slug: string,
    name: string,
    patch: Partial<FakeBranch> = {},
  ): FakeBranch {
    return {
      name,
      hash: patch.hash ?? fakeHash(workspace, slug, name),
      mergeStrategies: patch.mergeStrategies ?? ['merge_commit', 'squash', 'fast_forward'],
      defaultMergeStrategy: patch.defaultMergeStrategy ?? 'merge_commit',
    };
  }

  addBranch(
    workspace: string,
    slug: string,
    name: string,
    patch: Partial<FakeBranch> = {},
  ): FakeBranch {
    const branch = this.makeBranch(workspace, slug, name, patch);
    this.repo(workspace, slug).branches.push(branch);
    return branch;
  }

  addBranchRestriction(
    workspace: string,
    slug: string,
    input: Patch<FakeBranchRestriction, 'kind'>,
  ): FakeBranchRestriction {
    const r: FakeBranchRestriction = {
      id: input.id ?? this.nextId(),
      kind: input.kind,
      pattern: input.pattern ?? '',
      branchMatchKind: input.branchMatchKind ?? 'glob',
      ...(input.branchType ? { branchType: input.branchType } : {}),
      ...(input.value !== undefined ? { value: input.value } : {}),
      users: input.users ?? [],
      groups: input.groups ?? [],
    };
    this.repo(workspace, slug).branchRestrictions.push(r);
    return r;
  }

  makeDeployKey(input: Patch<FakeDeployKey, 'key'>): FakeDeployKey {
    return {
      id: input.id ?? this.nextId(),
      key: input.key,
      label: input.label ?? 'deploy key',
      ...(input.comment ? { comment: input.comment } : {}),
      addedOn: input.addedOn ?? FIXED_TIME,
      lastUsed: input.lastUsed ?? null,
    };
  }

  addDeployKey(workspace: string, slug: string, input: Patch<FakeDeployKey, 'key'>): FakeDeployKey {
    const k = this.makeDeployKey(input);
    this.repo(workspace, slug).deployKeys.push(k);
    return k;
  }

  addProjectDeployKey(
    workspace: string,
    projectKey: string,
    input: Patch<FakeDeployKey, 'key'>,
  ): FakeDeployKey {
    const project = this.ws(workspace).projects.find((p) => p.key === projectKey);
    if (!project) throw new Error(`fake bitbucket: unknown project ${projectKey}`);
    const k = this.makeDeployKey(input);
    project.deployKeys.push(k);
    return k;
  }

  makeVariable(input: Patch<FakeVariable, 'key'>): FakeVariable {
    return {
      uuid: input.uuid ?? uuid(this.nextId()),
      key: input.key,
      value: input.value ?? '',
      secured: input.secured ?? false,
    };
  }

  addVariable(workspace: string, slug: string, input: Patch<FakeVariable, 'key'>): FakeVariable {
    const v = this.makeVariable(input);
    this.repo(workspace, slug).variables.push(v);
    return v;
  }

  addEnvironment(
    workspace: string,
    slug: string,
    input: Patch<FakeEnvironment, 'name'>,
  ): FakeEnvironment {
    const repo = this.repo(workspace, slug);
    const env: FakeEnvironment = {
      uuid: input.uuid ?? uuid(this.nextId()),
      name: input.name,
      slug: input.slug ?? input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      rank: input.rank ?? repo.environments.length,
      environmentType: input.environmentType ?? 'Test',
      variables: input.variables ?? [],
    };
    repo.environments.push(env);
    return env;
  }

  addEnvironmentVariable(
    workspace: string,
    slug: string,
    envName: string,
    input: Patch<FakeVariable, 'key'>,
  ): FakeVariable {
    const env = this.repo(workspace, slug).environments.find((e) => e.name === envName);
    if (!env) throw new Error(`fake bitbucket: unknown environment ${envName}`);
    const v = this.makeVariable(input);
    env.variables.push(v);
    return v;
  }

  makeWebhook(input: Patch<FakeWebhook, 'url'>): FakeWebhook {
    return {
      uuid: input.uuid ?? uuid(this.nextId()),
      url: input.url,
      description: input.description ?? '',
      active: input.active ?? true,
      events: input.events ?? ['repo:push'],
      secretSet: input.secretSet ?? false,
      createdAt: input.createdAt ?? FIXED_TIME,
    };
  }

  addWebhook(workspace: string, slug: string, input: Patch<FakeWebhook, 'url'>): FakeWebhook {
    const hook = this.makeWebhook(input);
    this.repo(workspace, slug).webhooks.push(hook);
    return hook;
  }

  addPullRequest(
    workspace: string,
    slug: string,
    input: Patch<FakePullRequest, 'title' | 'authorAccountId'>,
  ): FakePullRequest {
    const repo = this.repo(workspace, slug);
    const pr: FakePullRequest = {
      id: input.id ?? repo.pullRequests.length + 1,
      title: input.title,
      state: input.state ?? 'OPEN',
      authorAccountId: input.authorAccountId,
      sourceBranch: input.sourceBranch ?? 'feature/x',
      destinationBranch: input.destinationBranch ?? repo.mainbranch ?? 'main',
      createdOn: input.createdOn ?? FIXED_TIME,
      updatedOn: input.updatedOn ?? FIXED_TIME,
    };
    repo.pullRequests.push(pr);
    return pr;
  }

  grantRepositoryUser(
    workspace: string,
    slug: string,
    accountId: string,
    permission: 'read' | 'write' | 'admin' | 'none',
  ): void {
    this.repo(workspace, slug).userPermissions.push({ accountId, permission });
  }

  grantRepositoryGroup(
    workspace: string,
    slug: string,
    groupSlug: string,
    permission: 'read' | 'write' | 'admin' | 'none',
  ): void {
    this.repo(workspace, slug).groupPermissions.push({ slug: groupSlug, permission });
  }

  grantProjectUser(
    workspace: string,
    projectKey: string,
    accountId: string,
    permission: 'read' | 'write' | 'create-repo' | 'admin' | 'none',
  ): void {
    this.project(workspace, projectKey).userPermissions.push({ accountId, permission });
  }

  grantProjectGroup(
    workspace: string,
    projectKey: string,
    groupSlug: string,
    permission: 'read' | 'write' | 'create-repo' | 'admin' | 'none',
  ): void {
    this.project(workspace, projectKey).groupPermissions.push({ slug: groupSlug, permission });
  }

  project(workspace: string, key: string): FakeProject {
    const p = this.ws(workspace).projects.find((x) => x.key === key);
    if (!p) throw new Error(`fake bitbucket: unknown project ${key}`);
    return p;
  }

  /** JSON snapshot for `GET /__state`. API tokens are redacted. */
  snapshot(): unknown {
    const copy = structuredClone(this.data);
    return {
      ...copy,
      credentials: copy.credentials.map((c) => ({
        email: c.email,
        accountId: c.accountId,
        token: '<redacted>',
        ...(c.scopes ? { scopes: c.scopes } : {}),
      })),
    };
  }
}
