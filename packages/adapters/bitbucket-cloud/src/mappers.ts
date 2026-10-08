/**
 * Pure mappers from Bitbucket Cloud JSON to canonical Facet data (FAC-*, docs/providers). No I/O.
 * Unknown provider fields are ignored (ADP-013).
 */
import type { AdapterWarning } from '@git-migrator/adapter-sdk';
import {
  type AccessControl,
  type AccessRole,
  type BranchRule,
  type CanonicalEvent,
  type ChangeRequests,
  type CodeOwnership,
  type DeployKeys,
  type Environments,
  type MergeSettings,
  type MergeStrategy,
  type PrincipalEntry,
  type PrincipalRef,
  type RepositorySettings,
  webhookKey,
} from '@git-migrator/canonical';
import { formatFieldPath, itemSeg, sha256Hex } from '@git-migrator/core';
import { z } from 'zod';
import { type Account, obj } from './api.ts';

// ---- principals -------------------------------------------------------------------------------

/** Provider-stable id of an identity: the Atlassian account id, else the user uuid. */
export function principalId(user: Account): string | undefined {
  return user.account_id ?? user.uuid;
}

export function identityRef(user: Account): PrincipalRef | undefined {
  const id = principalId(user);
  return id === undefined ? undefined : { kind: 'identity', id };
}

export const groupRefOf = (slug: string): PrincipalRef => ({ kind: 'group', id: slug });

const refKey = (p: PrincipalRef) => `${p.kind}:${p.id}`;

function entries(refs: readonly (PrincipalRef | undefined)[]): PrincipalEntry[] {
  const map = new Map<string, PrincipalEntry>();
  for (const ref of refs) if (ref !== undefined) map.set(refKey(ref), { principal: ref });
  return [...map.values()].sort((a, b) =>
    refKey(a.principal) < refKey(b.principal)
      ? -1
      : refKey(a.principal) > refKey(b.principal)
        ? 1
        : 0,
  );
}

// ---- repository-settings (FAC-SET) -------------------------------------------------------------

interface RepoLike {
  description?: string | null | undefined;
  website?: string | null | undefined;
  is_private: boolean;
  fork_policy?: string | undefined;
  has_issues?: boolean | undefined;
  has_wiki?: boolean | undefined;
}

export function mapForking(policy: string | undefined): RepositorySettings['forking'] {
  if (policy === 'no_forks') return 'disallowed';
  if (policy === 'no_public_forks') return 'private-only';
  return 'allowed';
}

/** The description is kept as read; `normalize` strips the framework prefix (FAC-SET-003). */
export function mapRepositorySettings(repo: RepoLike): RepositorySettings {
  const website = repo.website?.trim() ?? '';
  return {
    description: repo.description ?? '',
    homepage: website === '' ? null : website,
    visibility: repo.is_private ? 'private' : 'public',
    features: { issues: repo.has_issues === true, wiki: repo.has_wiki === true },
    forking: mapForking(repo.fork_policy),
  };
}

// ---- merge-settings (FAC-MRG, ADR-0101) --------------------------------------------------------

const STRATEGY_ORDER: readonly MergeStrategy[] = [
  'merge-commit',
  'squash',
  'rebase',
  'fast-forward-only',
];

/** `squash_fast_forward` is a squash (not lossy); `rebase_*` are rebase. Unknown values are skipped. */
export function mapMergeStrategies(values: readonly string[]): MergeStrategy[] {
  const out = new Set<MergeStrategy>();
  for (const v of values) {
    if (v === 'merge_commit') out.add('merge-commit');
    else if (v === 'squash' || v === 'squash_fast_forward') out.add('squash');
    else if (v === 'rebase_merge' || v === 'rebase_fast_forward') out.add('rebase');
    else if (v === 'fast_forward') out.add('fast-forward-only');
  }
  return STRATEGY_ORDER.filter((s) => out.has(s));
}

/** `default_branch_deletion` is a string `"true"`/`"false"` (ADR-0035) but a boolean is accepted. */
export function parseBoolish(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true') return true;
    if (v === 'false') return false;
  }
  return undefined;
}

/**
 * FAC-MRG-002: a field that cannot be read (missing, or an empty strategy set) is reported
 * `unreadable`; the placeholder value is ignored by the facet.
 */
export function mapMergeSettings(input: {
  strategies: readonly string[] | undefined;
  deleteBranchOnMerge: unknown;
}): { data: MergeSettings; unreadable: string[] } {
  const unreadable: string[] = [];
  const allowed = input.strategies === undefined ? [] : mapMergeStrategies(input.strategies);
  if (allowed.length === 0) unreadable.push('/allowed');
  const del = parseBoolish(input.deleteBranchOnMerge);
  if (del === undefined) unreadable.push('/deleteBranchOnMerge');
  return { data: { allowed, deleteBranchOnMerge: del ?? false }, unreadable };
}

// ---- access-control (FAC-ACL-001) --------------------------------------------------------------

const ROLE_RANK: Record<AccessRole, number> = {
  read: 0,
  triage: 1,
  write: 2,
  maintain: 3,
  admin: 4,
};

/** `create-repo` (project) can write to the project's repositories; it is not admin (ADR-0221). */
export function mapRole(permission: string): AccessRole | undefined {
  if (permission === 'read') return 'read';
  if (permission === 'write' || permission === 'create-repo') return 'write';
  if (permission === 'admin') return 'admin';
  return undefined;
}

export interface Grant {
  principal: PrincipalRef;
  role: AccessRole;
}

/** The union of grants; a principal that appears more than once gets the maximum role. */
export function unionGrants(
  grants: readonly Grant[],
  excludeIdentities: ReadonlySet<string> = new Set(),
): AccessControl {
  const best = new Map<string, Grant>();
  for (const g of grants) {
    if (g.principal.kind === 'identity' && excludeIdentities.has(g.principal.id)) continue;
    const key = refKey(g.principal);
    const prev = best.get(key);
    if (prev === undefined || ROLE_RANK[g.role] > ROLE_RANK[prev.role]) best.set(key, g);
  }
  return {
    grants: [...best.values()].sort((a, b) =>
      refKey(a.principal) < refKey(b.principal)
        ? -1
        : refKey(a.principal) > refKey(b.principal)
          ? 1
          : 0,
    ),
  };
}

export const userPermission = obj({
  permission: z.string(),
  user: z.object({}).loose().optional(),
});
export const groupPermission = obj({
  permission: z.string(),
  group: obj({ slug: z.string() }).optional(),
});

export function userGrants(rows: readonly z.infer<typeof userPermission>[]): Grant[] {
  const out: Grant[] = [];
  for (const row of rows) {
    const role = mapRole(row.permission);
    const principal = row.user === undefined ? undefined : identityRef(row.user as Account);
    if (role !== undefined && principal !== undefined) out.push({ principal, role });
  }
  return out;
}

export function groupGrants(rows: readonly z.infer<typeof groupPermission>[]): Grant[] {
  const out: Grant[] = [];
  for (const row of rows) {
    const role = mapRole(row.permission);
    if (role !== undefined && row.group !== undefined) {
      out.push({ principal: groupRefOf(row.group.slug), role });
    }
  }
  return out;
}

// ---- branch-rules (FAC-BRR-001, FAC-BRR-003) ---------------------------------------------------

export const restriction = obj({
  id: z.number(),
  kind: z.string(),
  pattern: z.string().nullish(),
  branch_match_kind: z.string().optional(),
  branch_type: z.string().nullish(),
  value: z.number().nullish(),
  users: z.array(obj({})).optional(),
  groups: z.array(obj({ slug: z.string() })).optional(),
});
export type Restriction = z.infer<typeof restriction>;

export const branchingModel = obj({
  branch_types: z.array(obj({ kind: z.string(), prefix: z.string().optional() })).optional(),
  development: obj({
    name: z.string().nullish(),
    use_mainbranch: z.boolean().optional(),
  }).optional(),
  production: obj({ name: z.string().nullish() }).optional(),
});
export type BranchingModel = z.infer<typeof branchingModel>;

/** Bitbucket `*` crosses `/`, so it is canonical `**` (FAC-BRR-003). */
export function globToCanonical(pattern: string): string {
  return pattern.replace(/\*+/g, '**');
}

/** Pattern of a `branching_model` restriction, or undefined if the model does not define it. */
export function branchingModelPattern(r: Restriction, model: BranchingModel): string | undefined {
  const type = r.branch_type ?? '';
  if (type === 'development') return model.development?.name ?? undefined;
  if (type === 'production') return model.production?.name ?? undefined;
  const prefix = model.branch_types?.find((t) => t.kind === type)?.prefix;
  return prefix === undefined || prefix === '' ? undefined : `${prefix}**`;
}

interface Acc {
  pushes: Map<string, PrincipalRef> | null;
  merges: Map<string, PrincipalRef> | null;
  force: Map<string, PrincipalRef> | null; // null = not blocked
  del: Map<string, PrincipalRef> | null;
  cr: BranchRule['changeRequest'];
  enforced: boolean;
}

const principalsOf = (r: Restriction): Map<string, PrincipalRef> => {
  const map = new Map<string, PrincipalRef>();
  for (const u of r.users ?? []) {
    const ref = identityRef(u as Account);
    if (ref !== undefined) map.set(refKey(ref), ref);
  }
  for (const g of r.groups ?? []) map.set(`group:${g.slug}`, groupRefOf(g.slug));
  return map;
};

/** Both restrict: a principal passes only if listed by each. */
function intersect(
  a: Map<string, PrincipalRef> | null,
  b: Map<string, PrincipalRef>,
): Map<string, PrincipalRef> {
  if (a === null) return new Map(b);
  return new Map([...a].filter(([k]) => b.has(k)));
}

const toEntries = (m: Map<string, PrincipalRef> | null): PrincipalEntry[] | null =>
  m === null ? null : entries([...m.values()]);

const emptyCr = (): NonNullable<BranchRule['changeRequest']> => ({
  minApprovals: 0,
  requireCodeOwnerApproval: false,
  dismissStaleApprovals: false,
  requireNoChangesRequested: false,
  requireTasksResolved: false,
  requireUpToDate: false,
  minPassingBuilds: 0,
});

const rulePath = (pattern: string) => formatFieldPath([itemSeg('rules', 'pattern', pattern)]);

/**
 * Groups restrictions by canonical pattern into rules. Restrictions of one kind that land on the
 * same canonical pattern are combined strictest-first (allow lists intersect, counts take the
 * maximum, flags OR). Enforcement is `enforced` only when an `enforce_merge_checks` restriction
 * exists for the pattern or the rule has no merge-check part (ADR-0221).
 */
export function mapBranchRules(
  restrictions: readonly Restriction[],
  model: BranchingModel,
): { rules: BranchRule[]; warnings: AdapterWarning[] } {
  const warnings: AdapterWarning[] = [];
  const accs = new Map<string, Acc>();
  const unresolved: string[] = [];
  let usedModel = false;
  for (const r of restrictions) {
    let pattern: string | undefined;
    if (r.branch_match_kind === 'branching_model') {
      usedModel = true;
      const p = branchingModelPattern(r, model);
      if (p === undefined) {
        unresolved.push(r.branch_type ?? 'unknown');
        continue;
      }
      pattern = globToCanonical(p);
    } else if (r.pattern !== undefined && r.pattern !== null && r.pattern !== '') {
      pattern = globToCanonical(r.pattern);
    }
    if (pattern === undefined) {
      // Not silently dropped: reported with the existing "restriction not mapped" code.
      warnings.push({
        code: 'branch-rules.unknown-kind',
        paths: [],
        params: { kind: r.kind, reason: 'empty-pattern' },
      });
      continue;
    }
    const acc =
      accs.get(pattern) ??
      ({ pushes: null, merges: null, force: null, del: null, cr: null, enforced: false } as Acc);
    const who = principalsOf(r);
    const cr = () => {
      acc.cr ??= emptyCr();
      return acc.cr;
    };
    const value = r.value ?? 0;
    switch (r.kind) {
      case 'push':
        acc.pushes = intersect(acc.pushes, who);
        break;
      case 'restrict_merges':
        acc.merges = intersect(acc.merges, who);
        break;
      case 'force':
        acc.force = intersect(acc.force, who);
        break;
      case 'delete':
        acc.del = intersect(acc.del, who);
        break;
      case 'require_approvals_to_merge':
        cr().minApprovals = Math.max(cr().minApprovals, value);
        break;
      case 'require_default_reviewer_approvals_to_merge':
        cr().requireCodeOwnerApproval = true;
        break;
      case 'reset_pullrequest_approvals_on_change':
        cr().dismissStaleApprovals = true;
        break;
      case 'require_no_changes_requested':
        cr().requireNoChangesRequested = true;
        break;
      case 'require_tasks_to_be_completed':
        cr().requireTasksResolved = true;
        break;
      case 'require_commits_behind':
        cr().requireUpToDate = true;
        break;
      case 'require_passing_builds_to_merge':
        cr().minPassingBuilds = Math.max(cr().minPassingBuilds, value);
        break;
      case 'enforce_merge_checks':
        acc.enforced = true;
        break;
      default:
        warnings.push({
          code: 'branch-rules.unknown-kind',
          paths: [rulePath(pattern)],
          params: { kind: r.kind, pattern },
        });
        continue;
    }
    accs.set(pattern, acc);
  }
  const rules: BranchRule[] = [...accs]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([pattern, a]) => ({
      pattern,
      enforcement: a.cr !== null && !a.enforced ? 'advisory' : 'enforced',
      restrictPushes: toEntries(a.pushes),
      restrictMerges: toEntries(a.merges),
      blockForcePush: a.force !== null,
      forcePushExempt: toEntries(a.force) ?? [],
      blockDeletion: a.del !== null,
      deletionExempt: toEntries(a.del) ?? [],
      changeRequest: a.cr,
    }));
  const prefixes = (model.branch_types ?? []).map((t) => t.prefix).filter((p) => p !== undefined);
  // Only a model that matters is reported (ADR-0313): a restriction uses it, or a production
  // branch is configured. A default model whose prefixes nothing refers to has nothing to tell.
  const ownDevelopment = model.development?.use_mainbranch === false && !!model.development.name;
  if (usedModel || model.production?.name || ownDevelopment) {
    warnings.push({
      code: 'branch-rules.branching-model',
      paths: [],
      params: {
        prefixes,
        development: model.development?.name ?? null,
        production: model.production?.name ?? null,
        unresolvedBranchTypes: unresolved,
      },
    });
  }
  return { rules, warnings };
}

// ---- webhooks (FAC-WEB-001) --------------------------------------------------------------------

export function mapEvent(event: string): CanonicalEvent | undefined {
  if (event === 'repo:push') return 'push';
  if (event === 'pullrequest:created') return 'cr.opened';
  if (event === 'pullrequest:updated') return 'cr.updated';
  if (event === 'pullrequest:fulfilled') return 'cr.merged';
  if (event === 'pullrequest:rejected') return 'cr.declined';
  if (event.startsWith('pullrequest:comment_')) return 'cr.comment';
  if (event === 'pullrequest:approved') return 'cr.approved';
  if (event === 'pullrequest:changes_request_created') return 'cr.changes_requested';
  if (event.startsWith('repo:commit_status_')) return 'build.status';
  if (event === 'repo:updated') return 'repo.updated';
  if (event === 'repo:fork') return 'repo.fork';
  if (event.startsWith('issue:')) return 'issue.any';
  return undefined;
}

export const webhookRow = obj({
  uuid: z.string().optional(),
  url: z.string(),
  active: z.boolean().optional(),
  events: z.array(z.string()).optional(),
  secret_set: z.boolean().optional(),
  skip_cert_verification: z.boolean().optional(),
});
export type WebhookRow = z.infer<typeof webhookRow>;

export interface RawHook {
  url: string;
  events: CanonicalEvent[];
  active: boolean;
  hasSecret: boolean;
  verifyTls: boolean;
}

/** URL problems are reported without the URL, which may carry credentials (ADR-0088). */
export function mapWebhookRows(
  rows: readonly WebhookRow[],
  scope: string,
): {
  hooks: RawHook[];
  warnings: AdapterWarning[];
} {
  const hooks: RawHook[] = [];
  const warnings: AdapterWarning[] = [];
  let invalid = 0;
  for (const row of rows) {
    let usable = false;
    try {
      const u = new URL(row.url);
      usable =
        (u.protocol === 'http:' || u.protocol === 'https:') &&
        u.username === '' &&
        u.password === '';
      if (usable) webhookKey(row.url);
    } catch {
      usable = false;
    }
    if (!usable) {
      invalid++;
      continue;
    }
    const source = row.events ?? [];
    const mapped = [
      ...new Set(source.map(mapEvent).filter((e): e is CanonicalEvent => e !== undefined)),
    ];
    const dropped = source.filter((e) => mapEvent(e) === undefined);
    if (dropped.length > 0) {
      warnings.push({
        code: 'webhooks.unmapped-events',
        paths: [],
        params: { scope, events: dropped.sort() },
      });
    }
    hooks.push({
      url: row.url,
      events: mapped.sort(),
      active: row.active !== false,
      hasSecret: row.secret_set === true,
      verifyTls: row.skip_cert_verification !== true,
    });
  }
  if (invalid > 0) {
    warnings.push({ code: 'webhooks.invalid-url', paths: [], params: { scope, count: invalid } });
  }
  return { hooks, warnings };
}

/**
 * Hooks whose normalized URL is the same become one (ADR-0088): events are united, `active` and
 * `hasSecret` hold if any hook has them, `verifyTls` only if all do. Mirrors the facet helper,
 * which adapters may not import (ADR-0223). The smallest raw URL stands for the group.
 */
export function mergeHooks(raw: readonly RawHook[]): {
  hooks: Array<RawHook & { key: string }>;
  warnings: AdapterWarning[];
} {
  const groups = new Map<string, RawHook[]>();
  for (const h of raw) {
    const key = webhookKey(h.url);
    groups.set(key, [...(groups.get(key) ?? []), h]);
  }
  const hooks: Array<RawHook & { key: string }> = [];
  const warnings: AdapterWarning[] = [];
  for (const [key, list] of groups) {
    const url = list.map((h) => h.url).sort()[0] as string;
    hooks.push({
      key,
      url,
      events: [...new Set(list.flatMap((h) => h.events))].sort(),
      active: list.some((h) => h.active),
      hasSecret: list.some((h) => h.hasSecret),
      verifyTls: list.every((h) => h.verifyTls),
    });
    if (list.length > 1) {
      warnings.push({
        code: 'webhooks.duplicate-url',
        paths: [formatFieldPath([itemSeg('hooks', 'key', key)])],
        params: { targetUrlDisplay: `${new URL(url).origin}/…`, count: list.length },
      });
    }
  }
  hooks.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { hooks, warnings };
}

// ---- deploy-keys (FAC-DKY-001) -----------------------------------------------------------------

export const deployKeyRow = obj({
  key: z.string(),
  label: z.string().nullish(),
  comment: z.string().nullish(),
});

/** `<type> <base64>`, comment stripped. */
export function normalizePublicKey(key: string): string | undefined {
  const parts = key.trim().split(/\s+/);
  const [type, body] = parts;
  if (type === undefined || body === undefined || type.startsWith('-----')) return undefined;
  return `${type} ${body}`;
}

/** Repository keys first, then project keys; a key on both appears once. All are read-only. */
export function mapDeployKeys(rows: readonly z.infer<typeof deployKeyRow>[]): {
  data: DeployKeys;
  skipped: number;
} {
  const seen = new Map<string, DeployKeys['keys'][number]>();
  let skipped = 0;
  for (const row of rows) {
    const publicKey = normalizePublicKey(row.key);
    if (publicKey === undefined) {
      skipped++;
      continue;
    }
    if (!seen.has(publicKey)) {
      seen.set(publicKey, { publicKey, title: row.label ?? row.comment ?? '', readOnly: true });
    }
  }
  return {
    data: { keys: [...seen.values()].sort((a, b) => (a.publicKey < b.publicKey ? -1 : 1)) },
    skipped,
  };
}

// ---- variables / secrets / environments --------------------------------------------------------

export const variableRow = obj({
  key: z.string(),
  value: z.string().nullish(),
  secured: z.boolean().optional(),
});
export type VariableRow = z.infer<typeof variableRow>;

const VALID_NAME = /^[^/\s\p{Cc}]+$/u;

/** Splits variables by `secured`; names the canonical model cannot hold are skipped and counted. */
export function splitVariables(
  scope: string,
  rows: readonly VariableRow[],
): {
  variables: { key: string; scope: string; name: string; value: string }[];
  secrets: { key: string; scope: string; name: string }[];
  skipped: string[];
} {
  const variables: { key: string; scope: string; name: string; value: string }[] = [];
  const secrets: { key: string; scope: string; name: string }[] = [];
  const skipped: string[] = [];
  for (const row of rows) {
    if (!VALID_NAME.test(row.key)) {
      skipped.push(scope);
      continue;
    }
    const key = `${scope}/${row.key}`;
    if (row.secured === true) secrets.push({ key, scope, name: row.key });
    else variables.push({ key, scope, name: row.key, value: row.value ?? '' });
  }
  return { variables, secrets, skipped };
}

export const environmentRow = obj({
  uuid: z.string(),
  name: z.string(),
  environment_type: obj({ name: z.string().optional() }).optional(),
});
export type EnvironmentRow = z.infer<typeof environmentRow>;

function envCategory(t: string | undefined): 'test' | 'staging' | 'production' | null {
  return t === 'test' || t === 'staging' || t === 'production' ? t : null;
}

export function mapEnvironments(rows: readonly EnvironmentRow[]): Environments {
  return {
    environments: rows
      .filter((e) => e.name !== '')
      .map((e) => {
        const t = e.environment_type?.name?.toLowerCase();
        return {
          name: e.name,
          category: envCategory(t),
          // Deployment branch restrictions are Premium: null on Standard.
          deploymentBranches: null,
        };
      })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  };
}

// ---- code-ownership, change-requests -----------------------------------------------------------

export const reviewerRow = obj({ user: obj({}).optional() });

/** FAC-COD: effective default reviewers become one entry with pattern `*`. */
export function mapCodeOwnership(rows: readonly z.infer<typeof reviewerRow>[]): CodeOwnership {
  const principals = entries(
    rows.map((r) => (r.user ? identityRef(r.user as Account) : undefined)),
  );
  return { owners: principals.length === 0 ? [] : [{ pattern: '*', principals }] };
}

export const pullRequestRow = obj({
  id: z.number(),
  title: z.string().nullish(),
  links: obj({ html: obj({ href: z.string() }).optional() }).optional(),
});

export function mapChangeRequests(rows: readonly z.infer<typeof pullRequestRow>[]): ChangeRequests {
  return {
    open: rows.map((p) => ({
      id: String(p.id),
      title: p.title ?? '',
      url: p.links?.html?.href ?? 'unavailable',
    })),
  };
}

// ---- pipelines ---------------------------------------------------------------------------------

export const PIPELINES_FILE = 'bitbucket-pipelines.yml';

export function pipelineFile(content: string): { path: string; sha256: string } {
  return { path: PIPELINES_FILE, sha256: sha256Hex(content) };
}
