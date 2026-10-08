import type { ChangeRequests } from '@git-migrator/canonical';
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
  changeRequestLabel,
  changeRequestsDefinition,
  MAX_LISTED,
  OPEN_CHANGE_REQUEST,
  translateChangeRequests,
} from './index.ts';

const registry = new FacetRegistry().register(changeRequestsDefinition);
const unresolved = { resolve: () => ({ status: 'unmapped' as const }) };
const env: TranslateEnvironment = {
  identities: unresolved,
  groups: unresolved,
  policies: resolveRoutePolicies({}),
  route: {},
  routeIndex: {},
};

type Open = ChangeRequests['open'][number];
const cr = (id: string, title = `Change ${id}`): Open => ({
  id,
  title,
  url: `https://source.example.test/acme/app/pull-requests/${id}`,
});

const translate = (source: ChangeRequests) =>
  translateFacet(registry, 'change-requests', source, { env });

describe('change-requests facet', () => {
  it('[FAC-CRQ] no open Change Request raises no blocker', () => {
    const t = translate({ open: [] });
    expect(t.blockers).toEqual([]);
    expect(t.preTasks).toEqual([]);
    expect(t.postTasks).toEqual([]);
    expect(t.warnings).toEqual([]);
  });

  it('[FAC-CRQ] any open Change Request raises blocker change-requests.open, listing them', () => {
    const t = translate({ open: [cr('12', 'Fix login'), cr('13', 'Bump deps')] });
    expect(t.blockers).toEqual([
      {
        code: OPEN_CHANGE_REQUEST,
        kind: 'blocker',
        verifiable: false,
        paths: ['/open'],
        params: { count: 2, ids: ['12: Fix login', '13: Bump deps'] },
      },
    ]);
    expect(t.preTasks).toEqual([]);
    expect(t.postTasks).toEqual([]);
  });

  it('[FAC-CRQ] a single open Change Request raises exactly one blocker', () => {
    const t = translate({ open: [cr('7', 'Solo')] });
    expect(t.blockers).toHaveLength(1);
    expect(t.blockers[0]?.params).toEqual({ count: 1, ids: ['7: Solo'] });
  });

  it('[FAC-CRQ] the list is capped at MAX_LISTED entries while count keeps the real total', () => {
    const open = Array.from({ length: MAX_LISTED + 25 }, (_, i) => cr(String(i + 1), 'T'));
    const blocker = translate({ open }).blockers[0];
    const params = blocker?.params as { count: number; ids: string[] };
    expect(params.count).toBe(MAX_LISTED + 25);
    expect(params.ids).toHaveLength(MAX_LISTED);
    expect(params.ids[0]).toBe('1: T');
  });

  it('[FAC-CRQ] titles with control characters or long text are cleaned for guidance', () => {
    const label = changeRequestLabel(cr('9', 'Line one\n\tLine\u0000two   '));
    expect(label).toBe('9: Line one Line two');
    const long = changeRequestLabel(cr('10', 'x'.repeat(500)));
    expect(long.startsWith('10: ')).toBe(true);
    expect(long.length).toBeLessThanOrEqual(10 + 200 + 2);
  });

  it('[FAC-CRQ] bidi overrides, isolates, U+2028 and C1 controls are cleaned like the guidance validator requires', () => {
    const hostile = 'a‮b⁦c⁩d e\u009Ff\u007F g';
    expect(changeRequestLabel(cr('4', hostile))).toBe('4: a b c d e f g');
  });

  it('[FAC-CRQ] zero-width joiners in emoji sequences are kept', () => {
    const family = '\u{1F469}‍\u{1F4BB}';
    expect(changeRequestLabel(cr('5', family))).toBe(`5: ${family}`);
  });

  it('[FAC-CRQ] lone surrogates become U+FFFD, so the text is well formed', () => {
    expect(changeRequestLabel(cr('6', 'bad\uD800end\uDC00'))).toBe('6: bad�end�');
  });

  it('[FAC-CRQ] a blank id falls back to the URL, and an entry with nothing usable is dropped', () => {
    expect(changeRequestLabel({ id: '  ', title: 'No id', url: 'https://x.example.test/1' })).toBe(
      'https://x.example.test/1: No id',
    );
    const t = translateChangeRequests({
      open: [{ id: ' ', title: '', url: ' ' }, cr('3', 'Kept')],
    });
    expect(t.blockers[0]?.params).toEqual({ count: 2, ids: ['3: Kept'] });
  });

  it('[FAC-CRQ] nothing is migrated, so the desired document is empty', () => {
    const t = translate({ open: [cr('1')] });
    expect(t.desired).toEqual({ open: [] });
    expect(t.decisions).toEqual([]);
  });

  it('[FAC-CRQ] compareMode none writes no ParityResult, whatever the target holds', () => {
    expect(compareFacet(registry, 'change-requests', { open: [] }, { open: [cr('5')] })).toBeNull();
    expect(compareFacet(registry, 'change-requests', { open: [] }, null)).toBeNull();
  });

  it('[FAC-CRQ] the facet has no parity tasks, so no task is ever satisfied by parity', () => {
    const tasks = [{ code: OPEN_CHANGE_REQUEST, params: {} }];
    expect(satisfiedTasks(registry, 'change-requests', tasks, { open: [] }, [])).toEqual([]);
  });

  it('[FAC-CRQ] the facet is in scope (blocking only)', () => {
    expect(changeRequestsDefinition.inScope).toBe(true);
    expect(changeRequestsDefinition.compareMode).toBe('none');
  });
});
