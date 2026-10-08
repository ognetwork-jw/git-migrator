/**
 * The translate / compare harness (ADP-030, ADP-031, FAC-005, LIF-060, LIF-063).
 *
 * `translateFacet` runs one Facet's translation (the pair override if there is one, else the
 * definition's) under a harness that enforces the contract instead of trusting the Facet:
 * - the source and the result go through the schema, the Facet's `normalize` and ADP-021
 *   collection normalization; inputs are deep-frozen copies, so a `translate` that mutates its
 *   input throws, and a promise-returning `translate` is rejected (ADP-031);
 * - every finding code must be declared by the Facet with the matching kind; the engine owns
 *   `<facet>.accept-lossy`;
 * - decisions are validated, lossy ones resolved against the Route policies (applyLossyPolicies),
 *   and Expected Difference drafts generated (`lossy_accepted`, `unreadable_defaulted`).
 * `compareFacet` runs `compare`, validates and orders the diffs, and subtracts the masking
 * Expected Differences. Decisions: docs/adr/0080-facet-engine-contract.md, 0081-expected-differences.md.
 */
import { type DocumentSchema, flattenDocument, normalizeDocument } from './collections.ts';
import type {
  CompareContext,
  FacetCapability,
  FacetDefinition,
  FacetKey,
  FacetTaskRef,
  FindingKind,
  ProviderPair,
  TranslateContext,
  TranslateEnvironment,
  TranslationResult,
} from './facet-types.ts';
import { NO_CAPABILITY } from './facet-types.ts';
import {
  canonicalFieldPath,
  type FieldPath,
  isFieldPath,
  type PathSegment,
  parseFieldPath,
  patternForPath,
} from './field-path.ts';
import { canonicalize } from './jcs.ts';
import { compilePattern } from './pattern.ts';
import { applyLossyPolicies } from './policy.ts';
import { acceptLossyCode, type FacetRegistry } from './registry.ts';
import type { FieldDecision, FieldDiff, Finding } from './types.ts';
import { FIDELITIES } from './types.ts';

export type FacetEngineErrorCode =
  | 'invalid_source'
  | 'invalid_context'
  | 'invalid_actual'
  | 'invalid_result'
  | 'invalid_decision'
  | 'uncovered_decision'
  | 'invalid_finding'
  | 'invalid_diff'
  | 'invalid_expected_difference'
  | 'translate_failed'
  | 'detect_only_violation';

/** A Facet (or its input) broke the contract; always a bug or corrupt data, never a user error. */
export class FacetEngineError extends Error {
  readonly code: FacetEngineErrorCode;
  readonly facetKey: FacetKey;
  constructor(code: FacetEngineErrorCode, facetKey: FacetKey, message: string, cause?: unknown) {
    super(`facet ${facetKey}: ${message}`, cause === undefined ? undefined : { cause });
    this.name = 'FacetEngineError';
    this.code = code;
    this.facetKey = facetKey;
  }
}

// -- Expected Differences ---------------------------------------------------------------------

export type ExpectedDifferenceReason =
  | 'framework_mutation'
  | 'overlay'
  | 'lossy_accepted'
  | 'identity_excluded'
  | 'manual_accepted'
  | 'unreadable_defaulted';

export const EXPECTED_DIFFERENCE_REASONS: readonly ExpectedDifferenceReason[] = [
  'framework_mutation',
  'overlay',
  'lossy_accepted',
  'identity_excluded',
  'manual_accepted',
  'unreadable_defaulted',
];

/** LIF-063: only these reasons hide a diff; the others document why `desired` differs from the source. */
export const MASKING_REASONS: ReadonlySet<ExpectedDifferenceReason> = new Set([
  'framework_mutation',
  'identity_excluded',
  'manual_accepted',
]);

const MASKING_PRECEDENCE: readonly ExpectedDifferenceReason[] = [
  'framework_mutation',
  'identity_excluded',
  'manual_accepted',
];

/** LIF-063: a `framework_mutation` hides target extras only, i.e. diffs absent from `desired`. */
function canMask(reason: ExpectedDifferenceReason, diff: FieldDiff): boolean {
  return reason !== 'framework_mutation' || diff.desired === undefined;
}

/** A stored Expected Difference, as the engine needs it. */
export interface ExpectedDifferenceRecord {
  /** Opaque identity; returned with every masked diff (ParityResult.excluded). */
  readonly id?: string;
  readonly facetKey: FacetKey;
  /** A path pattern (ADP-020). */
  readonly path: string;
  readonly reason: ExpectedDifferenceReason;
  readonly note?: string | null;
  /** `null` or absent: Route-wide. Otherwise the Migration the record belongs to; it only applies
   * to calls made with the same `migrationId`. */
  readonly migrationId?: string | null;
  /** Revoked records are inactive. */
  readonly revokedAt?: unknown;
}

/** An Expected Difference the Analysis should record (deduplicated per Route, facet and path). */
export interface ExpectedDifferenceDraft {
  readonly facetKey: FacetKey;
  readonly path: string;
  readonly reason: 'lossy_accepted' | 'unreadable_defaulted';
  readonly note: string;
}

function isActive(ed: ExpectedDifferenceRecord): boolean {
  return ed.revokedAt === undefined || ed.revokedAt === null;
}

/**
 * Caller contract: pass the Route's records and the Migration's own. A record applies when it is
 * active and either Route-wide (`migrationId` null/absent) or belongs to `migrationId`; records of
 * other Migrations never apply, and with no `migrationId` only Route-wide ones do.
 */
function applies(ed: ExpectedDifferenceRecord, migrationId: string | undefined): boolean {
  if (!isActive(ed)) return false;
  return ed.migrationId === undefined || ed.migrationId === null || ed.migrationId === migrationId;
}

type PathPredicate = (path: readonly PathSegment[]) => boolean;

function compileEd(facet: FacetKey, ed: ExpectedDifferenceRecord): PathPredicate {
  try {
    return compilePattern(ed.path);
  } catch (e) {
    throw new FacetEngineError(
      'invalid_expected_difference',
      facet,
      `bad pattern ${JSON.stringify(ed.path)}`,
      e,
    );
  }
}

// -- helpers ----------------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Only plain JSON is cloned. A Map, Set, Date or class instance would silently become `{}` through
 * `Object.entries`, losing data a Facet relies on (for example `routeIndex`), so it throws instead.
 */
function deepClone<V>(value: V): V {
  if (Array.isArray(value)) return value.map(deepClone) as V;
  if (isObject(value)) {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError(
        `only plain JSON objects and arrays can be passed to a Facet (got ${proto.constructor?.name ?? 'an object with a custom prototype'})`,
      );
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepClone(v)])) as V;
  }
  return value;
}

function deepFreeze<V>(value: V): V {
  if (isObject(value) && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** A frozen deep copy: the harness hands these to Facet code so mutation fails loudly. */
function frozenCopy<V>(value: V): V {
  return deepFreeze(deepClone(value));
}

function docSchemaOf(def: FacetDefinition<unknown>): DocumentSchema {
  return { collections: def.collections, sets: def.sets ?? [] };
}

/** schema -> the Facet's `normalize` -> ADP-021 normalization. The result is a fresh copy. */
function normalizeFacetDocument(
  def: FacetDefinition<unknown>,
  data: unknown,
  code: 'invalid_source' | 'invalid_actual' | 'invalid_result',
): unknown {
  try {
    const parsed = deepClone(def.schema.parse(data));
    return normalizeDocument(deepClone(def.normalize(parsed)), docSchemaOf(def));
  } catch (e) {
    if (e instanceof FacetEngineError) throw e;
    throw new FacetEngineError(
      code,
      def.key,
      `the document is not valid: ${(e as Error).message}`,
      e,
    );
  }
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalPathOf(
  facet: FacetKey,
  code: FacetEngineErrorCode,
  path: unknown,
  allowRoot: boolean,
): FieldPath {
  if (typeof path !== 'string' || !isFieldPath(path) || (path === '' && !allowRoot)) {
    throw new FacetEngineError(code, facet, `invalid field path ${JSON.stringify(path)}`);
  }
  return canonicalFieldPath(path);
}

// -- translate --------------------------------------------------------------------------------

export interface TranslateInput {
  readonly env: TranslateEnvironment;
  readonly sourceCaps?: FacetCapability;
  readonly targetCaps?: FacetCapability;
  /** Already-translated dependencies (see `translateAll`). */
  readonly deps?: TranslateContext['deps'];
  /** The Provider pair; selects a registered override (ADP-032). */
  readonly pair?: ProviderPair;
  /** The Migration being analyzed; selects which migration-scoped records apply. */
  readonly migrationId?: string;
  /** Expected Differences of the Route and of this Migration (see `applies`). */
  readonly expectedDifferences?: readonly ExpectedDifferenceRecord[];
}

/** A validated finding with the metadata the plan needs. */
export interface TranslatedFinding extends Finding {
  readonly kind: FindingKind;
  readonly verifiable: boolean;
}

export interface FacetTranslation {
  readonly facetKey: FacetKey;
  /** The normalized source document. */
  readonly source: unknown;
  /** The normalized desired target document. */
  readonly desired: unknown;
  /** Canonical paths, `accepted` resolved, sorted by path; `exact` decisions are dropped. */
  readonly decisions: FieldDecision[];
  readonly blockers: TranslatedFinding[];
  /** Includes the engine's `<facet>.accept-lossy` tasks. */
  readonly preTasks: TranslatedFinding[];
  readonly postTasks: TranslatedFinding[];
  readonly warnings: TranslatedFinding[];
  /** To record once per Route (`lossy_accepted`) or per Analysis (`unreadable_defaulted`). */
  readonly expectedDifferences: ExpectedDifferenceDraft[];
  /** `true` when a pair override produced the result. */
  readonly overridden: boolean;
}

const KIND_LISTS: readonly [FindingKind, keyof TranslationResult<unknown>][] = [
  ['blocker', 'blockers'],
  ['pre', 'preTasks'],
  ['post', 'postTasks'],
  ['warning', 'warnings'],
];

function validateFindings(
  def: FacetDefinition<unknown>,
  kind: FindingKind,
  list: unknown,
): TranslatedFinding[] {
  if (!Array.isArray(list)) {
    throw new FacetEngineError('invalid_result', def.key, `${kind} findings must be an array`);
  }
  return list.map((f: Finding) => {
    if (!isObject(f) || typeof f.code !== 'string') {
      throw new FacetEngineError('invalid_finding', def.key, 'a finding needs a code');
    }
    const spec = def.findingCodes[f.code];
    if (spec === undefined) {
      throw new FacetEngineError('invalid_finding', def.key, `undeclared finding code ${f.code}`);
    }
    if (f.code === acceptLossyCode(def.key)) {
      throw new FacetEngineError(
        'invalid_finding',
        def.key,
        `${f.code} is produced by the engine from lossy decisions, not by translate`,
      );
    }
    if (spec.kind !== kind) {
      throw new FacetEngineError(
        'invalid_finding',
        def.key,
        `${f.code} is declared as ${spec.kind} but was returned as ${kind}`,
      );
    }
    if (!Array.isArray(f.paths) || !isObject(f.params) || Array.isArray(f.params)) {
      throw new FacetEngineError('invalid_finding', def.key, `${f.code} needs paths and params`);
    }
    try {
      canonicalize(f.params);
    } catch (e) {
      throw new FacetEngineError(
        'invalid_finding',
        def.key,
        `${f.code} params: ${(e as Error).message}`,
        e,
      );
    }
    const verifiable = spec.completion === 'parity';
    if (f.verifiable !== undefined && f.verifiable !== verifiable) {
      throw new FacetEngineError(
        'invalid_finding',
        def.key,
        `${f.code} verifiable=${f.verifiable} contradicts its completion mode`,
      );
    }
    const paths = [
      ...new Set(f.paths.map((p) => canonicalPathOf(def.key, 'invalid_finding', p, true))),
    ].sort(compareCodeUnits);
    return { code: f.code, paths, params: deepClone(f.params), kind, verifiable };
  });
}

function validateDecisions(
  def: FacetDefinition<unknown>,
  list: unknown,
  migrationAccepts: ReadonlyMap<string, readonly PathPredicate[]>,
  acceptedKeys: ReadonlySet<string>,
): FieldDecision[] {
  if (!Array.isArray(list)) {
    throw new FacetEngineError('invalid_result', def.key, 'decisions must be an array');
  }
  const seen = new Set<string>();
  return list.map((d: FieldDecision) => {
    if (!isObject(d) || !FIDELITIES.includes(d.fidelity)) {
      throw new FacetEngineError('invalid_decision', def.key, 'a decision needs a known fidelity');
    }
    const path = canonicalPathOf(def.key, 'invalid_decision', d.path, d.fidelity === 'unreadable');
    if (seen.has(path)) {
      throw new FacetEngineError('invalid_decision', def.key, `two decisions for ${path}`);
    }
    seen.add(path);
    if (d.fidelity === 'lossy') {
      if (d.policyKey === undefined || !def.policyKeys.includes(d.policyKey)) {
        throw new FacetEngineError(
          'invalid_decision',
          def.key,
          `lossy decision at ${path} needs one of the facet's policy keys`,
        );
      }
    } else if (d.policyKey !== undefined) {
      throw new FacetEngineError(
        'invalid_decision',
        def.key,
        `only lossy decisions carry a policy key (${path})`,
      );
    }
    if (
      d.defaulted !== undefined &&
      (d.fidelity !== 'unreadable' || typeof d.defaulted !== 'boolean')
    ) {
      throw new FacetEngineError(
        'invalid_decision',
        def.key,
        `defaulted only applies to unreadable decisions (${path})`,
      );
    }
    // A Facet cannot accept its own lossy decision: acceptance comes from the Route policies or
    // from a done accept task, so `accepted` is recomputed here.
    let accepted: FieldDecision['accepted'] = false;
    if (d.fidelity === 'lossy' && !acceptedKeys.has(d.policyKey as string)) {
      const key = d.policyKey as string;
      const segments = parseFieldPath(path);
      if (migrationAccepts.get(key)?.some((covers) => covers(segments))) accepted = 'migration';
    }
    return { ...d, path, accepted };
  });
}

/**
 * Fail closed: an `unsupported` decision, or an `unreadable` one without a Route default, must be
 * covered by a finding on the same path, or on an ancestor or descendant of it; otherwise the
 * Analysis would silently drop the difference.
 */
function checkCovered(
  def: FacetDefinition<unknown>,
  decisions: readonly FieldDecision[],
  findings: readonly TranslatedFinding[],
): void {
  const paths = findings.flatMap((f) => f.paths);
  for (const d of decisions) {
    const needsFinding =
      d.fidelity === 'unsupported' || (d.fidelity === 'unreadable' && d.defaulted !== true);
    if (!needsFinding) continue;
    const mine = parseFieldPath(d.path);
    const covered = paths.some((fp) => {
      if (fp === '' || d.path === '') return true;
      const theirs = parseFieldPath(fp);
      const [short, long] = theirs.length <= mine.length ? [theirs, mine] : [mine, theirs];
      return short.every(
        (sg, i) =>
          sg.name === long[i]?.name &&
          sg.key?.field === long[i]?.key?.field &&
          sg.key?.value === long[i]?.key?.value,
      );
    });
    if (!covered) {
      throw new FacetEngineError(
        'uncovered_decision',
        def.key,
        `${d.fidelity} decision at ${JSON.stringify(d.path)} has no finding covering its path`,
      );
    }
  }
}

function detectOnlyCheck(def: FacetDefinition<unknown>, r: TranslationResult<unknown>): void {
  const offending =
    r.blockers.length + r.preTasks.length + r.postTasks.length > 0 ||
    r.decisions.some((d) => d.fidelity === 'lossy');
  if (offending) {
    throw new FacetEngineError(
      'detect_only_violation',
      def.key,
      'a detect-only facet (inScope: false) may only emit warnings',
    );
  }
}

/** Translates one Facet. See the module comment for what the harness enforces. */
export function translateFacet(
  registry: FacetRegistry,
  facetKey: FacetKey,
  source: unknown,
  input: TranslateInput,
): FacetTranslation {
  const def = registry.get(facetKey);
  const override = input.pair === undefined ? undefined : registry.override(input.pair, facetKey);
  const normalizedSource = normalizeFacetDocument(def, source, 'invalid_source');

  const deps: Record<string, { source: unknown; desired: unknown }> = {};
  for (const [k, v] of Object.entries(input.deps ?? {})) {
    if (def.dependsOn.includes(k) && v !== undefined) {
      try {
        deps[k] = frozenCopy(v);
      } catch (e) {
        throw new FacetEngineError(
          'invalid_context',
          facetKey,
          `dependency ${k} must be plain JSON: ${(e as Error).message}`,
          e,
        );
      }
    }
  }
  // Everything the harness reads after `translate` is snapshotted here, and the facet only gets
  // frozen copies, so it cannot grant itself acceptance by mutating the context.
  let policies: TranslateContext['policies'];
  let ctx: TranslateContext;
  try {
    policies = frozenCopy(input.env.policies);
    ctx = {
      identities: input.env.identities,
      groups: input.env.groups,
      policies,
      route: frozenCopy(input.env.route),
      routeIndex: frozenCopy(input.env.routeIndex),
      sourceCaps: frozenCopy(input.sourceCaps ?? NO_CAPABILITY),
      targetCaps: frozenCopy(input.targetCaps ?? NO_CAPABILITY),
      deps: Object.freeze(deps),
    };
  } catch (e) {
    throw new FacetEngineError(
      'invalid_context',
      facetKey,
      `the translate context must be plain JSON: ${(e as Error).message}`,
      e,
    );
  }

  let raw: TranslationResult<unknown>;
  try {
    const frozen = frozenCopy(normalizedSource);
    raw = override === undefined ? def.translate(frozen, ctx) : override.translate(frozen, ctx);
  } catch (e) {
    throw new FacetEngineError(
      'translate_failed',
      facetKey,
      `translate threw: ${(e as Error).message} (translate must not mutate its inputs)`,
      e,
    );
  }
  if (!isObject(raw) || typeof (raw as { then?: unknown }).then === 'function') {
    throw new FacetEngineError(
      'translate_failed',
      facetKey,
      'translate must return a result synchronously (ADP-031)',
    );
  }

  const desired = normalizeFacetDocument(def, raw.desired, 'invalid_result');
  const policyAccepted = new Set(policies.acceptLossy);
  // Per-path acceptance (ADR-0081): only this Migration's own lossy_accepted records count.
  const migrationAccepts = new Map<string, PathPredicate[]>();
  for (const ed of input.expectedDifferences ?? []) {
    if (
      ed.facetKey !== facetKey ||
      ed.reason !== 'lossy_accepted' ||
      !applies(ed, input.migrationId) ||
      ed.migrationId === undefined ||
      ed.migrationId === null ||
      typeof ed.note !== 'string'
    ) {
      continue;
    }
    const list = migrationAccepts.get(ed.note) ?? [];
    list.push(compileEd(facetKey, ed));
    migrationAccepts.set(ed.note, list);
  }
  const decisions = validateDecisions(def, raw.decisions, migrationAccepts, policyAccepted);
  const lists = Object.fromEntries(
    KIND_LISTS.map(([kind, field]) => [kind, validateFindings(def, kind, raw[field])]),
  ) as Record<FindingKind, TranslatedFinding[]>;

  if (!def.inScope) detectOnlyCheck(def, { ...raw, decisions });
  checkCovered(def, decisions, Object.values(lists).flat());

  const resolution = applyLossyPolicies(facetKey, decisions, policies);
  // The task identity (paramsHash) includes the paths still needing acceptance, so a new lossy
  // path under an already-accepted policy key opens a new task instead of reusing the done one.
  const acceptTasks: TranslatedFinding[] = resolution.acceptTasks.map((t) => ({
    ...t,
    params: { policyKey: t.params.policyKey, paths: [...t.paths] },
    kind: 'pre',
    verifiable: false,
  }));

  const drafts: ExpectedDifferenceDraft[] = resolution.lossyAccepted.map((l) => ({
    facetKey,
    path: l.path,
    reason: 'lossy_accepted',
    note: l.note,
  }));
  const seenDraft = new Set<string>();
  for (const d of resolution.decisions) {
    if (d.fidelity !== 'unreadable' || d.defaulted !== true) continue;
    const path = patternForPath(d.path);
    if (path === '') {
      throw new FacetEngineError(
        'invalid_decision',
        facetKey,
        'a defaulted unreadable field needs a path',
      );
    }
    if (seenDraft.has(path)) continue;
    seenDraft.add(path);
    drafts.push({
      facetKey,
      path,
      reason: 'unreadable_defaulted',
      note: d.note ?? 'unreadable_defaulted',
    });
  }

  return {
    facetKey,
    source: normalizedSource,
    desired,
    decisions: resolution.decisions
      .filter((d) => d.fidelity !== 'exact')
      .sort((a, b) => compareCodeUnits(a.path, b.path)),
    blockers: lists.blocker,
    preTasks: [...lists.pre, ...acceptTasks],
    postTasks: lists.post,
    warnings: lists.warning,
    expectedDifferences: drafts,
    overridden: override !== undefined,
  };
}

export interface TranslateAllInput
  extends Omit<TranslateInput, 'sourceCaps' | 'targetCaps' | 'deps'> {
  /** Source documents by facet key. A registered facet with no entry is not translated. */
  readonly sources: Readonly<Partial<Record<FacetKey, unknown>>>;
  readonly sourceCaps?: Readonly<Partial<Record<FacetKey, FacetCapability>>>;
  readonly targetCaps?: Readonly<Partial<Record<FacetKey, FacetCapability>>>;
}

export interface TranslateAllResult {
  /** In registry dependency order. */
  readonly translations: FacetTranslation[];
  /** Registered facets without a source document, in dependency order. */
  readonly skipped: FacetKey[];
}

/**
 * Translates every Facet that has a source document, dependencies first, handing each Facet the
 * already-translated results of its `dependsOn` (a dependency that was skipped is absent from `deps`).
 */
export function translateAll(
  registry: FacetRegistry,
  input: TranslateAllInput,
): TranslateAllResult {
  const translations: FacetTranslation[] = [];
  const skipped: FacetKey[] = [];
  const byKey = new Map<FacetKey, FacetTranslation>();
  for (const def of registry.ordered()) {
    if (!Object.hasOwn(input.sources, def.key) || input.sources[def.key] === undefined) {
      skipped.push(def.key);
      continue;
    }
    const deps: Record<string, { source: unknown; desired: unknown }> = {};
    for (const dep of def.dependsOn) {
      const t = byKey.get(dep);
      if (t !== undefined) deps[dep] = { source: t.source, desired: t.desired };
    }
    const t = translateFacet(registry, def.key, input.sources[def.key], {
      env: input.env,
      sourceCaps: input.sourceCaps?.[def.key],
      targetCaps: input.targetCaps?.[def.key],
      deps,
      pair: input.pair,
      migrationId: input.migrationId,
      expectedDifferences: input.expectedDifferences,
    });
    byKey.set(def.key, t);
    translations.push(t);
  }
  return { translations, skipped };
}

// -- compare ----------------------------------------------------------------------------------

export type ParityStatus = 'equal' | 'different' | 'unverifiable';

export interface MaskedDiff {
  readonly diff: FieldDiff;
  readonly reason: ExpectedDifferenceReason;
  /** The pattern that masked it. */
  readonly pattern: string;
  /** `ExpectedDifferenceRecord.id` of the record that masked it (ParityResult.excluded). */
  readonly expectedDifferenceId?: string;
}

export interface FacetComparison {
  readonly facetKey: FacetKey;
  readonly status: ParityStatus;
  /** Diffs left after subtraction, sorted by path. */
  readonly diffs: FieldDiff[];
  /** Diffs hidden by a masking Expected Difference (LIF-063), sorted by path. */
  readonly masked: MaskedDiff[];
}

export interface CompareInput {
  /** The Migration being compared; selects which migration-scoped records apply. */
  readonly migrationId?: string;
  readonly ctx?: Partial<CompareContext>;
  readonly expectedDifferences?: readonly ExpectedDifferenceRecord[];
}

/**
 * Compares the desired document with the actual one (LIF-060). `actual === null` means the target
 * Facet could not be read: `unverifiable`. Returns `null` for `compareMode: 'none'`, which writes
 * no ParityResult. Only `framework_mutation`, `identity_excluded` and `manual_accepted` Expected
 * Differences subtract (LIF-063); a diff under a `lossy_accepted` or `unreadable_defaulted` record
 * is real drift and stays.
 */
export function compareFacet(
  registry: FacetRegistry,
  facetKey: FacetKey,
  desired: unknown,
  actual: unknown | null,
  input: CompareInput = {},
): FacetComparison | null {
  const def = registry.get(facetKey);
  if (def.compareMode === 'none') return null;
  if (actual === null) return { facetKey, status: 'unverifiable', diffs: [], masked: [] };

  const d = normalizeFacetDocument(def, desired, 'invalid_result');
  const a = normalizeFacetDocument(def, actual, 'invalid_actual');
  const ctx: CompareContext = {
    targetCaps: input.ctx?.targetCaps ?? NO_CAPABILITY,
    route: input.ctx?.route ?? {},
    routeIndex: input.ctx?.routeIndex ?? {},
  };
  let raw: FieldDiff[];
  try {
    raw = def.compare(frozenCopy(d), frozenCopy(a), ctx);
  } catch (e) {
    throw new FacetEngineError(
      'invalid_diff',
      facetKey,
      `compare threw: ${(e as Error).message}`,
      e,
    );
  }
  if (!Array.isArray(raw)) {
    throw new FacetEngineError(
      'invalid_diff',
      facetKey,
      'compare must return an array synchronously (ADP-031)',
    );
  }
  const byPath = new Map<FieldPath, FieldDiff>();
  for (const diff of raw) {
    if (!isObject(diff))
      throw new FacetEngineError('invalid_diff', facetKey, 'a diff must be an object');
    const path = canonicalPathOf(facetKey, 'invalid_diff', diff.path, true);
    if (byPath.has(path))
      throw new FacetEngineError('invalid_diff', facetKey, `two diffs for ${path}`);
    try {
      byPath.set(path, { path, desired: deepClone(diff.desired), actual: deepClone(diff.actual) });
    } catch (e) {
      throw new FacetEngineError(
        'invalid_diff',
        facetKey,
        `the values of the diff at ${path} must be plain JSON: ${(e as Error).message}`,
        e,
      );
    }
  }
  const sorted = [...byPath.values()].sort((x, y) => compareCodeUnits(x.path, y.path));

  // Deterministic credit: reason precedence, then pattern, then id, never input order. Each
  // pattern is compiled once, each diff path parsed once.
  const masking = (input.expectedDifferences ?? [])
    .filter(
      (ed) =>
        ed.facetKey === facetKey &&
        applies(ed, input.migrationId) &&
        MASKING_REASONS.has(ed.reason),
    )
    .sort(
      (a, b) =>
        MASKING_PRECEDENCE.indexOf(a.reason) - MASKING_PRECEDENCE.indexOf(b.reason) ||
        compareCodeUnits(a.path, b.path) ||
        compareCodeUnits(a.id ?? '', b.id ?? ''),
    )
    .map((ed) => ({ ed, covers: compileEd(facetKey, ed) }));
  const diffs: FieldDiff[] = [];
  const masked: MaskedDiff[] = [];
  for (const diff of sorted) {
    const segments = parseFieldPath(diff.path);
    const hit = masking.find(({ ed, covers }) => covers(segments) && canMask(ed.reason, diff));
    if (hit === undefined) diffs.push(diff);
    else {
      masked.push({
        diff,
        reason: hit.ed.reason,
        pattern: hit.ed.path,
        ...(hit.ed.id === undefined ? {} : { expectedDifferenceId: hit.ed.id }),
      });
    }
  }
  return { facetKey, status: diffs.length === 0 ? 'equal' : 'different', diffs, masked };
}

function leavesOf(doc: unknown, schema: DocumentSchema): Map<FieldPath, unknown> {
  const out = new Map<FieldPath, unknown>();
  for (const [path, value] of flattenDocument(doc, schema)) {
    // Empty collections and objects carry no information a leaf-by-leaf diff would miss.
    const empty = Array.isArray(value)
      ? value.length === 0
      : isObject(value) && Object.keys(value).length === 0;
    if (!empty) out.set(path, value);
  }
  return out;
}

/**
 * A structural diff for Facets without special comparison rules (both documents are normalized first): every leaf (primitive or
 * primitive set) that differs, or exists on one side only (`undefined` marks the absent side),
 * addressed by canonical field path, independent of array order.
 */
export function diffDocuments(
  desired: unknown,
  actual: unknown,
  schema: DocumentSchema,
): FieldDiff[] {
  const l = leavesOf(normalizeDocument(desired, schema), schema);
  const r = leavesOf(normalizeDocument(actual, schema), schema);
  const diffs: FieldDiff[] = [];
  for (const path of [...new Set([...l.keys(), ...r.keys()])].sort(compareCodeUnits)) {
    const dv = l.get(path);
    const av = r.get(path);
    if (l.has(path) && r.has(path) && canonicalize(dv) === canonicalize(av)) continue;
    diffs.push({ path, desired: dv, actual: av });
  }
  return diffs;
}

/**
 * LIF-061: the open tasks whose Facet reports them satisfied. Only tasks whose finding code has
 * completion `parity` are considered; `target` and `parity` are the Facet's normalized actual
 * document and its remaining diffs.
 */
export function satisfiedTasks<K extends FacetTaskRef>(
  registry: FacetRegistry,
  facetKey: FacetKey,
  tasks: readonly K[],
  target: unknown,
  parity: readonly FieldDiff[],
): K[] {
  const def = registry.get(facetKey);
  const predicate = def.isTaskSatisfied;
  if (predicate === undefined) return [];
  const doc = frozenCopy(normalizeFacetDocument(def, target, 'invalid_actual'));
  let diffs: FieldDiff[];
  try {
    diffs = frozenCopy([...parity]);
  } catch (e) {
    throw new FacetEngineError(
      'invalid_diff',
      facetKey,
      `the parity diffs must be plain JSON: ${(e as Error).message}`,
      e,
    );
  }
  return tasks.filter(
    (t) =>
      def.findingCodes[t.code]?.completion === 'parity' &&
      predicate.call(def, t, doc, diffs) === true,
  );
}
