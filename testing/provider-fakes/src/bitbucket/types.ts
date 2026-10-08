/**
 * Plain-data state model of the fake Bitbucket Cloud. Everything is JSON-serializable so that
 * `GET /__state` can dump it and fixture builders (T-043) can construct any shape.
 */

export type RepoPermission = 'read' | 'write' | 'admin' | 'none';
export type ProjectPermission = 'read' | 'write' | 'create-repo' | 'admin' | 'none';

export const BRANCH_RESTRICTION_KINDS = [
  'push',
  'delete',
  'force',
  'restrict_merges',
  'require_tasks_to_be_completed',
  'require_approvals_to_merge',
  'require_review_group_approvals_to_merge',
  'require_default_reviewer_approvals_to_merge',
  'require_no_changes_requested',
  'require_passing_builds_to_merge',
  'require_commits_behind',
  'reset_pullrequest_approvals_on_change',
  'smart_reset_pullrequest_approvals',
  'reset_pullrequest_changes_requested_on_change',
  'require_all_dependencies_merged',
  'enforce_merge_checks',
  'allow_auto_merge_when_builds_pass',
  'require_all_comments_resolved',
] as const;
export type BranchRestrictionKind = (typeof BRANCH_RESTRICTION_KINDS)[number];

export const MERGE_STRATEGIES = [
  'merge_commit',
  'squash',
  'fast_forward',
  'squash_fast_forward',
  'rebase_fast_forward',
  'rebase_merge',
] as const;
export type MergeStrategy = (typeof MERGE_STRATEGIES)[number];

export interface FakeUser {
  accountId: string;
  uuid: string;
  nickname: string;
  displayName: string;
  /** Not exposed by any endpoint (the real API has no email field); kept for fixture matching. */
  email?: string;
}

export interface FakeGroup {
  slug: string;
  name: string;
  /** `accountId`s of the members. Only readable through the `/1.0/groups` endpoint. */
  members: string[];
  /** Workspace-wide default permission shown by `/1.0/groups`. */
  defaultPermission: 'read' | 'write' | 'admin' | 'none';
  autoAdd: boolean;
}

export interface FakeBranch {
  name: string;
  /** Commit hash. When a git root is wired in (T-040) the seam can overwrite it. */
  hash: string;
  mergeStrategies: MergeStrategy[];
  defaultMergeStrategy: MergeStrategy;
}

export interface FakeBranchRestriction {
  id: number;
  kind: BranchRestrictionKind;
  pattern: string;
  branchMatchKind: 'glob' | 'branching_model';
  branchType?: 'feature' | 'bugfix' | 'release' | 'hotfix' | 'development' | 'production';
  value?: number | null;
  users: string[];
  groups: string[];
}

export interface FakeDeployKey {
  id: number;
  key: string;
  label: string;
  comment?: string;
  addedOn: string;
  lastUsed?: string | null;
}

export interface FakeVariable {
  uuid: string;
  key: string;
  /** Omitted from API responses when `secured`. */
  value: string;
  secured: boolean;
}

export interface FakeEnvironment {
  uuid: string;
  name: string;
  slug: string;
  rank: number;
  environmentType: 'Test' | 'Staging' | 'Production';
  variables: FakeVariable[];
}

export interface FakeWebhook {
  uuid: string;
  url: string;
  description: string;
  active: boolean;
  events: string[];
  secretSet: boolean;
  createdAt: string;
}

export interface FakePullRequest {
  id: number;
  title: string;
  state: 'OPEN' | 'MERGED' | 'DECLINED' | 'SUPERSEDED';
  authorAccountId: string;
  sourceBranch: string;
  destinationBranch: string;
  createdOn: string;
  updatedOn: string;
}

export interface FakeBranchingModel {
  developmentUseMainbranch: boolean;
  developmentName: string | null;
  production: { enabled: boolean; useMainbranch: boolean; name: string | null };
  branchTypes: {
    kind: 'feature' | 'bugfix' | 'release' | 'hotfix';
    prefix: string;
    enabled: boolean;
  }[];
  /** Served as a STRING ("true"/"false") like the real API. Not schema-validated (provider doc). */
  defaultBranchDeletion: 'true' | 'false' | boolean;
}

export interface FakeDefaultReviewer {
  accountId: string;
  reviewerType: 'repository' | 'project';
}

export interface FakeRepository {
  uuid: string;
  slug: string;
  name: string;
  projectKey: string;
  description: string;
  isPrivate: boolean;
  forkPolicy: 'allow_forks' | 'no_public_forks' | 'no_forks';
  hasIssues: boolean;
  hasWiki: boolean;
  language: string;
  size: number;
  /** Name of the main branch, `null` for an empty repository. */
  mainbranch: string | null;
  createdOn: string;
  updatedOn: string;
  /**
   * Seam to the git server (T-040): absolute or relative path of the bare repository that holds
   * this repository's git data. The REST fake never reads it, it only reports it in `/__state`
   * and in `links.clone`.
   */
  gitRoot: string | null;
  /** In-memory file tree served by `src/{commit}/{path}`: path -> text content. */
  files: Record<string, string>;
  branches: FakeBranch[];
  userPermissions: { accountId: string; permission: RepoPermission }[];
  groupPermissions: { slug: string; permission: RepoPermission }[];
  branchRestrictions: FakeBranchRestriction[];
  deployKeys: FakeDeployKey[];
  webhooks: FakeWebhook[];
  pipelinesEnabled: boolean;
  variables: FakeVariable[];
  environments: FakeEnvironment[];
  pullRequests: FakePullRequest[];
  issueCount: number;
  downloadCount: number;
  branchingModel: FakeBranchingModel;
  defaultReviewers: FakeDefaultReviewer[];
}

export interface FakeProject {
  uuid: string;
  key: string;
  name: string;
  description: string;
  isPrivate: boolean;
  createdOn: string;
  updatedOn: string;
  userPermissions: { accountId: string; permission: ProjectPermission }[];
  groupPermissions: { slug: string; permission: ProjectPermission }[];
  deployKeys: FakeDeployKey[];
  branchingModel: FakeBranchingModel;
}

export interface FakeWorkspace {
  uuid: string;
  slug: string;
  name: string;
  isPrivate: boolean;
  createdOn: string;
  /** `accountId`s of workspace members (the `/members` endpoint). */
  members: string[];
  /** Subset of members that are workspace admins (effective permission `admin` everywhere). */
  admins: string[];
  groups: FakeGroup[];
  projects: FakeProject[];
  repositories: FakeRepository[];
  webhooks: FakeWebhook[];
  variables: FakeVariable[];
}

export interface FakeCredential {
  email: string;
  /** Dummy API token of the fake. Redacted from `/__state`. */
  token: string;
  accountId: string;
  /** Granted API token scopes. Absent = every scope. */
  scopes?: string[];
}

export interface StateData {
  fixture: string;
  seq: number;
  users: FakeUser[];
  credentials: FakeCredential[];
  workspaces: FakeWorkspace[];
}

export type GroupsEndpointMode = 'enabled' | 'not-found' | 'gone';
