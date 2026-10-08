/**
 * Facet definition, translation and comparison contracts (ADP-030, docs/spec/04-adapter-contract.md).
 *
 * Provider-neutral and I/O free. The few places where the spec names types owned by other packages
 * (the Zod schema, identity and group resolvers, route runtime, route index) are expressed as
 * minimal structural interfaces so `core` keeps no dependencies (ARC-012); the real objects satisfy
 * them. Decisions: docs/adr/0080-facet-engine-contract.md.
 */
import type { CollectionKeySpec } from './collections.ts';
import type { FieldPath } from './field-path.ts';
import type { RoutePolicies } from './policy.ts';
import type { FieldDecision, FieldDiff, Finding, PolicyKey } from './types.ts';

/** Kebab-case, globally unique (ADP-030). */
export type FacetKey = string;

export type FacetScope = 'repository' | 'endpoint';
export type FindingKind = 'blocker' | 'pre' | 'post' | 'warning';
export type CompletionMode = 'manual' | 'accept' | 'resolution' | 'parity';

export interface FindingCodeSpec {
  readonly kind: FindingKind;
  /** Only for `pre` and `post` tasks (LIF-006); defaults to `manual`. */
  readonly completion?: CompletionMode;
}

/** What `FacetDefinition.schema` needs to be: `z.ZodType<T>` satisfies it. */
export interface DocumentParser<T> {
  parse(data: unknown): T;
}

export type FieldSupport =
  | { readonly kind: 'supported' }
  | { readonly kind: 'readOnly' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'unsupported'; readonly note?: string }
  | { readonly kind: 'constrained'; readonly constraint: string };

export interface FacetCapability {
  readonly read: boolean;
  readonly write: boolean;
  readonly fields: Readonly<Record<FieldPath, FieldSupport>>;
}

/** A Facet that a Provider does not offer at all. */
export const NO_CAPABILITY: FacetCapability = Object.freeze({
  read: false,
  write: false,
  fields: Object.freeze({}),
});

/** A principal as it appears in canonical documents (`PrincipalRef`). */
export interface PrincipalRef {
  readonly kind: 'identity' | 'group';
  readonly id: string;
}

/** FAC-006: the outcome of resolving one source principal through the Route's mappings. */
export type PrincipalResolution =
  | { readonly status: 'mapped'; readonly principal: PrincipalRef }
  | { readonly status: 'excluded' }
  | { readonly status: 'pending_invite' }
  | { readonly status: 'unmapped' }
  | { readonly status: 'team_missing' };

export interface IdentityResolver {
  resolve(principal: PrincipalRef): PrincipalResolution;
}
export type GroupResolver = IdentityResolver;

/** Route configuration the facets read (naming, defaults); opaque to the engine. */
export type RouteRuntime = Readonly<Record<string, unknown>>;
/** Read-only cross-repository facts, e.g. usage counts; opaque to the engine. */
export type RouteIndex = Readonly<Record<string, unknown>>;

/** The part of `TranslateContext` that is the same for every Facet of one Analysis. */
export interface TranslateEnvironment {
  readonly identities: IdentityResolver;
  readonly groups: GroupResolver;
  readonly policies: RoutePolicies;
  readonly route: RouteRuntime;
  readonly routeIndex: RouteIndex;
}

export interface TranslateContext extends TranslateEnvironment {
  readonly sourceCaps: FacetCapability;
  readonly targetCaps: FacetCapability;
  /** Results for every facet in `dependsOn` that was translated (all of them, in registry order). */
  readonly deps: Readonly<Partial<Record<FacetKey, { source: unknown; desired: unknown }>>>;
}

export interface CompareContext {
  readonly targetCaps: FacetCapability;
  readonly route: RouteRuntime;
  readonly routeIndex: RouteIndex;
}

export interface TranslationResult<T> {
  readonly desired: T;
  /** One per non-exact field. */
  readonly decisions: FieldDecision[];
  readonly blockers: Finding[];
  readonly preTasks: Finding[];
  readonly postTasks: Finding[];
  readonly warnings: Finding[];
}

export interface FacetTaskRef {
  readonly code: string;
  readonly params: unknown;
}

export interface FacetDefinition<T> {
  readonly key: FacetKey;
  readonly scope: FacetScope;
  readonly schemaVersion: number;
  readonly schema: DocumentParser<T>;
  /** `none` writes no ParityResult (LIF-060). */
  readonly compareMode: 'full' | 'none';
  readonly collections: readonly CollectionKeySpec[];
  /** Arrays of primitives, compared as sorted sets (ADP-021). Addition to the spec shape. */
  readonly sets?: readonly string[];
  readonly dependsOn: readonly FacetKey[];
  /** `false` = detect-only: warnings only, never applied. */
  readonly inScope: boolean;
  normalize(data: T): T;
  translate(source: T, ctx: TranslateContext): TranslationResult<T>;
  compare(source: T, target: T, ctx: CompareContext): FieldDiff[];
  readonly findingCodes: Readonly<Record<string, FindingCodeSpec>>;
  readonly policyKeys: readonly PolicyKey[];
  isTaskSatisfied?(task: FacetTaskRef, target: T, parity: FieldDiff[]): boolean;
}

/** ADP-032: replaces `translate` for one (source type, target type, facet) triple. */
export interface PairOverride<T = unknown> {
  readonly source: string;
  readonly target: string;
  readonly facet: FacetKey;
  translate(source: T, ctx: TranslateContext): TranslationResult<T>;
}

export interface ProviderPair {
  readonly source: string;
  readonly target: string;
}
