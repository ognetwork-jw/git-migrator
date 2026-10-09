import { randomBytes } from 'node:crypto';
import {
  type AppSeed,
  DEFAULT_APP_PERMISSIONS,
  DEFAULT_RUNTIME_CONFIG,
  type FakeGitHubOptions,
  type InstallationSeed,
  type RuntimeConfig,
} from './config.ts';
import { GitStore } from './git-store.ts';
import {
  type AppRec,
  type BranchRule,
  type DeployKeyRec,
  type EnvironmentRec,
  type HookRec,
  type InstallationRec,
  type InvitationRec,
  type Level,
  type OrgRec,
  type Permissions,
  type PullRec,
  type RepoRec,
  ROLES,
  type Role,
  type SecretRec,
  type TeamRec,
  type TokenRec,
  type UserRec,
  type VariableRec,
} from './types.ts';
import { b64, invalidField, notFound, slugify, validationFailed } from './util.ts';

const DAY = 24 * 3600 * 1000;
/** Invitations expire after 7 days (provider doc, Org invitations). */
export const INVITATION_TTL_MS = 7 * DAY;
/** Installation tokens expire after 1 hour (provider doc, Authentication). */
export const TOKEN_TTL_MS = 3600 * 1000;

export const nodeId = (type: string, id: number): string => b64(`0${type.length}:${type}${id}`);
const NODE_RE = /^0?\d+:([A-Za-z]+?)(\d+)$/;

export const roleRank = (role: string | null | undefined): number =>
  role ? ROLES.indexOf(role as Role) : -1;

export type SecretLike = SecretRec | VariableRec;

/** `GITHUB_` prefix, leading digits and non `[A-Za-z0-9_]` characters are invalid (FAC-VAR-003). */
export function validSecretName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !/^github_/i.test(name);
}

export class GitHubState {
  readonly options: FakeGitHubOptions;
  readonly clock: () => number;
  config: RuntimeConfig = structuredClone(DEFAULT_RUNTIME_CONFIG);
  fixture = 'empty';
  /** Bumped by every reset; requests that started before one fail with 409 instead of writing into the new world. */
  generation = 0;

  users = new Map<string, UserRec>();
  orgs = new Map<string, OrgRec>();
  apps = new Map<number, AppRec>();
  installations = new Map<number, InstallationRec>();
  repos = new Map<string, RepoRec>();
  /** Former names of renamed repositories, to the repository: GitHub redirects them (301 on a read, 307 otherwise). */
  renamedRepos = new Map<string, RepoRec>();
  tokens = new Map<string, TokenRec>();
  /** Every deploy key (public key text) in use, to its repository: keys are unique on GitHub. */
  private ids = new Map<string, number>();
  readonly ownApp: AppRec;
  readonly appClientId: string;
  readonly gitBaseUrl: string;

  constructor(options: FakeGitHubOptions = {}) {
    this.options = options;
    this.clock = options.clock ?? Date.now;
    this.gitBaseUrl = options.gitBaseUrl ?? 'http://localhost:4030/target';
    this.config = mergeConfig(DEFAULT_RUNTIME_CONFIG, options.config);
    this.ownApp = this.seed(options.app ?? {}, options.installations ?? [{ account: 'acme' }]);
    this.appClientId = options.app?.clientId ?? 'Iv1.fakeclientid0000';
  }

  /** Drops everything and seeds the App and its installations again. Ids restart, so worlds are identical. */
  reset(overrides: Partial<RuntimeConfig> = {}): void {
    this.generation += 1;
    this.users.clear();
    this.orgs.clear();
    this.apps.clear();
    this.installations.clear();
    this.repos.clear();
    this.tokens.clear();
    this.ids.clear();
    this.fixture = 'empty';
    this.config = mergeConfig(DEFAULT_RUNTIME_CONFIG, { ...this.options.config, ...overrides });
    (this as { ownApp: AppRec }).ownApp = this.seed(
      this.options.app ?? {},
      this.options.installations ?? [{ account: 'acme' }],
    );
  }

  private seed(app: AppSeed, installations: InstallationSeed[]): AppRec {
    const rec = this.addApp({
      id: app.id ?? 12345,
      slug: app.slug ?? 'git-migrator-fake',
      name: app.name ?? 'git-migrator (fake)',
      ownerLogin: installations[0]?.account ?? 'acme',
      permissions: app.permissions ?? DEFAULT_APP_PERMISSIONS,
    });
    for (const inst of installations) this.addInstallation(inst, rec);
    return rec;
  }

  nextId(kind: string, base = 1000): number {
    const next = (this.ids.get(kind) ?? base) + 1;
    this.ids.set(kind, next);
    return next;
  }

  // -- builders: accounts ---------------------------------------------------------------------

  addUser(input: {
    login: string;
    name?: string | null;
    email?: string | null;
    publicEmail?: string | null;
  }): UserRec {
    if (this.users.has(input.login.toLowerCase()))
      throw new Error(`user ${input.login} already exists`);
    const id = this.nextId('user', 10000);
    const rec: UserRec = {
      id,
      nodeId: nodeId('User', id),
      login: input.login,
      name: input.name ?? null,
      email: input.email ?? null,
      publicEmail: input.publicEmail ?? null,
      type: 'User',
    };
    this.users.set(input.login.toLowerCase(), rec);
    return rec;
  }

  addApp(input: {
    id?: number;
    slug: string;
    name?: string;
    ownerLogin?: string;
    permissions?: Permissions;
    description?: string | null;
  }): AppRec {
    const id = input.id ?? this.nextId('app', 50000);
    const rec: AppRec = {
      id,
      nodeId: nodeId('App', id),
      slug: input.slug,
      name: input.name ?? input.slug,
      ownerLogin: input.ownerLogin ?? 'acme',
      description: input.description ?? null,
      permissions: input.permissions ?? { metadata: 'read' },
      events: [],
    };
    this.apps.set(id, rec);
    return rec;
  }

  addOrg(input: {
    login: string;
    description?: string | null;
    plan?: Partial<OrgRec['plan']>;
    createdAt?: number;
    membersCanCreatePrivateRepositories?: boolean;
    membersCanDeleteRepositories?: boolean;
    exposeSettings?: boolean;
    baseRole?: OrgRec['baseRole'];
    customRoles?: Record<string, Role>;
  }): OrgRec {
    const key = input.login.toLowerCase();
    const existing = this.orgs.get(key);
    if (existing) return existing;
    const id = this.nextId('org', 20000);
    const rec: OrgRec = {
      id,
      nodeId: nodeId('Organization', id),
      login: input.login,
      description: input.description ?? null,
      createdAt: input.createdAt ?? this.clock(),
      plan: { name: 'team', seats: null, space: 976562499, privateRepos: 999999, ...input.plan },
      membersCanCreatePrivateRepositories: input.membersCanCreatePrivateRepositories ?? true,
      membersCanDeleteRepositories: input.membersCanDeleteRepositories ?? true,
      membersCanForkPrivateRepositories: true,
      exposeSettings: input.exposeSettings ?? true,
      baseRole: input.baseRole ?? 'none',
      customRoles: input.customRoles ?? {},
      members: new Map(),
      invitations: [],
      expiredInvitations: [],
      invitationLog: [],
      teams: [],
      secrets: [],
      variables: [],
      hooks: [],
    };
    this.orgs.set(key, rec);
    return rec;
  }

  addInstallation(input: InstallationSeed, app: AppRec = this.ownApp): InstallationRec {
    this.addOrg({ login: input.account });
    const id = input.id ?? this.nextId('installation', 77000);
    const rec: InstallationRec = {
      id,
      appId: app.id,
      account: input.account,
      permissions: input.permissions ?? app.permissions,
      repositorySelection: input.repositorySelection ?? 'all',
      repositories: input.repositories ?? [],
      suspended: false,
    };
    this.installations.set(id, rec);
    return rec;
  }

  /** Adds `login` to the organization; creates the user when unknown. */
  addMember(orgLogin: string, login: string, role: 'admin' | 'member' = 'member'): UserRec {
    const org = this.requireOrg(orgLogin);
    const user = this.users.get(login.toLowerCase()) ?? this.addUser({ login });
    org.members.set(user.login, role);
    return user;
  }

  requireOrg(login: string): OrgRec {
    const org = this.orgs.get(login.toLowerCase());
    if (!org) throw notFound();
    return org;
  }

  findUser(login: string): UserRec | undefined {
    return this.users.get(login.toLowerCase());
  }

  /** Org membership status of a login, used for outside collaborator logic. */
  isMember(org: OrgRec, login: string): boolean {
    return [...org.members.keys()].some((m) => m.toLowerCase() === login.toLowerCase());
  }

  memberRole(org: OrgRec, login: string): 'admin' | 'member' | undefined {
    for (const [m, role] of org.members) if (m.toLowerCase() === login.toLowerCase()) return role;
    return undefined;
  }

  // -- teams -------------------------------------------------------------------------------------

  addTeam(
    orgLogin: string,
    input: {
      name: string;
      description?: string | null;
      privacy?: 'secret' | 'closed';
      parentId?: number | null;
      members?: string[];
      maintainers?: string[];
    },
  ): TeamRec {
    const org = this.requireOrg(orgLogin);
    const slug = slugify(input.name);
    if (!slug || org.teams.some((t) => t.slug === slug))
      throw validationFailed({
        resource: 'Team',
        code: 'already_exists',
        field: 'name',
      });
    if (input.parentId != null && !org.teams.some((t) => t.id === input.parentId))
      throw invalidField('Team', 'parent_team_id');
    const id = this.nextId('team', 40000);
    const now = this.clock();
    const team: TeamRec = {
      id,
      nodeId: nodeId('Team', id),
      org: org.login,
      name: input.name,
      slug,
      description: input.description ?? null,
      privacy: input.privacy ?? 'secret',
      parentId: input.parentId ?? null,
      createdAt: now,
      updatedAt: now,
      members: new Map(),
      repos: new Map(),
    };
    org.teams.push(team);
    for (const m of input.members ?? []) this.setTeamMembership(org, team, m, 'member');
    for (const m of input.maintainers ?? []) this.setTeamMembership(org, team, m, 'maintainer');
    return team;
  }

  requireTeam(org: OrgRec, slug: string): TeamRec {
    const team = org.teams.find((t) => t.slug === slug);
    if (!team) throw notFound();
    return team;
  }

  /** An org member becomes `active`; anyone else gets a `pending` team invitation. */
  setTeamMembership(
    org: OrgRec,
    team: TeamRec,
    login: string,
    role: 'member' | 'maintainer',
  ): { role: 'member' | 'maintainer'; state: 'active' | 'pending' } {
    const user = this.findUser(login);
    if (!user) throw notFound();
    const state = this.isMember(org, user.login) ? 'active' : 'pending';
    const rec = { role, state } as const;
    team.members.set(user.login, rec);
    team.updatedAt = this.clock();
    if (state === 'pending')
      this.invite(org, { login: user.login }, 'direct_member', [team.id], undefined, true);
    return rec;
  }

  // -- organization invitations ------------------------------------------------------------------

  /** 500 per 24 h for paid plans or organizations older than a month, else 50 (provider doc). */
  invitationLimit(org: OrgRec): number {
    const old = this.clock() - org.createdAt > 30 * DAY;
    const paid = org.plan.name !== 'free';
    return old || paid ? 500 : 50;
  }

  purgeExpired(org: OrgRec): void {
    const now = this.clock();
    for (const lapsed of org.invitations.filter((i) => i.expiresAt <= now)) {
      org.expiredInvitations.push({
        ...lapsed,
        failedAt: lapsed.expiresAt,
        failedReason: lapsed.failedReason ?? 'Invitation expired',
      });
    }
    org.invitations = org.invitations.filter((i) => i.expiresAt > now);
    for (const repo of this.repos.values()) {
      if (repo.owner.toLowerCase() !== org.login.toLowerCase()) continue;
      repo.repoInvitations = repo.repoInvitations.filter((i) => i.expiresAt > now);
    }
  }

  invite(
    org: OrgRec,
    target: { login?: string; email?: string },
    role: InvitationRec['role'] = 'direct_member',
    teamIds: number[] = [],
    inviter = this.ownApp.slug,
    mergeTeams = false,
  ): InvitationRec {
    this.purgeExpired(org);
    const field = target.login ? 'invitee_id' : 'email';
    if (target.login && this.isMember(org, target.login))
      throw validationFailed({
        resource: 'OrganizationInvitation',
        code: 'custom',
        field,
        message: 'invitee is already a part of this organization',
      });
    const emailMember =
      target.email &&
      [...this.users.values()].some(
        (u) =>
          u.email?.toLowerCase() === target.email?.toLowerCase() && this.isMember(org, u.login),
      );
    if (emailMember)
      throw validationFailed({
        resource: 'OrganizationInvitation',
        code: 'custom',
        field,
        message: 'invitee is already a part of this organization',
      });
    const existing = org.invitations.find(
      (i) =>
        (target.login && i.login?.toLowerCase() === target.login.toLowerCase()) ||
        (target.email && i.email?.toLowerCase() === target.email.toLowerCase()),
    );
    if (existing) {
      if (!mergeTeams)
        throw validationFailed({
          resource: 'OrganizationInvitation',
          code: 'already_exists',
          field,
        });
      existing.teamIds = [...new Set([...existing.teamIds, ...teamIds])];
      return existing;
    }
    const now = this.clock();
    // Sent invitations count for 24 hours even when cancelled or accepted.
    org.invitationLog = org.invitationLog.filter((t) => now - t < DAY);
    const recent = org.invitationLog.length;
    if (recent >= this.invitationLimit(org))
      throw validationFailed({
        resource: 'OrganizationInvitation',
        code: 'custom',
        field,
        message: `exceeded the invitation limit of ${this.invitationLimit(org)} per 24 hours`,
      });
    if (org.plan.seats != null && org.members.size + org.invitations.length >= org.plan.seats)
      throw validationFailed({
        resource: 'OrganizationInvitation',
        code: 'custom',
        field,
        message: 'no available seats; add a license before inviting',
      });
    const id = this.nextId('invitation', 60000);
    const rec: InvitationRec = {
      id,
      nodeId: nodeId('OrganizationInvitation', id),
      login: target.login ?? null,
      email: target.email ?? null,
      role,
      teamIds,
      inviter,
      createdAt: now,
      expiresAt: now + INVITATION_TTL_MS,
      failedAt: null,
      failedReason: null,
    };
    org.invitations.push(rec);
    org.invitationLog.push(now);
    return rec;
  }

  /** Test helper: the invitee accepts. They become a member and pending team memberships turn active. */
  acceptInvitation(orgLogin: string, invitationId: number): void {
    const org = this.requireOrg(orgLogin);
    this.purgeExpired(org);
    const inv = org.invitations.find((i) => i.id === invitationId);
    if (!inv) throw notFound();
    const login = inv.login ?? this.addUser({ login: `invitee-${inv.id}`, email: inv.email }).login;
    org.members.set(login, inv.role === 'admin' ? 'admin' : 'member');
    org.invitations = org.invitations.filter((i) => i.id !== invitationId);
    for (const team of org.teams)
      if (team.members.has(login))
        team.members.set(login, {
          role: team.members.get(login)?.role ?? 'member',
          state: 'active',
        });
  }

  // -- repositories ------------------------------------------------------------------------------

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`.toLowerCase();
  }

  findRepo(owner: string, name: string): RepoRec | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  addRepository(
    owner: string,
    input: {
      name: string;
      description?: string | null;
      private?: boolean;
      visibility?: RepoRec['visibility'];
      defaultBranch?: string;
      archived?: boolean;
      hasIssues?: boolean;
      hasProjects?: boolean;
      hasWiki?: boolean;
      homepage?: string | null;
      /** Files of the initial commit on the default branch. Omit for an empty repository. */
      files?: Record<string, string | Buffer>;
      gitRoot?: string;
    },
  ): RepoRec {
    const org = this.requireOrg(owner);
    if (this.findRepo(org.login, input.name))
      throw validationFailed({
        resource: 'Repository',
        code: 'custom',
        field: 'name',
        message: 'name already exists on this account',
      });
    const id = this.nextId('repo', 30000);
    const now = this.clock();
    const visibility = input.visibility ?? (input.private === false ? 'public' : 'private');
    const repo: RepoRec = {
      id,
      nodeId: nodeId('Repository', id),
      owner: org.login,
      name: input.name,
      description: input.description ?? null,
      homepage: input.homepage ?? null,
      private: visibility !== 'public',
      visibility,
      defaultBranch: input.defaultBranch ?? 'main',
      archived: input.archived ?? false,
      hasIssues: input.hasIssues ?? true,
      hasProjects: input.hasProjects ?? true,
      hasWiki: input.hasWiki ?? true,
      allowForking: true,
      allowMergeCommit: true,
      allowSquashMerge: true,
      allowRebaseMerge: true,
      deleteBranchOnMerge: false,
      createdAt: now,
      updatedAt: now,
      pushedAt: null,
      git: new GitStore(),
      gitRoot: input.gitRoot,
      collaborators: new Map(),
      repoInvitations: [],
      keys: [],
      environments: [],
      secrets: [],
      variables: [],
      hooks: [],
      rules: [],
      pulls: [],
      lfs: new Map(),
      nextPull: 1,
    };
    this.repos.set(this.repoKey(org.login, input.name), repo);
    this.renamedRepos.delete(this.repoKey(org.login, input.name));
    if (input.files) {
      repo.git.commitFiles(`refs/heads/${repo.defaultBranch}`, input.files, 'Initial commit');
      repo.pushedAt = now;
    }
    return repo;
  }

  requireRepo(owner: string, name: string): RepoRec {
    const repo = this.findRepo(owner, name);
    if (!repo) throw notFound();
    return repo;
  }

  /**
   * Transfers a repository to another organization of the fake. GitHub redirects the old name, as
   * after a rename, until a repository is made on it; the old organization's team grants go.
   */
  transferRepository(repo: RepoRec, newOwner: string): void {
    const org = this.requireOrg(newOwner);
    const oldKey = this.repoKey(repo.owner, repo.name);
    const newKey = this.repoKey(org.login, repo.name);
    if (this.repos.has(newKey))
      throw validationFailed({
        resource: 'Repository',
        code: 'custom',
        field: 'name',
        message: 'name already exists on this account',
      });
    this.repos.delete(oldKey);
    for (const o of this.orgs.values()) for (const t of o.teams) t.repos.delete(oldKey);
    repo.owner = org.login;
    this.repos.set(newKey, repo);
    this.renamedRepos.set(oldKey, repo);
    this.renamedRepos.delete(newKey);
  }

  /**
   * Renames an organization. It keeps its id; its repositories' old full names redirect, as after
   * a rename of the repository, and its installations follow it.
   */
  renameOrg(oldLogin: string, newLogin: string): void {
    const org = this.requireOrg(oldLogin);
    this.orgs.delete(oldLogin.toLowerCase());
    org.login = newLogin;
    this.orgs.set(newLogin.toLowerCase(), org);
    for (const [oldKey, repo] of [...this.repos]) {
      if (repo.owner.toLowerCase() !== oldLogin.toLowerCase()) continue;
      const newKey = this.repoKey(newLogin, repo.name);
      this.repos.delete(oldKey);
      repo.owner = newLogin;
      this.repos.set(newKey, repo);
      this.renamedRepos.set(oldKey, repo);
      for (const t of org.teams) {
        const role = t.repos.get(oldKey);
        if (role === undefined) continue;
        t.repos.delete(oldKey);
        t.repos.set(newKey, role);
      }
    }
    const prefix = `${oldLogin.toLowerCase()}/`;
    for (const inst of this.installations.values()) {
      if (inst.account.toLowerCase() !== oldLogin.toLowerCase()) continue;
      inst.account = newLogin;
      inst.repositories = inst.repositories.map((r) =>
        r.toLowerCase().startsWith(prefix) ? `${newLogin}/${r.slice(prefix.length)}` : r,
      );
    }
  }

  deleteRepository(repo: RepoRec): void {
    for (const [key, held] of this.renamedRepos) if (held === repo) this.renamedRepos.delete(key);
    this.repos.delete(this.repoKey(repo.owner, repo.name));
    for (const org of this.orgs.values())
      for (const t of org.teams) t.repos.delete(this.repoKey(repo.owner, repo.name));
  }

  /** Commits `files` as a new commit on `branch` (created from nothing when it is new). */
  addBranch(
    repo: RepoRec,
    branch: string,
    files: Record<string, string | Buffer>,
    options: { from?: string; message?: string } = {},
  ) {
    const ref = `refs/heads/${branch}`;
    const base = options.from ? repo.git.resolve(options.from) : repo.git.refs.get(ref);
    const commit = repo.git.commitFiles(ref, files, options.message ?? `Update ${branch}`, {
      parents: base ? [base] : [],
    });
    repo.pushedAt = this.clock();
    return commit;
  }

  addCollaborator(repo: RepoRec, login: string, permission: Role | string = 'push'): void {
    this.findUser(login) ?? this.addUser({ login });
    repo.collaborators.set(this.findUser(login)?.login as string, permission);
  }

  grantTeam(repo: RepoRec, team: TeamRec, permission: Role | string = 'push'): void {
    team.repos.set(this.repoKey(repo.owner, repo.name), permission as Role);
  }

  addDeployKey(
    repo: RepoRec,
    input: { key: string; title?: string; readOnly?: boolean },
  ): DeployKeyRec {
    const norm = normalizeKey(input.key);
    if (!/^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-nistp\d+|sk-[a-z0-9@.-]+) \S+/.test(norm))
      throw validationFailed({
        resource: 'PublicKey',
        code: 'custom',
        field: 'key',
        message:
          "key is invalid. It must begin with 'ssh-rsa', 'ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'sk-ecdsa-sha2-nistp256@openssh.com', or 'sk-ssh-ed25519@openssh.com'. Check that you're copying the public half of the key",
      });
    for (const r of this.repos.values())
      if (r.keys.some((k) => normalizeKey(k.key) === norm))
        throw validationFailed({
          resource: 'PublicKey',
          code: 'custom',
          field: 'key',
          message: 'key is already in use',
        });
    const rec: DeployKeyRec = {
      id: this.nextId('key', 80000),
      key: input.key.trim(),
      title: input.title ?? '',
      readOnly: input.readOnly ?? true,
      verified: true,
      createdAt: this.clock(),
    };
    repo.keys.push(rec);
    return rec;
  }

  addEnvironment(repo: RepoRec, name: string): EnvironmentRec {
    const existing = repo.environments.find((e) => e.name.toLowerCase() === name.toLowerCase());
    if (existing) return existing;
    const id = this.nextId('environment', 11000);
    const now = this.clock();
    const env: EnvironmentRec = {
      id,
      nodeId: nodeId('Environment', id),
      name,
      createdAt: now,
      updatedAt: now,
      waitTimer: 0,
      reviewers: [],
      preventSelfReview: false,
      deploymentBranchPolicy: null,
      branchPolicies: [],
      secrets: [],
      variables: [],
      nextPolicyId: 0,
    };
    repo.environments.push(env);
    return env;
  }

  /** Upserts a secret or variable name into `list` (stored upper-case, FAC-VAR-003). */
  putNamed<T extends SecretLike>(
    list: T[],
    name: string,
    extra: Partial<T> & { value?: string } = {},
    create: () => T,
  ): { rec: T; created: boolean } {
    if (!validSecretName(name))
      throw validationFailed({
        resource: 'Secret',
        code: 'custom',
        field: 'name',
        message:
          'name may only contain alphanumeric characters or underscores, must not start with GITHUB_ or a number',
      });
    const upper = name.toUpperCase();
    const found = list.find((s) => s.name === upper);
    if (found) {
      Object.assign(found, extra, { updatedAt: this.clock() });
      return { rec: found, created: false };
    }
    const rec = create();
    rec.name = upper;
    Object.assign(rec, extra);
    list.push(rec);
    return { rec, created: true };
  }

  newSecret(): SecretRec {
    const now = this.clock();
    return {
      name: '',
      createdAt: now,
      updatedAt: now,
      visibility: 'all',
      selectedRepositoryIds: [],
    };
  }

  newVariable(value = ''): VariableRec {
    return { ...this.newSecret(), value };
  }

  addSecret(scope: { secrets: SecretRec[] }, name: string): SecretRec {
    return this.putNamed(scope.secrets, name, {}, () => this.newSecret()).rec;
  }

  addVariable(scope: { variables: VariableRec[] }, name: string, value: string): VariableRec {
    return this.putNamed(scope.variables, name, { value }, () => this.newVariable(value)).rec;
  }

  addHook(
    scope: { hooks: HookRec[] },
    input: {
      url: string;
      events?: string[];
      active?: boolean;
      secret?: string;
      contentType?: string;
    },
  ): HookRec {
    const now = this.clock();
    const rec: HookRec = {
      id: this.nextId('hook', 70000),
      name: 'web',
      active: input.active ?? true,
      events: input.events ?? ['push'],
      config: {
        url: input.url,
        content_type: input.contentType ?? 'json',
        insecure_ssl: '0',
        ...(input.secret ? { secret: input.secret } : {}),
      },
      createdAt: now,
      updatedAt: now,
    };
    scope.hooks.push(rec);
    return rec;
  }

  addPull(
    repo: RepoRec,
    input: {
      title: string;
      head: string;
      base?: string;
      body?: string | null;
      user?: string;
      draft?: boolean;
    },
  ): PullRec {
    const base = input.base ?? repo.defaultBranch;
    const headSha = repo.git.resolve(`refs/heads/${input.head}`);
    const baseSha = repo.git.resolve(`refs/heads/${base}`);
    if (!headSha) throw invalidField('PullRequest', 'head');
    if (!baseSha) throw invalidField('PullRequest', 'base');
    if (repo.git.range(baseSha, headSha).length === 0)
      throw validationFailed({
        resource: 'PullRequest',
        code: 'custom',
        message: `No commits between ${base} and ${input.head}`,
      });
    const id = this.nextId('pull', 12000);
    const number = repo.nextPull++;
    const now = this.clock();
    const pull: PullRec = {
      id,
      nodeId: nodeId('PullRequest', id),
      number,
      title: input.title,
      body: input.body ?? null,
      state: 'open',
      draft: input.draft ?? false,
      user: input.user ?? this.ownApp.slug,
      headRef: input.head,
      headSha,
      baseRef: base,
      baseSha,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      merged: false,
    };
    repo.pulls.push(pull);
    // Hidden ref, visible to `git ls-remote` only (provider doc, Quirks).
    repo.git.refs.set(`refs/pull/${number}/head`, headSha);
    return pull;
  }

  addLfsObject(repo: RepoRec, oid: string, size: number): void {
    repo.lfs.set(oid, size);
  }

  // -- permissions -------------------------------------------------------------------------------

  resolveRole(org: OrgRec, role: string): Role | undefined {
    if ((ROLES as readonly string[]).includes(role)) return role as Role;
    const alias: Record<string, Role> = { read: 'pull', write: 'push' };
    return alias[role] ?? org.customRoles[role];
  }

  /** Effective repository role of a user: direct grant, organization base role, or team access. */
  userRole(repo: RepoRec, login: string): Role | null {
    const org = this.orgs.get(repo.owner.toLowerCase());
    if (!org) return null;
    let best = -1;
    const bump = (r: string | undefined | null) => {
      const resolved = r ? this.resolveRole(org, r) : undefined;
      if (resolved) best = Math.max(best, roleRank(resolved));
    };
    if (this.memberRole(org, login) === 'admin') return 'admin';
    for (const [l, r] of repo.collaborators) if (l.toLowerCase() === login.toLowerCase()) bump(r);
    if (this.isMember(org, login) && org.baseRole !== 'none') bump(org.baseRole);
    for (const t of org.teams) {
      const m = [...t.members].find(([l]) => l.toLowerCase() === login.toLowerCase());
      if (m && m[1].state === 'active') bump(t.repos.get(this.repoKey(repo.owner, repo.name)));
    }
    return best < 0 ? null : (ROLES[best] as Role);
  }

  // -- tokens ------------------------------------------------------------------------------------

  issueInstallationToken(
    installationId: number,
    options: { permissions?: Permissions; repositoryIds?: number[] | null; ttlMs?: number } = {},
  ): { token: string; rec: TokenRec } {
    const inst = this.installations.get(installationId);
    if (!inst) throw notFound();
    const token = `ghs_${randomBytes(18).toString('hex')}`;
    const rec: TokenRec = {
      installationId,
      expiresAt: this.clock() + (options.ttlMs ?? TOKEN_TTL_MS),
      // `metadata: read` is mandatory on every installation token.
      permissions: { ...(options.permissions ?? inst.permissions), metadata: 'read' },
      repositoryIds: options.repositoryIds ?? null,
    };
    this.tokens.set(token, rec);
    return { token, rec };
  }

  /** Whether `granted` allows `need` at `level` (write implies read, admin implies write). */
  static allows(granted: Permissions, need: string, level: Level): boolean {
    const have = granted[need];
    if (!have) return false;
    const rank = { read: 0, write: 1, admin: 2 } as const;
    return rank[have] >= rank[level];
  }

  // -- bits used by several modules --------------------------------------------------------------

  findNode(
    id: string,
  ):
    | { type: 'User'; rec: UserRec }
    | { type: 'Organization'; rec: OrgRec }
    | { type: 'Repository'; rec: RepoRec }
    | { type: 'Team'; rec: TeamRec; org: OrgRec }
    | { type: 'App'; rec: AppRec }
    | { type: 'BranchProtectionRule'; rec: BranchRule; repo: RepoRec }
    | undefined {
    let decoded: string;
    try {
      decoded = Buffer.from(id, 'base64').toString('utf8');
    } catch {
      return undefined;
    }
    const m = NODE_RE.exec(decoded);
    if (!m) return undefined;
    const [, type, num] = m;
    const n = Number(num);
    if (type === 'User') {
      const rec = [...this.users.values()].find((u) => u.id === n);
      return rec && { type, rec };
    }
    if (type === 'Organization') {
      const rec = [...this.orgs.values()].find((o) => o.id === n);
      return rec && { type, rec };
    }
    if (type === 'Repository') {
      const rec = [...this.repos.values()].find((r) => r.id === n);
      return rec && { type, rec };
    }
    if (type === 'App') {
      const rec = this.apps.get(n);
      return rec && { type, rec };
    }
    if (type === 'Team') {
      for (const org of this.orgs.values()) {
        const rec = org.teams.find((t) => t.id === n);
        if (rec) return { type, rec, org };
      }
      return undefined;
    }
    if (type === 'BranchProtectionRule') {
      for (const repo of this.repos.values()) {
        const rec = repo.rules.find((r) => r.id === n);
        if (rec) return { type, rec, repo };
      }
    }
    return undefined;
  }

  /** `GET /__state` payload. No tokens, keys, secret values or hook secrets. */
  snapshot(): unknown {
    const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());
    return {
      fixture: this.fixture,
      config: this.config,
      app: { id: this.ownApp.id, slug: this.ownApp.slug },
      installations: [...this.installations.values()],
      tokens: [...this.tokens.values()].map((t) => ({
        installationId: t.installationId,
        expiresAt: iso(t.expiresAt),
        permissions: t.permissions,
        repositoryIds: t.repositoryIds,
      })),
      users: [...this.users.values()],
      orgs: [...this.orgs.values()].map((o) => ({
        id: o.id,
        login: o.login,
        plan: o.plan,
        membersCanCreatePrivateRepositories: o.membersCanCreatePrivateRepositories,
        membersCanDeleteRepositories: o.membersCanDeleteRepositories,
        baseRole: o.baseRole,
        members: Object.fromEntries(o.members),
        invitations: o.invitations.map((i) => ({
          ...i,
          createdAt: iso(i.createdAt),
          expiresAt: iso(i.expiresAt),
        })),
        teams: o.teams.map((t) => ({
          id: t.id,
          slug: t.slug,
          name: t.name,
          privacy: t.privacy,
          parentId: t.parentId,
          members: Object.fromEntries(t.members),
          repos: Object.fromEntries(t.repos),
        })),
        secrets: o.secrets.map((s) => s.name),
        variables: o.variables.map((v) => ({ name: v.name, value: v.value })),
        hooks: o.hooks.map(hookSummary),
      })),
      repositories: [...this.repos.values()].map((r) => ({
        id: r.id,
        fullName: `${r.owner}/${r.name}`,
        private: r.private,
        defaultBranch: r.defaultBranch,
        archived: r.archived,
        empty: r.git.isEmpty,
        gitRoot: r.gitRoot ?? null,
        cloneUrl: `${this.gitBaseUrl}/${r.owner}/${r.name}.git`,
        refs: Object.fromEntries(r.git.refs),
        collaborators: Object.fromEntries(r.collaborators),
        repoInvitations: r.repoInvitations.map((i) => ({
          ...i,
          createdAt: iso(i.createdAt),
          expiresAt: iso(i.expiresAt),
        })),
        deployKeys: r.keys.map((k) => ({ id: k.id, title: k.title, readOnly: k.readOnly })),
        environments: r.environments.map((e) => ({
          name: e.name,
          waitTimer: e.waitTimer,
          reviewers: e.reviewers,
          deploymentBranchPolicy: e.deploymentBranchPolicy,
          branchPolicies: e.branchPolicies,
          secrets: e.secrets.map((s) => s.name),
          variables: e.variables.map((v) => ({ name: v.name, value: v.value })),
        })),
        secrets: r.secrets.map((s) => s.name),
        variables: r.variables.map((v) => ({ name: v.name, value: v.value })),
        hooks: r.hooks.map(hookSummary),
        branchProtectionRules: r.rules,
        pulls: r.pulls,
        lfs: Object.fromEntries(r.lfs),
      })),
    };
  }
}

function hookSummary(h: HookRec) {
  return {
    id: h.id,
    active: h.active,
    events: h.events,
    config: { ...h.config, secret: h.config.secret ? '********' : undefined },
  };
}

export const normalizeKey = (key: string): string => key.trim().split(/\s+/).slice(0, 2).join(' ');

function mergeConfig(base: RuntimeConfig, over?: Partial<RuntimeConfig>): RuntimeConfig {
  return { ...structuredClone(base), ...structuredClone(over ?? {}) };
}
