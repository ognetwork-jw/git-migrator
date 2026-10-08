/**
 * Target-name resolution (LIF-030) and naming blockers (LIF-031).
 *
 * Pure: pipelines run over plain source values, limits are passed in structurally (the adapter
 * contract's `repositoryName` limit has this shape), and nothing here reads a clock or a store.
 * Decisions: docs/adr/0095-naming-semantics.md.
 */

import { RE2JS } from 're2js';

export type NamingInitVar = 'namespace' | 'repository' | 'group';
export type NamingInitOp = 'projectKey' | 'slug' | 'name';
export type NamingTransformOp = 'lowercase' | 'kebab' | 'truncate' | 'replace';

export type NamingStep =
  | { readonly var: NamingInitVar; readonly op: NamingInitOp }
  | { readonly var: string; readonly op: 'lowercase' | 'kebab' }
  | { readonly var: string; readonly op: 'truncate'; readonly arg?: number }
  | {
      readonly var: string;
      readonly op: 'replace';
      readonly pattern: string;
      readonly with: string;
    };

export interface NamingPipeline {
  readonly steps: readonly NamingStep[];
  readonly template: string;
}

/** One source object a pipeline can read. `key` is the Namespace key (absent for most objects). */
export interface NamingSourceObject {
  readonly key?: string | null;
  readonly slug: string;
  readonly name: string;
}

export interface NamingSource {
  readonly namespace?: NamingSourceObject;
  readonly repository?: NamingSourceObject;
  readonly group?: NamingSourceObject;
}

/** The target's `limits.repositoryName` (ADP contract) plus optional reserved-name lists. */
export interface NamingLimits {
  readonly maxLength: number;
  readonly pattern: RegExp;
  readonly caseInsensitiveUnique: boolean;
  /** Names that can never be used, compared case-insensitively. `.` and `..` are always reserved. */
  readonly reservedNames?: readonly string[];
  /** Name suffixes that can never be used, compared case-insensitively. */
  readonly reservedSuffixes?: readonly string[];
}

export type NamingIssueReason =
  | 'pipeline'
  | 'empty'
  | 'too-long'
  | 'invalid-characters'
  | 'reserved-name'
  | 'reserved-suffix';

/** `naming.invalid` (LIF-031). `reason` and `params` are stable data for guidance templating. */
export interface NamingIssue {
  readonly code: 'naming.invalid';
  readonly reason: NamingIssueReason;
  readonly message: string;
  readonly params: Readonly<Record<string, string | number>>;
}

export type NamingResult =
  | { readonly ok: true; readonly name: string }
  | { readonly ok: false; readonly issues: readonly NamingIssue[] };

const INIT_VARS: readonly string[] = ['namespace', 'repository', 'group'];
const INIT_OPS: readonly string[] = ['projectKey', 'slug', 'name'];

export type PipelineCause =
  | 'missing-source'
  | 'uninitialized-variable'
  | 'bad-argument'
  | 'invalid-pattern'
  | 'unsafe-pattern'
  | 'unknown-op'
  | 'empty-result'
  | 'input-too-long'
  | 'edge-separator'
  | 'internal';

/** Replace-step bounds (ADR-0095): input is attacker-influenced, patterns are admin-authored. */
export const MAX_NAMING_INPUT_LENGTH = 256;
export const MAX_REPLACE_PATTERN_LENGTH = 200;
export const MAX_REPLACE_WITH_LENGTH = 200;

class PipelineError extends Error {
  constructor(
    message: string,
    readonly cause_: PipelineCause,
    readonly extra: Record<string, string | number> = {},
  ) {
    super(message);
  }
}

/**
 * Compiles a `replace` pattern on the linear-time RE2 engine (ReDoS-safe by construction: no
 * back references, no lookarounds). Returns the compiled pattern or a problem description.
 * Also enforces the pattern and replacement length caps and rejects the empty pattern.
 */
export function compileReplacePattern(
  pattern: string,
  replacement = '',
): { readonly ok: true; readonly re: RE2JS } | { readonly ok: false; readonly problem: string } {
  if (pattern === '') return { ok: false, problem: 'the pattern is empty' };
  if ([...pattern].length > MAX_REPLACE_PATTERN_LENGTH) {
    return {
      ok: false,
      problem: `the pattern is longer than ${MAX_REPLACE_PATTERN_LENGTH} characters`,
    };
  }
  if ([...replacement].length > MAX_REPLACE_WITH_LENGTH) {
    return {
      ok: false,
      problem: `the replacement is longer than ${MAX_REPLACE_WITH_LENGTH} characters`,
    };
  }
  let re: RE2JS;
  try {
    re = RE2JS.compile(pattern);
  } catch (e) {
    return {
      ok: false,
      problem: `not valid RE2 syntax (${e instanceof Error ? e.message : 'error'})`,
    };
  }
  const groups = re.groupCount();
  const names = re.namedGroups();
  for (const m of replacement.matchAll(/\$(?:\$|(\d+)|<([^>]*)>)/g)) {
    const [ref, digits, name] = m;
    if (digits !== undefined && (Number(digits) < 1 || Number(digits) > groups)) {
      return {
        ok: false,
        problem: `the replacement refers to group ${digits} but the pattern has ${groups}`,
      };
    }
    if (name !== undefined && !Object.hasOwn(names, name)) {
      return { ok: false, problem: `the replacement refers to unknown group "${name}" (${ref})` };
    }
  }
  return { ok: true, re };
}

/** Returns a problem description, or `null` when the pattern and replacement are acceptable. */
export function validateReplacePattern(pattern: string, replacement = ''): string | null {
  const c = compileReplacePattern(pattern, replacement);
  return c.ok ? null : c.problem;
}

function issue(
  reason: NamingIssueReason,
  message: string,
  params: Record<string, string | number> = {},
): NamingIssue {
  return { code: 'naming.invalid', reason, message, params };
}

/** `kebab`: lowercase, runs of characters outside `[a-z0-9]` become `-`, trim `-` at both ends. */
export function kebab(value: string): string {
  const dashed = value.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  let start = 0;
  let end = dashed.length;
  while (start < end && dashed[start] === '-') start++;
  while (end > start && dashed[end - 1] === '-') end--;
  return dashed.slice(start, end);
}

function applyStep(vars: Map<string, string>, step: NamingStep, source: NamingSource): void {
  const op = step.op as string;
  const set = (value: string): void => {
    if (value === '') {
      throw new PipelineError(`variable "${step.var}" is empty after "${op}"`, 'empty-result', {
        variable: step.var,
        op,
      });
    }
    if ([...value].length > MAX_NAMING_INPUT_LENGTH) {
      throw new PipelineError(
        `variable "${step.var}" is longer than ${MAX_NAMING_INPUT_LENGTH} characters after "${op}"`,
        'input-too-long',
        { variable: step.var, op, max: MAX_NAMING_INPUT_LENGTH },
      );
    }
    vars.set(step.var, value);
  };
  if (INIT_OPS.includes(op)) {
    if (!INIT_VARS.includes(step.var)) {
      throw new PipelineError(
        `op "${op}" can only initialize namespace, repository or group, not "${step.var}"`,
        'bad-argument',
        { variable: step.var, op },
      );
    }
    const obj = source[step.var as NamingInitVar];
    if (obj === undefined)
      throw new PipelineError(`the source has no ${step.var}`, 'missing-source', {
        variable: step.var,
        op,
      });
    const value = op === 'projectKey' ? obj.key : op === 'slug' ? obj.slug : obj.name;
    if (value === undefined || value === null || value === '') {
      throw new PipelineError(
        `the ${step.var} has no ${op === 'projectKey' ? 'key' : op}`,
        'missing-source',
        {
          variable: step.var,
          op,
        },
      );
    }
    if ([...value].length > MAX_NAMING_INPUT_LENGTH) {
      throw new PipelineError(
        `the ${step.var} ${op} is longer than ${MAX_NAMING_INPUT_LENGTH} characters`,
        'input-too-long',
        { variable: step.var, op, max: MAX_NAMING_INPUT_LENGTH },
      );
    }
    vars.set(step.var, value);
    return;
  }
  const current = vars.get(step.var);
  if (current === undefined) {
    throw new PipelineError(
      `variable "${step.var}" is used by "${op}" before it is initialized`,
      'uninitialized-variable',
      {
        variable: step.var,
        op,
      },
    );
  }
  switch (step.op) {
    case 'lowercase':
      set(current.toLowerCase());
      return;
    case 'kebab':
      set(kebab(current));
      return;
    case 'truncate': {
      const n = step.arg;
      if (n === undefined || !Number.isInteger(n) || n < 1) {
        throw new PipelineError('truncate needs an integer arg of at least 1', 'bad-argument', {
          variable: step.var,
          op,
        });
      }
      set([...current].slice(0, n).join(''));
      return;
    }
    case 'replace': {
      const c = compileReplacePattern(step.pattern, step.with);
      if (!c.ok) {
        throw new PipelineError(
          `replace pattern "${step.pattern}" is not allowed: ${c.problem}`,
          'unsafe-pattern',
          { variable: step.var },
        );
      }
      set(c.re.matcher(current).replaceAll(step.with));
      return;
    }
    default:
      throw new PipelineError(`unknown op "${op}"`, 'unknown-op', { variable: step.var, op });
  }
}

const EDGE_SEPARATOR = /^[-_.]|[-_.]$/;

/** Runs a pipeline over a source. Throws nothing: pipeline faults are `reason: 'pipeline'` issues. */
export function runNamingPipeline(
  pipeline: NamingPipeline,
  source: NamingSource,
):
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly issue: NamingIssue } {
  try {
    const vars = new Map<string, string>();
    for (const step of pipeline.steps) applyStep(vars, step, source);
    const value = pipeline.template.replace(/\{([^{}]*)\}/g, (_m, name: string) => {
      const v = vars.get(name);
      if (v === undefined) {
        throw new PipelineError(
          `template uses variable "{${name}}" which is not initialized`,
          'uninitialized-variable',
          {
            variable: name,
          },
        );
      }
      return v;
    });
    if (EDGE_SEPARATOR.test(value)) {
      throw new PipelineError(
        `the generated name "${value}" starts or ends with a separator`,
        'edge-separator',
        { name: value },
      );
    }
    return { ok: true, value };
  } catch (e) {
    if (e instanceof PipelineError) {
      return { ok: false, issue: issue('pipeline', e.message, { cause: e.cause_, ...e.extra }) };
    }
    return {
      ok: false,
      issue: issue('pipeline', e instanceof Error ? e.message : 'unexpected error', {
        cause: 'internal',
      }),
    };
  }
}

function stripStateful(re: RegExp): RegExp {
  return re.global || re.sticky ? new RegExp(re.source, re.flags.replace(/[gy]/g, '')) : re;
}

/** Validates a computed name against the target's limits. Reports every violated rule. */
export function validateTargetName(name: string, limits: NamingLimits): NamingResult {
  const issues: NamingIssue[] = [];
  const length = [...name].length;
  const lower = name.normalize('NFKC').toLowerCase();
  if (length === 0) issues.push(issue('empty', 'The target name is empty.'));
  if (length > limits.maxLength) {
    issues.push(
      issue(
        'too-long',
        `The target name has ${length} characters; the limit is ${limits.maxLength}.`,
        {
          length,
          maxLength: limits.maxLength,
        },
      ),
    );
  }
  if (length > 0 && !stripStateful(limits.pattern).test(name)) {
    const bad = [...new Set([...name].filter((ch) => !stripStateful(limits.pattern).test(ch)))];
    issues.push(
      issue(
        'invalid-characters',
        `The target name "${name}" contains characters the target does not allow.`,
        {
          name,
          characters: bad.join(''),
        },
      ),
    );
  }
  const reserved = ['.', '..', ...(limits.reservedNames ?? [])].map((r) => r.toLowerCase());
  if (reserved.includes(lower)) {
    issues.push(issue('reserved-name', `"${name}" is a reserved name.`, { name }));
  }
  const suffix = ['.git', ...(limits.reservedSuffixes ?? [])].find(
    (s) => s !== '' && lower.endsWith(s.toLowerCase()),
  );
  if (suffix !== undefined) {
    issues.push(
      issue('reserved-suffix', `The target name must not end with "${suffix}".`, { name, suffix }),
    );
  }
  return issues.length === 0 ? { ok: true, name } : { ok: false, issues };
}

/** Naming configuration that applies to one repository, in precedence order (LIF-030). */
export interface NamingRules {
  /** Repository-scope literal target name. */
  readonly override?: string | null;
  readonly repositoryPipeline?: NamingPipeline | null;
  readonly namespacePipeline?: NamingPipeline | null;
  /** `routes[].defaults.naming`. */
  readonly routeDefault: NamingPipeline;
}

export type NamingRuleSource = 'override' | 'repository' | 'namespace' | 'default';

/** The rule that applies: override > repository pipeline > namespace pipeline > Route default. */
export function selectNamingRule(
  rules: NamingRules,
):
  | { readonly source: 'override'; readonly override: string }
  | { readonly source: Exclude<NamingRuleSource, 'override'>; readonly pipeline: NamingPipeline } {
  if (rules.override !== undefined && rules.override !== null && rules.override !== '') {
    return { source: 'override', override: rules.override };
  }
  if (rules.repositoryPipeline) return { source: 'repository', pipeline: rules.repositoryPipeline };
  if (rules.namespacePipeline) return { source: 'namespace', pipeline: rules.namespacePipeline };
  return { source: 'default', pipeline: rules.routeDefault };
}

export type PlannedName = (
  | { readonly ok: true; readonly name: string }
  | { readonly ok: false; readonly issues: readonly NamingIssue[] }
) & { readonly ruleSource: NamingRuleSource };

/** Resolves and validates the planned target name (`Migration.plannedTargetName`). */
export function resolveTargetName(
  rules: NamingRules,
  source: NamingSource,
  limits: NamingLimits,
): PlannedName {
  const rule = selectNamingRule(rules);
  if (rule.source === 'override')
    return { ...validateTargetName(rule.override, limits), ruleSource: 'override' };
  const run = runNamingPipeline(rule.pipeline, source);
  if (!run.ok) return { ok: false, issues: [run.issue], ruleSource: rule.source };
  return { ...validateTargetName(run.value, limits), ruleSource: rule.source };
}

/**
 * Uniqueness key. Case-insensitive targets fold case (lowercase, NFKC, upper then lower so that
 * `ß` and `SS` meet, NFKC again); case-sensitive targets only normalize. A trailing `.git` is
 * dropped first because the target treats `repo` and `repo.git` as the same repository.
 */
export function collisionKey(name: string, caseInsensitive = true): string {
  const n = name.normalize('NFKC');
  const stripped =
    (caseInsensitive ? /\.git$/i : /\.git$/).test(n) && n.length > 4 ? n.slice(0, -4) : n;
  if (!caseInsensitive) return stripped;
  return stripped.toLowerCase().normalize('NFKC').toUpperCase().toLowerCase().normalize('NFKC');
}

export interface NameClaim {
  readonly id: string;
  readonly name: string;
}

export interface CollisionGroup {
  /** The shared uniqueness key. */
  readonly key: string;
  /** Every member, sorted by id. */
  readonly members: readonly NameClaim[];
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Every group of two or more claims whose names collide. Deterministic: sorted by key, members by id. */
export function detectCollisions(
  claims: readonly NameClaim[],
  caseInsensitive = true,
): CollisionGroup[] {
  const groups = new Map<string, NameClaim[]>();
  for (const claim of claims) {
    const key = collisionKey(claim.name, caseInsensitive);
    const list = groups.get(key);
    if (list) list.push(claim);
    else groups.set(key, [claim]);
  }
  return [...groups]
    .filter(([, m]) => m.length > 1)
    .map(([key, members]) => ({ key, members: [...members].sort((a, b) => byString(a.id, b.id)) }))
    .sort((a, b) => byString(a.key, b.key));
}

export interface ExistingTarget {
  readonly id: string;
  readonly name: string;
  /** The target has at least one ref. */
  readonly hasRefs: boolean;
}

export type TargetExistsResult =
  | { readonly kind: 'none' }
  /** The target is this Migration's own (`targetRepositoryId`); never raises `target.exists-*`. */
  | { readonly kind: 'owned'; readonly target: ExistingTarget }
  /**
   * Blocks. Also the fail-safe result when several existing targets share the planned name's key
   * (`ambiguous`), and when the Migration owns a target but the planned name is held by a
   * different one (`ownedTargetId`).
   */
  | {
      readonly kind: 'exists-nonempty';
      readonly target: ExistingTarget;
      readonly ambiguous?: true;
      readonly ownedTargetId?: string;
    }
  | { readonly kind: 'exists-foreign-adopted'; readonly target: ExistingTarget };

/**
 * Classifies the planned name against existing target repositories (LIF-031, analysis step 3):
 * find by `targetRepositoryId` when set (falling back to the name when it is not found), else by
 * collision key. An owned target never hides a different repository that holds the planned name.
 */
export function classifyExistingTarget(input: {
  readonly plannedName: string;
  readonly targetRepositoryId?: string | null;
  readonly existing: readonly ExistingTarget[];
  readonly caseInsensitive?: boolean;
}): TargetExistsResult {
  const ci = input.caseInsensitive ?? true;
  const id = input.targetRepositoryId ?? null;
  const owned = id === null ? undefined : input.existing.find((t) => t.id === id);
  const key = collisionKey(input.plannedName, ci);
  const matches = input.existing
    .filter((t) => t.id !== owned?.id && collisionKey(t.name, ci) === key)
    .sort((a, b) => byString(a.id, b.id));
  if (owned) {
    if (matches.length === 0) return { kind: 'owned', target: owned };
    return {
      kind: 'exists-nonempty',
      target: matches[0] as ExistingTarget,
      ownedTargetId: owned.id,
      ...(matches.length > 1 ? { ambiguous: true as const } : {}),
    };
  }
  const [target] = matches;
  if (!target) return { kind: 'none' };
  if (matches.length > 1) return { kind: 'exists-nonempty', target, ambiguous: true };
  return { kind: target.hasRefs ? 'exists-nonempty' : 'exists-foreign-adopted', target };
}

/**
 * A blocker or information item produced by naming (LIF-031). `params` holds data only; guidance
 * renders the text from `code` and `params` (no English sentences here).
 */
export interface NamingFinding {
  readonly code:
    | 'naming.invalid'
    | 'naming.collision'
    | 'target.exists-nonempty'
    | 'target.exists-foreign-adopted'
    | 'target.owned-by-other-migration';
  readonly severity: 'blocker' | 'info';
  readonly params: Readonly<Record<string, unknown>>;
}

export interface RouteNamingInput {
  readonly id: string;
  readonly source: NamingSource;
  readonly rules: NamingRules;
  readonly targetRepositoryId?: string | null;
}

export interface RouteNamingEntry {
  readonly id: string;
  /** Present when the name is valid. */
  readonly plannedName: string | null;
  readonly ruleSource: NamingRuleSource;
  readonly findings: readonly NamingFinding[];
  readonly blocked: boolean;
}

export interface RouteNamingPlan {
  readonly entries: readonly RouteNamingEntry[];
  readonly collisions: readonly CollisionGroup[];
}

/**
 * Names every Migration of a Route, finds every collision among them (all members blocked) and
 * classifies each name against existing target repositories (LIF-030, LIF-031). Invalid names take
 * no part in collisions: they are already blocked by `naming.invalid`. A target claimed by two
 * Migrations, or matched by name by a Migration other than its owner, raises
 * `target.owned-by-other-migration` for every Migration involved.
 */
export function planRouteNaming(
  migrations: readonly RouteNamingInput[],
  limits: NamingLimits,
  existing: readonly ExistingTarget[] = [],
): RouteNamingPlan {
  const resolved = migrations.map((m) => ({ m, r: resolveTargetName(m.rules, m.source, limits) }));
  const claims: NameClaim[] = [];
  for (const { m, r } of resolved) if (r.ok) claims.push({ id: m.id, name: r.name });
  const collisions = detectCollisions(claims, limits.caseInsensitiveUnique);
  const collisionOf = new Map<string, CollisionGroup>();
  for (const g of collisions) for (const member of g.members) collisionOf.set(member.id, g);

  const claimedBy = new Map<string, string[]>();
  for (const m of migrations) {
    if (m.targetRepositoryId === undefined || m.targetRepositoryId === null) continue;
    const list = claimedBy.get(m.targetRepositoryId) ?? [];
    list.push(m.id);
    claimedBy.set(m.targetRepositoryId, list);
  }
  const othersClaiming = (targetId: string, me: string): string[] =>
    (claimedBy.get(targetId) ?? []).filter((x) => x !== me).sort(byString);

  const entries = resolved.map(({ m, r }): RouteNamingEntry => {
    const findings: NamingFinding[] = [];
    const dupes = m.targetRepositoryId ? othersClaiming(m.targetRepositoryId, m.id) : [];
    if (m.targetRepositoryId && dupes.length > 0) {
      findings.push({
        code: 'target.owned-by-other-migration',
        severity: 'blocker',
        params: { targetId: m.targetRepositoryId, with: dupes },
      });
    }
    if (!r.ok) {
      for (const i of r.issues) {
        findings.push({
          code: 'naming.invalid',
          severity: 'blocker',
          params: { reason: i.reason, ...i.params },
        });
      }
      return { id: m.id, plannedName: null, ruleSource: r.ruleSource, findings, blocked: true };
    }
    const group = collisionOf.get(m.id);
    if (group) {
      findings.push({
        code: 'naming.collision',
        severity: 'blocker',
        params: { name: r.name, with: group.members.filter((x) => x.id !== m.id).map((x) => x.id) },
      });
    }
    const exists = classifyExistingTarget({
      plannedName: r.name,
      targetRepositoryId: m.targetRepositoryId,
      existing,
      caseInsensitive: limits.caseInsensitiveUnique,
    });
    if (exists.kind === 'exists-nonempty' || exists.kind === 'exists-foreign-adopted') {
      const owners = othersClaiming(exists.target.id, m.id);
      if (owners.length > 0) {
        findings.push({
          code: 'target.owned-by-other-migration',
          severity: 'blocker',
          params: { name: r.name, targetId: exists.target.id, with: owners },
        });
      } else if (exists.kind === 'exists-nonempty') {
        findings.push({
          code: 'target.exists-nonempty',
          severity: 'blocker',
          params: {
            name: r.name,
            targetId: exists.target.id,
            ...(exists.ambiguous ? { ambiguous: true } : {}),
            ...(exists.ownedTargetId ? { ownedTargetId: exists.ownedTargetId } : {}),
          },
        });
      } else {
        findings.push({
          code: 'target.exists-foreign-adopted',
          severity: 'info',
          params: { name: r.name, targetId: exists.target.id },
        });
      }
    }
    return {
      id: m.id,
      plannedName: r.name,
      ruleSource: r.ruleSource,
      findings,
      blocked: findings.some((f) => f.severity === 'blocker'),
    };
  });
  return { entries, collisions };
}
