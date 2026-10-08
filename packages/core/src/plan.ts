/**
 * Plan aggregation (LIF-020 step 5, LIF-040, LIF-004).
 *
 * Turns the per-Facet translations into the Plan: Steps in LIF-040 order, then Blockers, `pre` and
 * `post` Manual Tasks and Warnings. Output is a pure function of its inputs and independent of
 * their order: items are keyed by (facet, code, paramsHash), which is also the ManualTask identity
 * (LIF-020 step 6), so findings that collide on that key are merged (paths unioned) instead of
 * becoming two tasks. Decisions: docs/adr/0082-plan-aggregation.md.
 */

import type {
  ExpectedDifferenceDraft,
  FacetTranslation,
  TranslatedFinding,
} from './facet-engine.ts';
import type { CompletionMode, FacetCapability, FacetKey } from './facet-types.ts';
import { canonicalFieldPath } from './field-path.ts';
import { canonicalize, hashCanonical } from './jcs.ts';
import { deriveReadiness, type ReadinessResult } from './readiness.ts';
import { acceptLossyCode, type FacetLookup } from './registry.ts';
import type { Fidelity } from './types.ts';

export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanError';
  }
}

export type PlanItemKind = 'step' | 'blocker' | 'pre_task' | 'post_task' | 'warning';

/** `PlanItem` (docs/spec/03-domain-model.md) plus the data the persistence layer derives from it. */
export interface PlanItem {
  readonly kind: PlanItemKind;
  /** `null` for items that belong to no Facet (naming, target, framework steps). */
  readonly facetKey: FacetKey | null;
  readonly code: string;
  readonly fidelity?: Fidelity;
  readonly fieldPaths: string[];
  readonly params: Record<string, unknown>;
  /** sha256(JCS(params)): the ManualTask identity component (LIF-020). */
  readonly paramsHash: string;
  /** Position in the whole Plan: steps, then blockers, pre tasks, post tasks, warnings. */
  readonly order: number;
  readonly completion?: CompletionMode;
  readonly verifiable?: boolean;
}

/** A finding produced outside any Facet translation (naming, existing target, dependency blockers). */
export interface ExtraFinding {
  readonly kind: 'blocker' | 'pre' | 'post' | 'warning';
  readonly facetKey: FacetKey | null;
  readonly code: string;
  readonly paths?: readonly string[];
  readonly params?: Record<string, unknown>;
}

export type StepTemplateEntry =
  | { readonly key: string; readonly when?: string }
  | { readonly facet: FacetKey };

export interface StepTemplate {
  readonly entries: readonly StepTemplateEntry[];
  /** Facets applied by a fixed step rather than a `facet.<key>.apply` step. */
  readonly appliedElsewhere: readonly FacetKey[];
}

/** LIF-040 for a repository migrate / run-anyway / resync Run. */
export const REPOSITORY_STEP_TEMPLATE: StepTemplate = {
  entries: [
    { key: 'preflight' },
    { key: 'git.prepare' },
    { key: 'target.ensure-repository' },
    { key: 'target.lift-protection', when: 'liftProtection' },
    { key: 'git.push-lfs' },
    { key: 'git.push-refs' },
    { facet: 'repository-settings' },
    { facet: 'merge-settings' },
    { facet: 'access-control' },
    { facet: 'environments' },
    { facet: 'variables' },
    { facet: 'deploy-keys' },
    { key: 'change-requests.open', when: 'changeRequests' },
    { facet: 'branch-rules' },
    { facet: 'webhooks' },
    { key: 'overlays.apply', when: 'overlays' },
    { key: 'verify' },
    { key: 'source.read-only', when: 'sourceReadOnly' },
  ],
  appliedElsewhere: [
    'git-refs',
    'code-ownership',
    'pipelines',
    'change-requests',
    'secrets',
    'extras',
  ],
};

/** LIF-081: endpoint Run order. */
export const ENDPOINT_STEP_TEMPLATE: StepTemplate = {
  entries: [
    { facet: 'members' },
    { facet: 'teams' },
    { facet: 'org-variables' },
    { facet: 'org-webhooks' },
    { key: 'verify' },
  ],
  appliedElsewhere: ['org-secrets'],
};

export interface PlanInput {
  readonly registry: FacetLookup;
  readonly translations: readonly FacetTranslation[];
  readonly extraFindings?: readonly ExtraFinding[];
  /** Defaults to `REPOSITORY_STEP_TEMPLATE`. */
  readonly stepTemplate?: StepTemplate;
  /** Conditions named by `when` in the template; an entry whose condition is not set is omitted. */
  readonly flags?: ReadonlySet<string>;
  /** Target capabilities by facet; a facet whose target cannot be written gets no apply step. */
  readonly targetCaps: Readonly<Partial<Record<FacetKey, FacetCapability>>>;
}

export interface Plan {
  /** Steps, blockers, pre tasks, post tasks and warnings, each group in its deterministic order. */
  readonly items: PlanItem[];
  readonly steps: PlanItem[];
  readonly blockers: PlanItem[];
  readonly preTasks: PlanItem[];
  readonly postTasks: PlanItem[];
  readonly warnings: PlanItem[];
  /** Deduplicated by (facet, path, reason), sorted. */
  readonly expectedDifferences: ExpectedDifferenceDraft[];
  /** LIF-004 for the Analysis alone (every task counts as open; run-origin blockers are separate). */
  readonly readiness: ReadinessResult;
}

const CODE_UNIT = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function stepKey(entry: StepTemplateEntry): string {
  return 'facet' in entry ? `facet.${entry.facet}.apply` : entry.key;
}

function buildSteps(input: PlanInput): Omit<PlanItem, 'order'>[] {
  const template = input.stepTemplate ?? REPOSITORY_STEP_TEMPLATE;
  const flags = input.flags ?? new Set<string>();
  const translated = new Map(input.translations.map((t) => [t.facetKey, t]));

  const keys = new Set<string>();
  const listed = new Set<FacetKey>();
  for (const entry of template.entries) {
    const key = stepKey(entry);
    if (keys.has(key)) throw new PlanError(`step template lists ${key} twice`);
    keys.add(key);
    if ('facet' in entry) {
      listed.add(entry.facet);
    }
  }
  for (const f of template.appliedElsewhere) listed.add(f);

  const applies = (facet: FacetKey): boolean => {
    const t = translated.get(facet);
    if (t === undefined || !input.registry.get(facet).inScope) return false;
    return input.targetCaps[facet]?.write === true;
  };
  for (const t of input.translations) {
    if (applies(t.facetKey) && !listed.has(t.facetKey)) {
      throw new PlanError(`facet ${t.facetKey} is writable but no step applies it`);
    }
  }

  const steps: Omit<PlanItem, 'order'>[] = [];
  const position = new Map<FacetKey, number>();
  for (const entry of template.entries) {
    if ('facet' in entry) {
      if (!applies(entry.facet)) continue;
      position.set(entry.facet, steps.length);
      steps.push({
        kind: 'step',
        facetKey: entry.facet,
        code: stepKey(entry),
        fieldPaths: [],
        params: {},
        paramsHash: hashCanonical({}),
      });
    } else if (entry.when === undefined || flags.has(entry.when)) {
      steps.push({
        kind: 'step',
        facetKey: null,
        code: entry.key,
        fieldPaths: [],
        params: {},
        paramsHash: hashCanonical({}),
      });
    }
  }
  // A step must not run before the steps of the facets it depends on.
  for (const [facet, at] of position) {
    for (const dep of input.registry.get(facet).dependsOn) {
      const depAt = position.get(dep);
      if (depAt !== undefined && depAt > at) {
        throw new PlanError(`step facet.${facet}.apply is ordered before its dependency ${dep}`);
      }
    }
  }
  return steps;
}

interface Pending {
  kind: PlanItemKind;
  facetKey: FacetKey | null;
  code: string;
  params: Record<string, unknown>;
  paramsHash: string;
  paths: Set<string>;
  completion?: CompletionMode;
  verifiable?: boolean;
  fidelities: Set<Fidelity>;
}

const KIND_OF: Record<TranslatedFinding['kind'], PlanItemKind> = {
  blocker: 'blocker',
  pre: 'pre_task',
  post: 'post_task',
  warning: 'warning',
};

/** Builds the Plan from validated translations. Throws `PlanError` for an inconsistent input. */
export function buildPlan(input: PlanInput): Plan {
  if (input.targetCaps === undefined || input.targetCaps === null) {
    throw new PlanError('targetCaps is required: without it no facet could get an apply step');
  }
  const facetOrder = new Map(input.registry.ordered().map((d, i) => [d.key, i]));
  const seenFacets = new Set<FacetKey>();
  for (const t of input.translations) {
    if (!facetOrder.has(t.facetKey))
      throw new PlanError(`translation for unregistered facet ${t.facetKey}`);
    if (seenFacets.has(t.facetKey)) throw new PlanError(`two translations for facet ${t.facetKey}`);
    seenFacets.add(t.facetKey);
  }

  const pending = new Map<string, Pending>();
  const add = (
    kind: PlanItemKind,
    facetKey: FacetKey | null,
    code: string,
    paths: readonly string[],
    params: Record<string, unknown>,
    fidelityOf: (path: string) => Fidelity | undefined,
    extra: { completion?: CompletionMode; verifiable?: boolean },
  ): void => {
    let paramsHash: string;
    try {
      paramsHash = hashCanonical(params);
    } catch (e) {
      throw new PlanError(`${code}: params cannot be canonicalized: ${(e as Error).message}`);
    }
    const id = JSON.stringify([kind, facetKey, code, paramsHash]);
    let p = pending.get(id);
    if (p === undefined) {
      p = {
        kind,
        facetKey,
        code,
        // Key order must not leak into the output: keep the JCS form of the params.
        params: JSON.parse(canonicalize(params)),
        paramsHash,
        paths: new Set(),
        fidelities: new Set(),
        ...extra,
      };
      pending.set(id, p);
    }
    for (const path of paths) {
      p.paths.add(path);
      const f = fidelityOf(path);
      if (f !== undefined) p.fidelities.add(f);
    }
  };

  for (const t of input.translations) {
    const def = input.registry.get(t.facetKey);
    const byPath = new Map(t.decisions.map((d) => [d.path, d.fidelity]));
    for (const list of [t.blockers, t.preTasks, t.postTasks, t.warnings]) {
      for (const f of list) {
        const completion = def.findingCodes[f.code]?.completion;
        add(KIND_OF[f.kind], t.facetKey, f.code, f.paths, f.params, (p) => byPath.get(p), {
          ...(f.kind === 'pre' || f.kind === 'post' ? { completion: completion ?? 'manual' } : {}),
          ...(f.kind === 'pre' || f.kind === 'post' ? { verifiable: f.verifiable } : {}),
        });
      }
    }
  }
  for (const f of input.extraFindings ?? []) {
    if (f.facetKey !== null && !input.registry.has(f.facetKey)) {
      throw new PlanError(`finding ${f.code} names unregistered facet ${f.facetKey}`);
    }
    const task = f.kind === 'pre' || f.kind === 'post';
    let completion: CompletionMode = 'manual';
    if (f.facetKey !== null) {
      // A finding attributed to a facet must be one the facet declares, with its kind and
      // completion; core never invents a completion mode for a facet's code.
      const spec = input.registry.get(f.facetKey).findingCodes[f.code];
      if (!f.code.startsWith(`${f.facetKey}.`) || spec === undefined) {
        throw new PlanError(`finding ${f.code} is not declared by facet ${f.facetKey}`);
      }
      if (spec.kind !== f.kind) {
        throw new PlanError(`finding ${f.code} is declared as ${spec.kind}, not ${f.kind}`);
      }
      if (f.code === acceptLossyCode(f.facetKey)) {
        throw new PlanError(`${f.code} is produced by the engine from lossy decisions`);
      }
      completion = spec.completion ?? 'manual';
    }
    add(
      KIND_OF[f.kind],
      f.facetKey,
      f.code,
      (f.paths ?? []).map((p) => canonicalFieldPath(p)),
      f.params ?? {},
      () => undefined,
      task ? { completion, verifiable: completion === 'parity' } : {},
    );
  }

  const rank = (p: Pending): number =>
    p.facetKey === null ? -1 : (facetOrder.get(p.facetKey) as number);
  const finished = [...pending.values()].sort(
    (a, b) =>
      rank(a) - rank(b) || CODE_UNIT(a.code, b.code) || CODE_UNIT(a.paramsHash, b.paramsHash),
  );

  const groups: Record<'blocker' | 'pre_task' | 'post_task' | 'warning', PlanItem[]> = {
    blocker: [],
    pre_task: [],
    post_task: [],
    warning: [],
  };
  const steps: PlanItem[] = buildSteps(input).map((s, i) => ({ ...s, order: i }));
  let order = steps.length;
  for (const kind of ['blocker', 'pre_task', 'post_task', 'warning'] as const) {
    for (const p of finished.filter((x) => x.kind === kind)) {
      const fidelity = p.fidelities.size === 1 ? ([...p.fidelities][0] as Fidelity) : undefined;
      groups[kind].push({
        kind,
        facetKey: p.facetKey,
        code: p.code,
        ...(fidelity === undefined ? {} : { fidelity }),
        fieldPaths: [...p.paths].sort(CODE_UNIT),
        params: p.params,
        paramsHash: p.paramsHash,
        order: order++,
        ...(p.completion === undefined ? {} : { completion: p.completion }),
        ...(p.verifiable === undefined ? {} : { verifiable: p.verifiable }),
      });
    }
  }

  const drafts = new Map<string, ExpectedDifferenceDraft>();
  for (const t of input.translations) {
    for (const d of t.expectedDifferences) {
      const id = JSON.stringify([d.facetKey, d.path, d.reason]);
      if (!drafts.has(id)) drafts.set(id, d);
    }
  }
  const expectedDifferences = [...drafts.values()].sort(
    (a, b) =>
      (facetOrder.get(a.facetKey) as number) - (facetOrder.get(b.facetKey) as number) ||
      CODE_UNIT(a.path, b.path) ||
      CODE_UNIT(a.reason, b.reason),
  );

  const readiness = deriveReadiness({
    analysis: { blockers: groups.blocker, warnings: groups.warning.length },
    runBlockers: [],
    tasks: [
      ...groups.pre_task.map(() => ({ phase: 'pre' as const, status: 'open' as const })),
      ...groups.post_task.map(() => ({ phase: 'post' as const, status: 'open' as const })),
    ],
  });
  return {
    items: [
      ...steps,
      ...groups.blocker,
      ...groups.pre_task,
      ...groups.post_task,
      ...groups.warning,
    ],
    steps,
    blockers: groups.blocker,
    preTasks: groups.pre_task,
    postTasks: groups.post_task,
    warnings: groups.warning,
    expectedDifferences,
    readiness,
  };
}
