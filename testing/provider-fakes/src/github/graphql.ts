import { readFileSync } from 'node:fs';
import {
  buildSchema,
  type ExecutionResult,
  GraphQLError,
  type GraphQLSchema,
  graphql,
  Kind,
  parse,
  type SelectionSetNode,
  type ValueNode,
} from 'graphql';
import type { AuthCtx } from './auth.ts';
import type { RateLimiter } from './rate-limit.ts';
import { applyRuleInput, createRule, deleteRule, type RuleInput } from './rules.ts';
import { GitHubState } from './state.ts';
import type { AppRec, BranchRule, OrgRec, RepoRec, TeamRec, UserRec } from './types.ts';
import { RuleError } from './util.ts';

/**
 * The GraphQL branch-protection subset (TST-011, ADR-0014): `repository`, `node`, `user`,
 * `organization`, `rateLimit`, and the create/update/deleteBranchProtectionRule mutations. Operations
 * are parsed, validated and executed by graphql-js against the saved schema
 * (`specs/github.graphql`), so anything outside the subset is a GraphQL validation error.
 */

let schema: GraphQLSchema | undefined;
function getSchema(): GraphQLSchema {
  schema ??= buildSchema(
    readFileSync(new URL('../../specs/github.graphql', import.meta.url), 'utf8'),
  );
  return schema;
}

export interface GqlContext {
  state: GitHubState;
  auth: AuthCtx;
  limiter: RateLimiter;
  /** From `queryCost`, reported by `rateLimit { cost nodeCount }`. */
  cost?: { cost: number; nodeCount: number };
}

/**
 * GitHub's cost model, simplified (provider doc, GraphQL): the nodes a query can return are the sum
 * over connections of `first`/`last` times the nodes of the parents; cost is nodes / 100 rounded up,
 * at least 1. A mutation costs 1. Variables are resolved; an unparsable query costs 1.
 */
export function queryCost(
  query: string,
  variables: Record<string, unknown> | null | undefined,
): { cost: number; nodeCount: number } {
  let doc: ReturnType<typeof parse>;
  try {
    doc = parse(query);
  } catch {
    return { cost: 1, nodeCount: 0 };
  }
  const num = (v: ValueNode | undefined): number | undefined => {
    if (!v) return undefined;
    if (v.kind === Kind.INT) return Number(v.value);
    if (v.kind === Kind.VARIABLE) {
      const x = variables?.[v.name.value];
      return typeof x === 'number' ? x : undefined;
    }
    return undefined;
  };
  const walk = (set: SelectionSetNode | undefined, multiplier: number): number => {
    let nodes = 0;
    for (const sel of set?.selections ?? []) {
      if (sel.kind === Kind.FRAGMENT_SPREAD) continue;
      if (sel.kind === Kind.INLINE_FRAGMENT) {
        nodes += walk(sel.selectionSet, multiplier);
        continue;
      }
      const page = sel.arguments?.find((a) => a.name.value === 'first' || a.name.value === 'last');
      const n = page ? (num(page.value) ?? 0) : 0;
      if (n > 0) nodes += multiplier * n + walk(sel.selectionSet, multiplier * n);
      else nodes += walk(sel.selectionSet, multiplier);
    }
    return nodes;
  };
  let nodeCount = 0;
  let mutation = false;
  for (const def of doc.definitions)
    if (def.kind === Kind.OPERATION_DEFINITION) {
      if (def.operation === 'mutation') mutation = true;
      nodeCount += walk(def.selectionSet, 1);
    }
  return { cost: mutation ? 1 : Math.max(1, Math.ceil(nodeCount / 100)), nodeCount };
}

type Args = Record<string, unknown>;

const err = (message: string, type: string) => new GraphQLError(message, { extensions: { type } });
const forbiddenErr = () => err('Resource not accessible by integration', 'FORBIDDEN');

function needAdmin(ctx: GqlContext, level: 'read' | 'write'): void {
  if (!GitHubState.allows(ctx.auth.permissions, 'administration', level)) throw forbiddenErr();
}

/** A read of a repository: the installation's own, or a public one of any owner (as on GitHub). */
function repoReadable(ctx: GqlContext, repo: RepoRec): boolean {
  return (
    repoVisible(ctx, repo) || (ctx.auth.installation !== undefined && repo.visibility === 'public')
  );
}

function repoVisible(ctx: GqlContext, repo: RepoRec): boolean {
  const ids = ctx.auth.token?.repositoryIds;
  const inst = ctx.auth.installation;
  if (!inst || repo.owner.toLowerCase() !== inst.account.toLowerCase()) return false;
  if (
    inst.repositorySelection === 'selected' &&
    !inst.repositories
      .map((r) => r.toLowerCase())
      .includes(`${repo.owner}/${repo.name}`.toLowerCase())
  )
    return false;
  return !ids || ids.includes(repo.id);
}

const userObj = (u: UserRec) => ({
  __typename: 'User',
  id: u.nodeId,
  databaseId: u.id,
  login: u.login,
});
const teamObj = (t: TeamRec) => ({
  __typename: 'Team',
  id: t.nodeId,
  databaseId: t.id,
  name: t.name,
  slug: t.slug,
  combinedSlug: `${t.org}/${t.slug}`,
});
const appObj = (a: AppRec) => ({
  __typename: 'App',
  id: a.nodeId,
  databaseId: a.id,
  name: a.name,
  slug: a.slug,
});
const orgObj = (o: OrgRec) => ({
  __typename: 'Organization',
  id: o.nodeId,
  databaseId: o.id,
  login: o.login,
});

function actor(state: GitHubState, id: string) {
  const n = state.findNode(id);
  if (n?.type === 'User') return userObj(n.rec);
  if (n?.type === 'Team') return teamObj(n.rec);
  if (n?.type === 'App') return appObj(n.rec);
  return null;
}

function cursorOf(i: number): string {
  return Buffer.from(`cursor:${i + 1}`).toString('base64');
}
function indexOf(cursor: unknown): number | undefined {
  if (typeof cursor !== 'string') return undefined;
  const m = /^cursor:(\d+)$/.exec(Buffer.from(cursor, 'base64').toString('utf8'));
  return m ? Number(m[1]) : undefined;
}

/** Relay-style connection with `first`/`after`/`last`/`before` (limit 100, one of first/last required). */
function connection<T, N>(
  field: string,
  items: T[],
  args: Args,
  map: (t: T) => N,
  edgeMapper?: (t: T) => unknown,
) {
  const { first, last } = args as { first?: number; last?: number };
  if (first == null && last == null)
    throw err(
      `You must provide a \`first\` or \`last\` value to properly paginate the \`${field}\` connection.`,
      'MISSING_PAGINATION_BOUNDARIES',
    );
  for (const n of [first, last])
    if (n != null && n > 100)
      throw err(
        `Requesting ${n} records on the \`${field}\` connection exceeds the \`${first != null ? 'first' : 'last'}\` limit of 100 records.`,
        'EXCESSIVE_PAGINATION',
      );
  let start = 0;
  let end = items.length;
  const after = indexOf(args.after);
  const before = indexOf(args.before);
  if (after !== undefined) start = Math.min(items.length, after);
  if (before !== undefined) end = Math.max(start, Math.min(items.length, before - 1));
  if (first != null) end = Math.min(end, start + first);
  if (last != null) start = Math.max(start, end - last);
  const slice = items.slice(start, end);
  const nodes = slice.map(edgeMapper ?? map);
  return {
    totalCount: items.length,
    nodes,
    edges: slice.map((_t, i) => ({ cursor: cursorOf(start + i), node: nodes[i] })),
    pageInfo: {
      hasNextPage: end < items.length,
      hasPreviousPage: start > 0,
      startCursor: slice.length ? cursorOf(start) : null,
      endCursor: slice.length ? cursorOf(start + slice.length - 1) : null,
    },
  };
}

function ruleObj(ctx: GqlContext, repo: RepoRec, r: BranchRule): Record<string, unknown> {
  const { state } = ctx;
  const allowances = (ids: string[], typeName: string, field: string) => (args: Args) =>
    connection(
      field,
      ids,
      args,
      (id) => id,
      (id) => ({
        __typename: typeName,
        id: `${r.nodeId}:${typeName}:${id}`,
        actor: actor(state, id),
        branchProtectionRule: ruleObj(ctx, repo, r),
      }),
    );
  return {
    __typename: 'BranchProtectionRule',
    ...r,
    id: r.nodeId,
    databaseId: r.id,
    requiredStatusCheckContexts: r.requiredStatusChecks.map((c) => c.context),
    requiredStatusChecks: r.requiredStatusChecks.map((c) => ({
      context: c.context,
      app: c.appId
        ? (() => {
            const n = state.findNode(c.appId);
            return n?.type === 'App' ? appObj(n.rec) : null;
          })()
        : null,
    })),
    requiredDeploymentEnvironments: r.requiredDeploymentEnvironments,
    pushAllowances: allowances(r.pushActorIds, 'PushAllowance', 'pushAllowances'),
    bypassForcePushAllowances: allowances(
      r.bypassForcePushActorIds,
      'BypassForcePushAllowance',
      'bypassForcePushAllowances',
    ),
    bypassPullRequestAllowances: allowances(
      r.bypassPullRequestActorIds,
      'BypassPullRequestAllowance',
      'bypassPullRequestAllowances',
    ),
    repository: () => repoObj(ctx, repo),
  };
}

function repoObj(ctx: GqlContext, repo: RepoRec): Record<string, unknown> {
  return {
    __typename: 'Repository',
    id: repo.nodeId,
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    isPrivate: repo.private,
    isEmpty: repo.git.isEmpty,
    branchProtectionRules: (args: Args) => {
      needAdmin(ctx, 'read');
      return connection('branchProtectionRules', repo.rules, args, (r) => ruleObj(ctx, repo, r));
    },
  };
}

function resolveRepo(ctx: GqlContext, id: unknown): RepoRec {
  const n = ctx.state.findNode(String(id));
  if (n?.type !== 'Repository' || !repoVisible(ctx, n.rec))
    throw err(
      `Could not resolve to a Repository node with the global id of '${String(id)}'.`,
      'NOT_FOUND',
    );
  return n.rec;
}

function toRuleInput(input: Args): RuleInput {
  const { clientMutationId: _c, repositoryId: _r, branchProtectionRuleId: _b, ...rest } = input;
  return rest as RuleInput;
}

function asGraphQLError(e: unknown): never {
  if (e instanceof RuleError)
    throw err(e.message, e.message.startsWith('Could not resolve') ? 'NOT_FOUND' : 'UNPROCESSABLE');
  throw e;
}

function rootValue() {
  return {
    repository: (args: Args, ctx: GqlContext) => {
      const repo = ctx.state.findRepo(String(args.owner), String(args.name));
      if (!repo || !repoReadable(ctx, repo))
        throw err(
          `Could not resolve to a Repository with the name '${String(args.owner)}/${String(args.name)}'.`,
          'NOT_FOUND',
        );
      return repoObj(ctx, repo);
    },
    node: (args: Args, ctx: GqlContext) => {
      const n = ctx.state.findNode(String(args.id));
      if (!n) return null;
      if (n.type === 'User') return userObj(n.rec);
      if (n.type === 'Organization') return orgObj(n.rec);
      if (n.type === 'Team') return teamObj(n.rec);
      if (n.type === 'App') return appObj(n.rec);
      if (n.type === 'Repository') return repoReadable(ctx, n.rec) ? repoObj(ctx, n.rec) : null;
      if (n.type === 'BranchProtectionRule') {
        needAdmin(ctx, 'read');
        return repoVisible(ctx, n.repo) ? ruleObj(ctx, n.repo, n.rec) : null;
      }
      return null;
    },
    user: (args: Args, ctx: GqlContext) => {
      const u = ctx.state.findUser(String(args.login));
      if (!u)
        throw err(
          `Could not resolve to a User with the login of '${String(args.login)}'.`,
          'NOT_FOUND',
        );
      return userObj(u);
    },
    organization: (args: Args, ctx: GqlContext) => {
      const o = ctx.state.orgs.get(String(args.login).toLowerCase());
      if (!o)
        throw err(
          `Could not resolve to an Organization with the login of '${String(args.login)}'.`,
          'NOT_FOUND',
        );
      return orgObj(o);
    },
    rateLimit: (_args: Args, ctx: GqlContext) => {
      const info = ctx.limiter.peek(ctx.auth, 'graphql');
      return {
        cost: ctx.cost?.cost ?? 1,
        limit: info.limit,
        nodeCount: ctx.cost?.nodeCount ?? 0,
        remaining: info.remaining,
        used: info.used,
        resetAt: new Date(info.reset * 1000).toISOString(),
      };
    },
    createBranchProtectionRule: ({ input }: { input: Args }, ctx: GqlContext) => {
      needAdmin(ctx, 'write');
      const repo = resolveRepo(ctx, input.repositoryId);
      try {
        const rule = createRule(ctx.state, repo, String(input.pattern), toRuleInput(input));
        return {
          clientMutationId: input.clientMutationId ?? null,
          branchProtectionRule: ruleObj(ctx, repo, rule),
        };
      } catch (e) {
        return asGraphQLError(e);
      }
    },
    updateBranchProtectionRule: ({ input }: { input: Args }, ctx: GqlContext) => {
      needAdmin(ctx, 'write');
      const n = ctx.state.findNode(String(input.branchProtectionRuleId));
      if (n?.type !== 'BranchProtectionRule' || !repoVisible(ctx, n.repo))
        throw err(
          `Could not resolve to a BranchProtectionRule with the global id of '${String(input.branchProtectionRuleId)}'.`,
          'NOT_FOUND',
        );
      try {
        applyRuleInput(ctx.state, n.repo, n.rec, toRuleInput(input));
        return {
          clientMutationId: input.clientMutationId ?? null,
          branchProtectionRule: ruleObj(ctx, n.repo, n.rec),
        };
      } catch (e) {
        return asGraphQLError(e);
      }
    },
    deleteBranchProtectionRule: ({ input }: { input: Args }, ctx: GqlContext) => {
      needAdmin(ctx, 'write');
      const n = ctx.state.findNode(String(input.branchProtectionRuleId));
      if (n?.type !== 'BranchProtectionRule' || !repoVisible(ctx, n.repo))
        throw err(
          `Could not resolve to a BranchProtectionRule with the global id of '${String(input.branchProtectionRuleId)}'.`,
          'NOT_FOUND',
        );
      deleteRule(ctx.state, n.repo, n.rec);
      return { clientMutationId: input.clientMutationId ?? null };
    },
  };
}

/** Whether the operation that will run (by `operationName`, else the only one) is a mutation. */
export function isMutation(query: string, operationName?: string | null): boolean {
  try {
    const ops = parse(query).definitions.filter((d) => d.kind === Kind.OPERATION_DEFINITION);
    const op = operationName ? ops.find((o) => o.name?.value === operationName) : ops[0];
    return op?.operation === 'mutation';
  } catch {
    return false;
  }
}

/** Runs one operation. The result has GitHub's error shape (`type` beside `message`). */
export async function runGraphQL(
  ctx: GqlContext,
  body: {
    query: string;
    variables?: Record<string, unknown> | null;
    operationName?: string | null;
  },
): Promise<ExecutionResult> {
  const result = await graphql({
    schema: getSchema(),
    source: body.query,
    rootValue: rootValue(),
    contextValue: ctx,
    variableValues: body.variables ?? undefined,
    operationName: body.operationName ?? undefined,
  });
  if (!result.errors) return result;
  return {
    ...result,
    errors: result.errors.map((e) => {
      const type = e.extensions?.type as string | undefined;
      const json = e.toJSON() as unknown as Record<string, unknown>;
      const { extensions: _x, ...rest } = json;
      return (type ? { type, ...rest } : rest) as never;
    }),
  };
}
