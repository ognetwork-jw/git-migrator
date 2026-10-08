import type { GitStore } from './git-store.ts';

export type Level = 'read' | 'write' | 'admin';
export type Permissions = Record<string, Level>;

/** Repository roles in API spelling, weakest first. */
export const ROLES = ['pull', 'triage', 'push', 'maintain', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export interface UserRec {
  id: number;
  nodeId: string;
  login: string;
  name: string | null;
  /** The public profile email only (`GET /users/{login}` shows nothing else). */
  publicEmail: string | null;
  /** Primary email, never exposed by the API; used by fixtures to match source members. */
  email: string | null;
  type: 'User' | 'Bot';
}

export interface AppRec {
  id: number;
  nodeId: string;
  slug: string;
  name: string;
  ownerLogin: string;
  description: string | null;
  permissions: Permissions;
  events: string[];
}

export interface InstallationRec {
  id: number;
  appId: number;
  /** Organization login the App is installed on. */
  account: string;
  permissions: Permissions;
  repositorySelection: 'all' | 'selected';
  /** `owner/name` keys when `repositorySelection` is `selected`. */
  repositories: string[];
  suspended: boolean;
}

export interface TokenRec {
  installationId: number;
  expiresAt: number;
  permissions: Permissions;
  /** Repository ids the token is limited to, or null for the whole installation. */
  repositoryIds: number[] | null;
}

export interface InvitationRec {
  id: number;
  nodeId: string;
  /** Login of an existing user, or null for an email invitation. */
  login: string | null;
  email: string | null;
  role: 'admin' | 'direct_member' | 'billing_manager' | 'reinstate';
  teamIds: number[];
  inviter: string;
  createdAt: number;
  expiresAt: number;
  failedAt: number | null;
  failedReason: string | null;
}

export interface RepoInvitationRec {
  id: number;
  nodeId: string;
  invitee: string;
  inviter: string;
  permission: Role;
  createdAt: number;
  expiresAt: number;
}

export interface TeamRec {
  id: number;
  nodeId: string;
  org: string;
  name: string;
  slug: string;
  description: string | null;
  privacy: 'secret' | 'closed';
  parentId: number | null;
  createdAt: number;
  updatedAt: number;
  /** login -> role; `pending` members are invited to the org by the team add. */
  members: Map<string, { role: 'member' | 'maintainer'; state: 'active' | 'pending' }>;
  /** `owner/name` -> role. */
  repos: Map<string, Role>;
}

export interface OrgRec {
  id: number;
  nodeId: string;
  login: string;
  description: string | null;
  createdAt: number;
  plan: { name: string; seats: number | null; space: number; privateRepos: number };
  /** Repositories the members may create, organization policy (provider doc, repository creation). */
  membersCanCreatePrivateRepositories: boolean;
  membersCanDeleteRepositories: boolean;
  /** Whether `GET /orgs/{org}` shows the settings fields to the caller (owners only on GitHub). */
  exposeSettings: boolean;
  baseRole: 'none' | Role;
  customRoles: Record<string, Role>;
  members: Map<string, 'admin' | 'member'>;
  invitations: InvitationRec[];
  /** Creation times of every invitation sent, for the 24 h limit (cancelled ones still count). */
  invitationLog: number[];
  teams: TeamRec[];
  secrets: SecretRec[];
  variables: VariableRec[];
  hooks: HookRec[];
}

export interface SecretRec {
  name: string;
  createdAt: number;
  updatedAt: number;
  visibility: 'all' | 'private' | 'selected';
  selectedRepositoryIds: number[];
}

export interface VariableRec extends SecretRec {
  value: string;
}

export interface HookRec {
  id: number;
  name: 'web';
  active: boolean;
  events: string[];
  config: { url?: string; content_type?: string; secret?: string; insecure_ssl?: string };
  createdAt: number;
  updatedAt: number;
}

export interface DeployKeyRec {
  id: number;
  key: string;
  title: string;
  readOnly: boolean;
  verified: boolean;
  createdAt: number;
}

export interface BranchPolicyRec {
  id: number;
  nodeId: string;
  name: string;
  type: 'branch' | 'tag';
}

export interface EnvironmentRec {
  id: number;
  nodeId: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  waitTimer: number;
  reviewers: { type: 'User' | 'Team'; id: number }[];
  preventSelfReview: boolean;
  deploymentBranchPolicy: { protectedBranches: boolean; customBranchPolicies: boolean } | null;
  branchPolicies: BranchPolicyRec[];
  secrets: SecretRec[];
  variables: VariableRec[];
  nextPolicyId: number;
}

export interface BranchRule {
  id: number;
  nodeId: string;
  pattern: string;
  allowsDeletions: boolean;
  /** Stored independently from the bypass list (ADR-0040). */
  allowsForcePushes: boolean;
  bypassForcePushActorIds: string[];
  /** Separate from `restrictsPushes` (ADR-0041). */
  blocksCreations: boolean;
  bypassPullRequestActorIds: string[];
  dismissesStaleReviews: boolean;
  isAdminEnforced: boolean;
  lockAllowsFetchAndMerge: boolean;
  lockBranch: boolean;
  pushActorIds: string[];
  requireLastPushApproval: boolean;
  requiredApprovingReviewCount: number | null;
  requiredDeploymentEnvironments: string[];
  requiredStatusChecks: { context: string; appId: string | null }[];
  requiresApprovingReviews: boolean;
  requiresCodeOwnerReviews: boolean;
  requiresCommitSignatures: boolean;
  requiresConversationResolution: boolean;
  requiresDeployments: boolean;
  requiresLinearHistory: boolean;
  requiresStatusChecks: boolean;
  requiresStrictStatusChecks: boolean;
  restrictsPushes: boolean;
  restrictsReviewDismissals: boolean;
  reviewDismissalActorIds: string[];
}

export interface PullRec {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  draft: boolean;
  user: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
  merged: boolean;
}

export interface RepoRec {
  id: number;
  nodeId: string;
  owner: string;
  name: string;
  description: string | null;
  homepage: string | null;
  private: boolean;
  visibility: 'private' | 'public' | 'internal';
  defaultBranch: string;
  archived: boolean;
  hasIssues: boolean;
  hasProjects: boolean;
  hasWiki: boolean;
  createdAt: number;
  updatedAt: number;
  pushedAt: number | null;
  git: GitStore;
  /**
   * Seam to the git server (T-040): path of the bare repository below its root, or undefined. The
   * REST fake never reads it. `links.clone` style URLs are derived from `GitHubState.gitBaseUrl`.
   */
  gitRoot?: string;
  /** Direct collaborators, including outside collaborators. */
  collaborators: Map<string, Role | string>;
  repoInvitations: RepoInvitationRec[];
  keys: DeployKeyRec[];
  environments: EnvironmentRec[];
  secrets: SecretRec[];
  variables: VariableRec[];
  hooks: HookRec[];
  rules: BranchRule[];
  pulls: PullRec[];
  /** LFS objects the repository has (`oid` -> size), for the batch API. */
  lfs: Map<string, number>;
  nextPull: number;
}

export type Clock = () => number;
