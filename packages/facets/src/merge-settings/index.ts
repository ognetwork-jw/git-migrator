/**
 * merge-settings facet (FAC-MRG). Pure: no I/O, no provider vocabulary (GLO-002).
 *
 * Decisions: docs/adr/0101-merge-settings-facet.md.
 */
import {
  MERGE_STRATEGIES,
  type MergeSettings,
  type MergeStrategy,
  mergeSettingsFacet,
} from '@git-migrator/canonical';
import {
  diffDocuments,
  type FacetDefinition,
  type FieldDecision,
  type FieldDiff,
  type TranslateContext,
  type TranslationResult,
} from '@git-migrator/core';

export const FF_ONLY_AS_REBASE = 'merge-settings.ff-only-as-rebase';

/** FAC-MRG-002: used when a field cannot be read and the Route configures nothing. */
export const BUILT_IN_DEFAULTS: Readonly<MergeSettings> = Object.freeze({
  allowed: ['merge-commit', 'squash', 'rebase'] as MergeStrategy[],
  deleteBranchOnMerge: true,
});

/** Target strategies: the three the target offers (FAC-MRG-001). */
function toTarget(strategy: MergeStrategy): MergeStrategy {
  return strategy === 'fast-forward-only' ? 'rebase' : strategy;
}

function sortedUnique(list: readonly MergeStrategy[]): MergeStrategy[] {
  return [...new Set(list)].sort(
    (a, b) => MERGE_STRATEGIES.indexOf(a) - MERGE_STRATEGIES.indexOf(b),
  );
}

/** `ctx.route.defaults.mergeSettings`, validated; the built-in default when it is absent. */
export function routeMergeDefaults(route: TranslateContext['route']): MergeSettings {
  const defaults = route.defaults;
  const configured =
    typeof defaults === 'object' && defaults !== null
      ? (defaults as Record<string, unknown>).mergeSettings
      : undefined;
  if (configured === undefined) {
    return { allowed: [...BUILT_IN_DEFAULTS.allowed], deleteBranchOnMerge: true };
  }
  const parsed = mergeSettingsFacet.schema.parse(configured);
  return {
    allowed: sortedUnique(parsed.allowed.map(toTarget)),
    deleteBranchOnMerge: parsed.deleteBranchOnMerge,
  };
}

export function translateMergeSettings(
  source: MergeSettings,
  ctx: TranslateContext,
): TranslationResult<MergeSettings> {
  const decisions: FieldDecision[] = [];
  const unreadable = (path: string) => ctx.sourceCaps.fields[path]?.kind === 'unreadable';
  const needDefaults = unreadable('/allowed') || unreadable('/deleteBranchOnMerge');
  const defaults = needDefaults ? routeMergeDefaults(ctx.route) : undefined;

  let allowed: MergeStrategy[];
  if (unreadable('/allowed') && defaults !== undefined) {
    allowed = defaults.allowed;
    decisions.push({
      path: '/allowed',
      fidelity: 'unreadable',
      defaulted: true,
      accepted: false,
      note: 'unreadable_defaulted',
    });
  } else {
    allowed = sortedUnique(source.allowed.map(toTarget));
    if (source.allowed.includes('fast-forward-only')) {
      decisions.push({
        path: '/allowed',
        fidelity: 'lossy',
        policyKey: FF_ONLY_AS_REBASE,
        accepted: false,
      });
    }
  }

  let deleteBranchOnMerge = source.deleteBranchOnMerge;
  if (unreadable('/deleteBranchOnMerge') && defaults !== undefined) {
    deleteBranchOnMerge = defaults.deleteBranchOnMerge;
    decisions.push({
      path: '/deleteBranchOnMerge',
      fidelity: 'unreadable',
      defaulted: true,
      accepted: false,
      note: 'unreadable_defaulted',
    });
  }

  return {
    desired: { allowed, deleteBranchOnMerge },
    decisions,
    blockers: [],
    preTasks: [],
    postTasks: [],
    warnings: [],
  };
}

export const mergeSettingsDefinition: FacetDefinition<MergeSettings> = {
  key: mergeSettingsFacet.key,
  scope: mergeSettingsFacet.scope,
  schemaVersion: mergeSettingsFacet.schemaVersion,
  schema: mergeSettingsFacet.schema,
  compareMode: 'full',
  collections: mergeSettingsFacet.collections,
  sets: mergeSettingsFacet.sets,
  dependsOn: [],
  inScope: true,
  normalize: (data) => ({
    allowed: sortedUnique(data.allowed),
    deleteBranchOnMerge: data.deleteBranchOnMerge,
  }),
  translate: translateMergeSettings,
  compare: (desired, actual): FieldDiff[] =>
    diffDocuments(desired, actual, mergeSettingsFacet.documentSchema),
  findingCodes: {
    'merge-settings.accept-lossy': { kind: 'pre', completion: 'accept' },
  },
  policyKeys: [FF_ONLY_AS_REBASE],
};
