import type { Extras } from '@git-migrator/canonical';
import {
  compareFacet,
  FacetRegistry,
  resolveRoutePolicies,
  satisfiedTasks,
  type TranslateEnvironment,
  translateFacet,
} from '@git-migrator/core';
import { describe, expect, it } from 'vitest';
import {
  DOWNLOADS_NOT_MIGRATED,
  extrasDefinition,
  ISSUES_NOT_MIGRATED,
  translateExtras,
  WIKI_NOT_MIGRATED,
} from './index.ts';

const registry = new FacetRegistry().register(extrasDefinition);
const unresolved = { resolve: () => ({ status: 'unmapped' as const }) };
const env: TranslateEnvironment = {
  identities: unresolved,
  groups: unresolved,
  policies: resolveRoutePolicies({}),
  route: {},
  routeIndex: {},
};

const none: Extras = { wikiPopulated: false, issueCount: 0, downloadCount: 0, releaseCount: 0 };

const translate = (source: Extras) => translateFacet(registry, 'extras', source, { env });

describe('extras facet', () => {
  it('[FAC-EXT] nothing populated raises no warning', () => {
    const t = translate(none);
    expect(t.warnings).toEqual([]);
    expect(t.decisions).toEqual([]);
  });

  it('[FAC-EXT] a populated wiki raises warning extras.wiki-not-migrated', () => {
    const t = translate({ ...none, wikiPopulated: true });
    expect(t.warnings).toEqual([
      {
        code: WIKI_NOT_MIGRATED,
        kind: 'warning',
        verifiable: false,
        paths: ['/wikiPopulated'],
        params: {},
      },
    ]);
  });

  it('[FAC-EXT] a non-zero issue count raises warning extras.issues-not-migrated with the count', () => {
    const t = translate({ ...none, issueCount: 3 });
    expect(t.warnings).toEqual([
      {
        code: ISSUES_NOT_MIGRATED,
        kind: 'warning',
        verifiable: false,
        paths: ['/issueCount'],
        params: { count: 3 },
      },
    ]);
  });

  it('[FAC-EXT] a non-zero download count raises warning extras.downloads-not-migrated with the count', () => {
    const t = translate({ ...none, downloadCount: 1 });
    expect(t.warnings).toEqual([
      {
        code: DOWNLOADS_NOT_MIGRATED,
        kind: 'warning',
        verifiable: false,
        paths: ['/downloadCount'],
        params: { count: 1 },
      },
    ]);
  });

  it('[FAC-EXT] each non-zero item raises its own warning, in a fixed order', () => {
    const t = translate({ wikiPopulated: true, issueCount: 2, downloadCount: 5, releaseCount: 0 });
    expect(t.warnings.map((w) => w.code)).toEqual([
      WIKI_NOT_MIGRATED,
      ISSUES_NOT_MIGRATED,
      DOWNLOADS_NOT_MIGRATED,
    ]);
  });

  it('[FAC-EXT] releases have no Bitbucket equivalent, so a release count never warns', () => {
    expect(translate({ ...none, releaseCount: 9 }).warnings).toEqual([]);
  });

  it('[FAC-EXT-001] the facet never blocks and creates no task', () => {
    const t = translate({ wikiPopulated: true, issueCount: 4, downloadCount: 4, releaseCount: 4 });
    expect(t.blockers).toEqual([]);
    expect(t.preTasks).toEqual([]);
    expect(t.postTasks).toEqual([]);
    expect(t.warnings).toHaveLength(3);
  });

  it('[FAC-EXT] the desired document holds none of the detected items', () => {
    expect(
      translateExtras({ wikiPopulated: true, issueCount: 4, downloadCount: 4, releaseCount: 0 })
        .desired,
    ).toEqual(none);
  });

  it('[FAC-EXT] compareMode none writes no ParityResult', () => {
    expect(compareFacet(registry, 'extras', none, { ...none, issueCount: 1 })).toBeNull();
  });

  it('[FAC-EXT] detect-only: no parity tasks exist, so none is satisfied', () => {
    const tasks = [{ code: WIKI_NOT_MIGRATED, params: {} }];
    expect(satisfiedTasks(registry, 'extras', tasks, none, [])).toEqual([]);
    expect(extrasDefinition.inScope).toBe(false);
    expect(extrasDefinition.compareMode).toBe('none');
  });
});
