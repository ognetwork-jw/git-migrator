/**
 * branch-rules driver (FAC-BRR-002, FAC-BRR-003, ADR-0014, ADR-0040, ADR-0041, ADR-0113): classic
 * branch protection rules read and written through GraphQL, one rule per pattern.
 */
import { AdapterError, type FacetDriver } from '@git-migrator/adapter-sdk';
import {
  type BranchRule,
  type BranchRules,
  branchRuleApplyOrder,
  type PrincipalEntry,
} from '@git-migrator/canonical';
import { Directory } from '../directory.ts';
import { Collector, type Gh, type Json, obj, str } from '../gh.ts';
import {
  cannotUndo,
  type DriverDeps,
  ghOf,
  ignoreGone,
  itemPath,
  mutation,
  repoTarget,
  sortBy,
} from './common.ts';

const ACTOR = `actor { __typename ... on User { databaseId } ... on Team { databaseId } ... on App { databaseId } }`;

const READ = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    id
    branchProtectionRules(first: 100, after: $after) {
      nodes {
        id pattern allowsDeletions allowsForcePushes blocksCreations dismissesStaleReviews
        isAdminEnforced requiredApprovingReviewCount requiresApprovingReviews
        requiresCodeOwnerReviews requiresConversationResolution requiresStatusChecks
        requiresStrictStatusChecks requiredStatusCheckContexts restrictsPushes
        pushAllowances(first: 100) { nodes { ${ACTOR} } }
        bypassForcePushAllowances(first: 100) { nodes { ${ACTOR} } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
  rateLimit { cost remaining resetAt }
}`;

const CREATE = `mutation($input: CreateBranchProtectionRuleInput!) {
  createBranchProtectionRule(input: $input) { branchProtectionRule { id pattern } }
}`;
const UPDATE = `mutation($input: UpdateBranchProtectionRuleInput!) {
  updateBranchProtectionRule(input: $input) { branchProtectionRule { id pattern } }
}`;
const DELETE = `mutation($input: DeleteBranchProtectionRuleInput!) {
  deleteBranchProtectionRule(input: $input) { clientMutationId }
}`;

interface RawRule {
  id: string;
  node: Json;
  rule: BranchRule;
  /** Node ids of the actors, per list. */
  checks: boolean;
}

function actors(connection: unknown, collector: Collector, pattern: string): PrincipalEntry[] {
  const out: PrincipalEntry[] = [];
  for (const n of (obj(connection).nodes as unknown[] | undefined) ?? []) {
    const actor = obj(obj(n).actor);
    const id = actor.databaseId;
    if (typeof id !== 'number') continue;
    if (actor.__typename === 'User') out.push({ principal: { kind: 'identity', id: String(id) } });
    else if (actor.__typename === 'Team')
      out.push({ principal: { kind: 'group', id: String(id) } });
    else collector.warn('branch-rules.app-actor-skipped', [], { pattern });
  }
  return sortBy(out, (e) => `${e.principal.kind}:${e.principal.id}`);
}

/** Target pattern verbatim; see ADR-0110. */
export function ruleOf(node: Json, collector: Collector): BranchRule {
  const pattern = str(node.pattern);
  const reviews = node.requiresApprovingReviews === true;
  const strict = node.requiresStrictStatusChecks === true;
  const contexts = Array.isArray(node.requiredStatusCheckContexts)
    ? node.requiredStatusCheckContexts.length
    : 0;
  const hasChangeRequest =
    reviews ||
    node.requiresStatusChecks === true ||
    node.requiresConversationResolution === true ||
    node.requiresCodeOwnerReviews === true ||
    node.dismissesStaleReviews === true;
  const allowsForce = node.allowsForcePushes === true;
  return {
    pattern,
    enforcement: 'enforced',
    restrictPushes:
      node.restrictsPushes === true ? actors(node.pushAllowances, collector, pattern) : null,
    restrictMerges: null,
    blockForcePush: !allowsForce,
    // Fail closed (ADR-0040): the bypass list only means something while force pushes are blocked.
    forcePushExempt: allowsForce ? [] : actors(node.bypassForcePushAllowances, collector, pattern),
    blockDeletion: node.allowsDeletions !== true,
    deletionExempt: [],
    changeRequest: hasChangeRequest
      ? {
          minApprovals: reviews ? Number(node.requiredApprovingReviewCount ?? 0) : 0,
          requireCodeOwnerApproval: node.requiresCodeOwnerReviews === true,
          dismissStaleApprovals: node.dismissesStaleReviews === true,
          requireNoChangesRequested: reviews,
          requireTasksResolved: node.requiresConversationResolution === true,
          requireUpToDate: strict,
          minPassingBuilds: contexts,
        }
      : null,
  };
}

async function readRules(
  gh: Gh,
  owner: string,
  name: string,
  collector: Collector,
): Promise<{ repositoryId: string; rules: RawRule[] }> {
  const rules: RawRule[] = [];
  let repositoryId = '';
  let after: string | null = null;
  for (let page = 0; page < 100; page++) {
    const data: Json = await gh.graphql<Json>(READ, { owner, name, after });
    const repo = obj(data.repository);
    repositoryId = str(repo.id);
    const connection = obj(repo.branchProtectionRules);
    for (const n of (connection.nodes as unknown[] | undefined) ?? []) {
      const node = obj(n);
      rules.push({
        id: str(node.id),
        node,
        rule: ruleOf(node, collector),
        checks: node.requiresStatusChecks === true,
      });
    }
    const info = obj(connection.pageInfo);
    if (info.hasNextPage !== true) break;
    after = str(info.endCursor);
  }
  return { repositoryId, rules };
}

interface Resolved {
  nodeIds: string[];
  dropped: boolean;
}

function resolveActors(
  entries: readonly PrincipalEntry[],
  users: Map<string, { nodeId: string }>,
  teams: Map<string, { nodeId: string }>,
): Resolved & { kept: PrincipalEntry[] } {
  const nodeIds: string[] = [];
  const kept: PrincipalEntry[] = [];
  let dropped = false;
  for (const e of entries) {
    const hit = (e.principal.kind === 'identity' ? users : teams).get(e.principal.id);
    if (hit && hit.nodeId !== '') {
      nodeIds.push(hit.nodeId);
      kept.push(e);
    } else dropped = true;
  }
  return { nodeIds: [...new Set(nodeIds)].sort(), dropped, kept };
}

/** The GraphQL input fields the framework manages for one rule. */
function managedInput(
  rule: BranchRule,
  existingChecks: boolean,
  push: Resolved,
  bypass: Resolved,
): Json {
  const cr = rule.changeRequest;
  // The target reports "no changes requested" exactly when reviews are required (ADR-0112); do not
  // rely on the facet having set the flag.
  const reviews =
    cr !== null &&
    (cr.requireNoChangesRequested ||
      cr.minApprovals >= 1 ||
      cr.requireCodeOwnerApproval ||
      cr.dismissStaleApprovals);
  const strict = cr?.requireUpToDate === true;
  return {
    requiresApprovingReviews: reviews,
    ...(reviews ? { requiredApprovingReviewCount: cr.minApprovals } : {}),
    dismissesStaleReviews: cr?.dismissStaleApprovals === true,
    requiresCodeOwnerReviews: cr?.requireCodeOwnerApproval === true,
    requiresConversationResolution: cr?.requireTasksResolved === true,
    // Check names are chosen by a human later (configure-status-checks); keep them when wanted.
    requiresStatusChecks: strict || (cr !== null && cr.minPassingBuilds > 0 && existingChecks),
    requiresStrictStatusChecks: strict,
    restrictsPushes: rule.restrictPushes !== null,
    pushActorIds: push.nodeIds,
    blocksCreations: rule.restrictPushes !== null,
    allowsForcePushes: !rule.blockForcePush,
    bypassForcePushActorIds: rule.blockForcePush ? bypass.nodeIds : [],
    allowsDeletions: !rule.blockDeletion,
    isAdminEnforced: false,
  };
}

function existingInput(node: Json, pushIds: string[], bypassIds: string[]): Json {
  const reviews = node.requiresApprovingReviews === true;
  return {
    requiresApprovingReviews: reviews,
    ...(reviews
      ? { requiredApprovingReviewCount: Number(node.requiredApprovingReviewCount ?? 0) }
      : {}),
    dismissesStaleReviews: node.dismissesStaleReviews === true,
    requiresCodeOwnerReviews: node.requiresCodeOwnerReviews === true,
    requiresConversationResolution: node.requiresConversationResolution === true,
    requiresStatusChecks: node.requiresStatusChecks === true,
    requiresStrictStatusChecks: node.requiresStrictStatusChecks === true,
    restrictsPushes: node.restrictsPushes === true,
    pushActorIds: pushIds,
    blocksCreations: node.blocksCreations === true,
    allowsForcePushes: node.allowsForcePushes === true,
    bypassForcePushActorIds: node.allowsForcePushes === true ? [] : bypassIds,
    allowsDeletions: node.allowsDeletions === true,
    isAdminEnforced: node.isAdminEnforced === true,
  };
}

function nodeIdsOf(
  entries: readonly PrincipalEntry[],
  users: Map<string, { nodeId: string }>,
  teams: Map<string, { nodeId: string }>,
): string[] {
  return resolveActors(entries, users, teams).nodeIds;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Only a GraphQL validation error counts: rate limits, empty data and the rest must surface. */
function isValidationError(error: unknown): boolean {
  return (
    error instanceof AdapterError &&
    error.code === 'invalid' &&
    /^GraphQL (UNPROCESSABLE|VALIDATION|INVALID)/i.test(error.message)
  );
}

export function branchRulesDriver(deps: DriverDeps): FacetDriver<BranchRules> {
  const driver: FacetDriver<BranchRules> = {
    async read(ctx, target) {
      const repo = repoTarget(target);
      const collector = new Collector();
      const { rules } = await readRules(ghOf(ctx, collector), deps.org, repo.slug, collector);
      return collector.result({
        rules: sortBy(
          rules.map((r) => r.rule),
          (r) => r.pattern,
        ),
      });
    },

    async *apply(ctx, target, desired) {
      const repo = repoTarget(target);
      const gh = ghOf(ctx);
      const collector = new Collector();
      const directory = new Directory(gh, deps.org);
      const { repositoryId, rules: existing } = await readRules(gh, deps.org, repo.slug, collector);
      const byPattern = new Map(existing.map((r) => [r.rule.pattern, r]));
      const wanted = new Map(desired.rules.map((r) => [r.pattern, r]));
      const users = await directory.users(repo.slug);
      const teams = new Map((await directory.teams()).map((t) => [t.id, t]));
      const ref = (pattern: string, id: string) => ({
        kind: 'branch-protection-rule',
        repository: repo.slug,
        pattern,
        id,
      });

      // 1. Rules that are not wanted (lift, rollback of a reconcile).
      for (const old of existing) {
        if (wanted.has(old.rule.pattern)) continue;
        await gh.graphql(DELETE, { input: { branchProtectionRuleId: old.id } }, true);
        yield mutation(
          'branch-rules',
          'delete',
          ref(old.rule.pattern, old.id),
          [itemPath('rules', 'pattern', old.rule.pattern)],
          old.rule,
          null,
        );
      }

      const write = async (
        rule: BranchRule,
        base: Json,
        make: (input: Json) => Promise<Json>,
      ): Promise<{ result: Json; exemptionsDropped: boolean }> => {
        try {
          return { result: await make(base), exemptionsDropped: false };
        } catch (error) {
          // ADR-0040: the bypass list can be refused. Retry without it; force pushes stay blocked
          // for everyone, which fails closed, and the ledger says so.
          const list = base.bypassForcePushActorIds as string[] | undefined;
          if (isValidationError(error) && rule.blockForcePush && list && list.length > 0) {
            ctx.logger.warn(
              { pattern: rule.pattern, finding: 'branch-rules.exemptions-dropped' },
              'force-push bypass list refused; applied without it',
            );
            return {
              result: await make({ ...base, bypassForcePushActorIds: [] }),
              exemptionsDropped: true,
            };
          }
          throw error;
        }
      };

      // 2. New rules, in the apply order that makes narrower rules older (ADR-0113).
      for (const rule of branchRuleApplyOrder(desired.rules)) {
        if (byPattern.has(rule.pattern)) continue;
        const push = resolveActors(rule.restrictPushes ?? [], users, teams);
        const bypass = resolveActors(rule.forcePushExempt, users, teams);
        if (push.dropped) {
          ctx.logger.warn({ pattern: rule.pattern }, 'push actor not resolvable; left out');
        }
        const input = {
          repositoryId,
          pattern: rule.pattern,
          ...managedInput(rule, false, push, bypass),
        };
        const written = await write(rule, input, (i) =>
          gh.graphql<Json>(CREATE, { input: i }, true),
        );
        const dropped = written.exemptionsDropped || bypass.dropped;
        const id = str(obj(obj(written.result.createBranchProtectionRule).branchProtectionRule).id);
        yield mutation(
          'branch-rules',
          'create',
          { ...ref(rule.pattern, id), ...(dropped ? { exemptionsDropped: true } : {}) },
          [itemPath('rules', 'pattern', rule.pattern)],
          null,
          written.exemptionsDropped
            ? { ...rule, forcePushExempt: [] }
            : { ...rule, forcePushExempt: bypass.kept },
        );
      }

      // 3. Existing rules that differ keep their age (and so their priority).
      for (const rule of desired.rules) {
        const old = byPattern.get(rule.pattern);
        if (!old) continue;
        const push = resolveActors(rule.restrictPushes ?? [], users, teams);
        const bypass = resolveActors(rule.forcePushExempt, users, teams);
        const wantedInput = managedInput(rule, old.checks, push, bypass);
        const haveInput = existingInput(
          old.node,
          nodeIdsOf(old.rule.restrictPushes ?? [], users, teams),
          nodeIdsOf(old.rule.forcePushExempt, users, teams),
        );
        if (same(wantedInput, haveInput)) continue;
        const input = { branchProtectionRuleId: old.id, ...wantedInput };
        // A bypass list GitHub refused earlier stays empty. When that is the only difference, a
        // second refusal changes nothing, so it is neither an error nor a mutation (idempotency).
        const noBypass = (i: Json) => ({ ...i, bypassForcePushActorIds: [] });
        const bypassOnly =
          rule.blockForcePush &&
          bypass.nodeIds.length > 0 &&
          (haveInput.bypassForcePushActorIds as string[]).length === 0 &&
          same(noBypass(wantedInput), noBypass(haveInput));
        let written: { result: Json; exemptionsDropped: boolean };
        try {
          written = bypassOnly
            ? { result: await gh.graphql<Json>(UPDATE, { input }, true), exemptionsDropped: false }
            : await write(rule, input, (i) => gh.graphql<Json>(UPDATE, { input: i }, true));
        } catch (error) {
          if (bypassOnly && isValidationError(error)) {
            ctx.logger.warn({ pattern: rule.pattern }, 'force-push bypass list still refused');
            continue;
          }
          throw error;
        }
        const dropped = written.exemptionsDropped || bypass.dropped;
        yield mutation(
          'branch-rules',
          'update',
          {
            ...ref(rule.pattern, old.id),
            ...(dropped ? { exemptionsDropped: true } : {}),
          },
          [itemPath('rules', 'pattern', rule.pattern)],
          old.rule,
          written.exemptionsDropped
            ? { ...rule, forcePushExempt: [] }
            : { ...rule, forcePushExempt: bypass.kept },
        );
      }
    },

    async undo(ctx, target, record) {
      const ref = record.resourceRef;
      if (ref.kind !== 'branch-protection-rule') throw cannotUndo(record);
      const repo = repoTarget(target);
      const gh = ghOf(ctx);
      const pattern = String(ref.pattern);
      const { repositoryId, rules: existing } = await readRules(
        gh,
        deps.org,
        repo.slug,
        new Collector(),
      );
      const current = existing.find((r) => r.rule.pattern === pattern);
      if (record.action === 'create') {
        // Only the rule this record created: a rule re-made under the pattern since is not ours.
        if (current?.id === String(ref.id)) {
          await ignoreGone(
            gh.graphql(DELETE, { input: { branchProtectionRuleId: current.id } }, true),
          );
        }
        return;
      }
      // An update goes back to the rule it replaced; a delete (step 3a) makes the rule again. Only
      // this one rule is written, never through `apply`: `managedInput` does not round-trip what
      // the framework does not manage (admin enforcement, creation blocking, status checks), so
      // rewriting the other rules would change rules an operator tightened (ADR-0467 round 2).
      const was = record.before as BranchRule | null;
      if (was === null || typeof was !== 'object') throw cannotUndo(record);
      const directory = new Directory(gh, deps.org);
      const users = await directory.users(repo.slug);
      const teams = new Map((await directory.teams()).map((t) => [t.id, t]));
      const push = resolveActors(was.restrictPushes ?? [], users, teams);
      const bypass = resolveActors(was.forcePushExempt, users, teams);
      if (record.action === 'update') {
        if (current?.id !== String(ref.id)) {
          return { left: { kind: 'branch-rule-replaced', name: pattern } };
        }
        const input = {
          branchProtectionRuleId: current.id,
          ...managedInput(was, current.checks, push, bypass),
        };
        await gh.graphql(UPDATE, { input }, true);
        return;
      }
      if (current) {
        // A lifted rule that exists again is not made twice.
        return { left: { kind: 'branch-rule-exists', name: pattern } };
      }
      const input = { repositoryId, pattern, ...managedInput(was, false, push, bypass) };
      try {
        await gh.graphql(CREATE, { input }, true);
      } catch (error) {
        // The bypass list can be refused (ADR-0040): the rule is made without it, which fails closed.
        if (!(isValidationError(error) && bypass.nodeIds.length > 0)) throw error;
        await gh.graphql(CREATE, { input: { ...input, bypassForcePushActorIds: [] } }, true);
      }
    },
  };
  return driver;
}
