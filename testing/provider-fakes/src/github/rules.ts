import { type GitHubState, nodeId, roleRank } from './state.ts';
import type { BranchRule, RepoRec } from './types.ts';
import { fnmatch, RuleError } from './util.ts';

/**
 * Branch protection rules, the GraphQL model (FAC-BRR-002). `allowsForcePushes` and the bypass list
 * are stored independently (ADR-0040) and `blocksCreations` is its own flag (ADR-0041).
 */
export type RuleInput = Partial<
  Omit<BranchRule, 'id' | 'nodeId' | 'requiredStatusChecks'> & {
    requiredStatusChecks: { context: string; appId?: string | null }[];
    requiredStatusCheckContexts: string[];
  }
>;

export function defaultRule(id: number, pattern: string): BranchRule {
  return {
    id,
    nodeId: nodeId('BranchProtectionRule', id),
    pattern,
    allowsDeletions: false,
    allowsForcePushes: false,
    bypassForcePushActorIds: [],
    blocksCreations: false,
    bypassPullRequestActorIds: [],
    dismissesStaleReviews: false,
    isAdminEnforced: false,
    lockAllowsFetchAndMerge: false,
    lockBranch: false,
    pushActorIds: [],
    requireLastPushApproval: false,
    requiredApprovingReviewCount: null,
    requiredDeploymentEnvironments: [],
    requiredStatusChecks: [],
    requiresApprovingReviews: false,
    requiresCodeOwnerReviews: false,
    requiresCommitSignatures: false,
    requiresConversationResolution: false,
    requiresDeployments: false,
    requiresLinearHistory: false,
    requiresStatusChecks: false,
    requiresStrictStatusChecks: false,
    restrictsPushes: false,
    restrictsReviewDismissals: false,
    reviewDismissalActorIds: [],
  };
}

/** Rejects unknown actors and users, teams or Apps without write access (provider doc, actor IDs). */
export function validateActors(state: GitHubState, repo: RepoRec, ids: string[]): void {
  for (const id of ids) {
    const node = state.findNode(id);
    if (!node || !['User', 'Team', 'App'].includes(node.type))
      throw new RuleError(`Could not resolve to a node with the global id of '${id}'.`);
    if (node.type === 'User') {
      const role = state.userRole(repo, node.rec.login);
      if (roleRank(role) < roleRank('push'))
        throw new RuleError(
          `${node.rec.login} must have write access to ${repo.owner}/${repo.name}.`,
        );
    } else if (node.type === 'Team') {
      const access = node.rec.repos.get(state.repoKey(repo.owner, repo.name));
      if (!access || roleRank(access) < roleRank('push'))
        throw new RuleError(
          `Team ${node.rec.slug} must have write access to ${repo.owner}/${repo.name}.`,
        );
    } else if (node.type === 'App') {
      const app = node.rec;
      if (![...state.installations.values()].some((i) => i.appId === app.id))
        throw new RuleError(`App ${app.slug} is not installed on ${repo.owner}/${repo.name}.`);
    }
  }
}

export function applyRuleInput(
  state: GitHubState,
  repo: RepoRec,
  rule: BranchRule,
  input: RuleInput,
): void {
  const { requiredStatusChecks, requiredStatusCheckContexts, ...plain } = input;
  if (plain.pattern !== undefined) {
    const clash = repo.rules.find((r) => r.pattern === plain.pattern && r.id !== rule.id);
    if (clash) throw new RuleError(`Name already protected: ${plain.pattern}`);
  }
  for (const key of [
    'pushActorIds',
    'bypassForcePushActorIds',
    'bypassPullRequestActorIds',
    'reviewDismissalActorIds',
  ] as const) {
    if (plain[key]) validateActors(state, repo, plain[key] as string[]);
  }
  for (const [k, v] of Object.entries(plain))
    if (v !== undefined) (rule as never as Record<string, unknown>)[k] = v;
  if (requiredStatusChecks !== undefined)
    rule.requiredStatusChecks = requiredStatusChecks.map((c) => ({
      context: c.context,
      appId: c.appId ?? null,
    }));
  else if (requiredStatusCheckContexts !== undefined)
    rule.requiredStatusChecks = requiredStatusCheckContexts.map((context) => ({
      context,
      appId: null,
    }));
  if (
    plain.requiresStatusChecks === undefined &&
    (requiredStatusChecks !== undefined || requiredStatusCheckContexts !== undefined)
  )
    rule.requiresStatusChecks = rule.requiredStatusChecks.length > 0 || rule.requiresStatusChecks;
  if (rule.requiresApprovingReviews && rule.requiredApprovingReviewCount == null)
    rule.requiredApprovingReviewCount = 1;
  if (!rule.requiresApprovingReviews && plain.requiresApprovingReviews === false)
    rule.requiredApprovingReviewCount = null;
}

export function createRule(
  state: GitHubState,
  repo: RepoRec,
  pattern: string,
  input: RuleInput,
): BranchRule {
  const rule = defaultRule(state.nextId('rule', 90000), pattern);
  applyRuleInput(state, repo, rule, { ...input, pattern });
  repo.rules.push(rule);
  policyChanged(state, repo);
  return rule;
}

export function deleteRule(state: GitHubState, repo: RepoRec, rule: BranchRule): void {
  repo.rules = repo.rules.filter((r) => r !== rule);
  policyChanged(state, repo);
}

/** The single place that tells the git wiring whether a repository has rules (every mutation path ends here). */
function policyChanged(state: GitHubState, repo: RepoRec): void {
  state.options.repositoryHooks?.policyChanged?.(repo, repo.rules.length > 0);
}

/** Rules whose pattern matches `branch`. */
export function rulesFor(repo: RepoRec, branch: string): BranchRule[] {
  return repo.rules.filter((r) => fnmatch(r.pattern, branch));
}

export const isProtected = (repo: RepoRec, branch: string): boolean =>
  rulesFor(repo, branch).length > 0;

export interface RefActor {
  /** Node ids the actor is listed under in push and bypass lists (an App, a user, their teams). */
  nodeIds: string[];
  /** Repository admin: an installation token with Administration: write. */
  isAdmin: boolean;
}

export type RefUpdateKind = 'create' | 'delete' | 'update' | 'force';

export const refUpdateKind = (old: string, next: string, fastForward: boolean): RefUpdateKind =>
  /^0+$/.test(old) ? 'create' : /^0+$/.test(next) ? 'delete' : fastForward ? 'update' : 'force';

/**
 * Branch protection for one ref update (ADR-0040, ADR-0041, ADR-0076). Returns the rejection message
 * or undefined. Applies to `refs/heads/*` only. Admins bypass a rule unless it has `isAdminEnforced`.
 *
 * - force: `allowsForcePushes`, or the actor in `bypassForcePushActorIds` (stored independently).
 * - delete: `allowsDeletions`.
 * - create: `blocksCreations` unless the actor is in `pushActorIds`.
 * - update and force: `restrictsPushes` unless the actor is in `pushActorIds`.
 * Pull request, status check and signature requirements are not modelled here.
 */
export function checkRefUpdate(
  repo: RepoRec,
  ref: string,
  kind: RefUpdateKind,
  actor: RefActor,
): string | undefined {
  if (!ref.startsWith('refs/heads/')) return undefined;
  const listed = (ids: string[]) => ids.some((id) => actor.nodeIds.includes(id));
  for (const rule of rulesFor(repo, ref.slice('refs/heads/'.length))) {
    if (actor.isAdmin && !rule.isAdminEnforced) continue;
    let why: string | undefined;
    if (kind === 'delete' && !rule.allowsDeletions) why = 'Cannot delete this branch';
    else if (kind === 'create' && rule.blocksCreations && !listed(rule.pushActorIds))
      why = 'Cannot create ref due to creations being restricted';
    else if (
      (kind === 'update' || kind === 'force') &&
      rule.restrictsPushes &&
      !listed(rule.pushActorIds)
    )
      why = 'You are not allowed to push to this branch';
    else if (kind === 'force' && !rule.allowsForcePushes && !listed(rule.bypassForcePushActorIds))
      why = 'Cannot force-push to this branch';
    if (why) return `Protected branch update failed for ${ref}. ${why}.`;
  }
  return undefined;
}

/**
 * Whether a non-admin `actorNodeIds` may force push `branch` (ADR-0040): with `allowsForcePushes`
 * everyone with write access may, otherwise only the bypass actors.
 */
export function canForcePush(repo: RepoRec, branch: string, actorNodeIds: string[]): boolean {
  return (
    checkRefUpdate(repo, `refs/heads/${branch}`, 'force', {
      nodeIds: actorNodeIds,
      isAdmin: false,
    }) === undefined
  );
}
