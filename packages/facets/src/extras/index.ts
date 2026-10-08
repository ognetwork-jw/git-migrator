/**
 * extras facet (FAC-EXT), detect-only. Pure: no I/O, no provider vocabulary (GLO-002).
 *
 * `inScope: false`: the facet only emits warnings and never blocks, creates a task or applies
 * anything (FAC-EXT-001). Releases have no Bitbucket equivalent, so `releaseCount` never warns.
 * Decisions: docs/adr/0156-extras-facet.md.
 */
import { type Extras, extrasFacet } from '@git-migrator/canonical';
import type { FacetDefinition, Finding, TranslationResult } from '@git-migrator/core';

export const WIKI_NOT_MIGRATED = 'extras.wiki-not-migrated';
export const ISSUES_NOT_MIGRATED = 'extras.issues-not-migrated';
export const DOWNLOADS_NOT_MIGRATED = 'extras.downloads-not-migrated';

export function translateExtras(source: Extras): TranslationResult<Extras> {
  const warnings: Finding[] = [];
  if (source.wikiPopulated) {
    warnings.push({ code: WIKI_NOT_MIGRATED, paths: ['/wikiPopulated'], params: {} });
  }
  if (source.issueCount > 0) {
    warnings.push({
      code: ISSUES_NOT_MIGRATED,
      paths: ['/issueCount'],
      params: { count: source.issueCount },
    });
  }
  if (source.downloadCount > 0) {
    warnings.push({
      code: DOWNLOADS_NOT_MIGRATED,
      paths: ['/downloadCount'],
      params: { count: source.downloadCount },
    });
  }
  return {
    // Nothing is migrated, so the target is desired to hold none of these.
    desired: { wikiPopulated: false, issueCount: 0, downloadCount: 0, releaseCount: 0 },
    decisions: [],
    blockers: [],
    preTasks: [],
    postTasks: [],
    warnings,
  };
}

export const extrasDefinition: FacetDefinition<Extras> = {
  key: extrasFacet.key,
  scope: extrasFacet.scope,
  schemaVersion: extrasFacet.schemaVersion,
  schema: extrasFacet.schema,
  compareMode: 'none',
  collections: extrasFacet.collections,
  sets: extrasFacet.sets,
  dependsOn: [],
  inScope: false,
  normalize: (data) => data,
  translate: translateExtras,
  // Never called: `compareMode` is `none`. The engine still requires the member.
  compare: () => [],
  findingCodes: {
    [WIKI_NOT_MIGRATED]: { kind: 'warning' },
    [ISSUES_NOT_MIGRATED]: { kind: 'warning' },
    [DOWNLOADS_NOT_MIGRATED]: { kind: 'warning' },
  },
  policyKeys: [],
};
