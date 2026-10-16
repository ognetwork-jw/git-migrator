import {
  changeRequestLabel,
  changeRequestsDefinition,
  extrasDefinition,
  translateChangeRequests,
} from '@git-migrator/facets';
import {
  assertGuidanceCoverage,
  hasForbiddenCharacter,
  type ParamValues,
  renderGuidance,
} from '@git-migrator/guidance';
import { describe, expect, it } from 'vitest';

const URL_BASE = 'https://source.example.test/acme/app/pull-requests';

/** Translates open Change Requests and renders the blocker's guidance, as the web app does. */
function renderOpen(open: { id: string; title: string; url: string }[]) {
  const [blocker] = translateChangeRequests({ open }).blockers;
  if (blocker === undefined) throw new Error('expected a blocker');
  return renderGuidance('change-requests.open', blocker.params as ParamValues);
}

describe('guidance coverage of the change-requests and extras facets', () => {
  it('[FAC-002] every declared finding code has guidance', () => {
    const codes = [changeRequestsDefinition, extrasDefinition].flatMap((d) =>
      Object.keys(d.findingCodes),
    );
    expect(codes.length).toBeGreaterThan(0);
    expect(() => assertGuidanceCoverage(codes)).not.toThrow();
  });
});

describe('change-requests titles render through guidance without problems (FAC-CRQ, FAC-002)', () => {
  const hostile: [string, string][] = [
    ['bidi override', 'evil‮exe.txt'],
    ['bidi isolate', '⁦isolated⁩'],
    ['C1 control', 'a\u0085b\u009Fc'],
    ['U+2028 line separator', 'first second'],
    ['lone surrogate', 'broken\uD800end'],
    ['5000 characters', 'y'.repeat(5000)],
    ['300 astral characters', '\u{1F600}'.repeat(300)],
    ['markdown with backticks and links', '`code` [link](https://evil.example.test) *em* <b>'],
    ['NUL', 'a\u0000b'],
  ];

  it.each(hostile)('[FAC-CRQ] %s in a title', (_name, title) => {
    const rendered = renderOpen([{ id: '1', title, url: `${URL_BASE}/1` }]);
    expect(rendered.problems).toEqual([]);
    expect(JSON.stringify(rendered)).not.toContain('‹');
  });

  it.each(hostile)('[FAC-CRQ] %s in an id', (_name, id) => {
    const rendered = renderOpen([{ id, title: 'Plain', url: `${URL_BASE}/1` }]);
    expect(rendered.problems).toEqual([]);
  });

  it('[FAC-CRQ] every code point: the facet cleans exactly what the guidance validator refuses, plus whitespace', () => {
    // ADR-0155: the two sets are kept in sync, so a drift in either direction fails here.
    let forbidden = 0;
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue; // lone surrogates become U+FFFD (below)
      const ch = String.fromCodePoint(cp);
      const label = changeRequestLabel({ id: '1', title: `a${ch}b`, url: `${URL_BASE}/1` });
      if (hasForbiddenCharacter(label)) throw new Error(`U+${cp.toString(16)} reaches guidance`);
      if (hasForbiddenCharacter(ch)) {
        forbidden++;
        if (label !== '1: a b') throw new Error(`U+${cp.toString(16)} is not cleaned`);
      } else if (!/\s/u.test(ch) && label !== `1: a${ch}b`) {
        throw new Error(`U+${cp.toString(16)} is cleaned but guidance accepts it`);
      }
    }
    // C0 (32), DEL and C1 (33), U+2028/2029 (2), U+202A-202E (5), U+2066-2069 (4).
    expect(forbidden).toBe(76);
    expect(changeRequestLabel({ id: '1', title: 'a\uD800b', url: `${URL_BASE}/1` })).toBe(
      '1: a\uFFFDb',
    );
  });

  it('[FAC-CRQ] the longest possible labels, with astral characters in id and title, render', () => {
    const astral = '\u{1F600}'.repeat(5000);
    const rendered = renderOpen([
      { id: astral, title: astral, url: `${URL_BASE}/1` },
      { id: '', title: astral, url: `${URL_BASE}/${astral}` },
    ]);
    expect(rendered.problems).toEqual([]);
    expect(JSON.stringify(rendered)).not.toContain('‹');
  });

  it('[FAC-CRQ] a list where every entry is blank still renders, with the count and no marker', () => {
    const rendered = renderOpen([{ id: ' ', title: ' ', url: ' ' }]);
    expect(rendered.problems).toEqual([]);
    expect(JSON.stringify(rendered)).not.toContain('‹');
    expect(rendered.summary).toContain('1 open Change Request(s)');
  });

  it('[FAC-CRQ] a blank id and a blank title still render, using the URL', () => {
    const rendered = renderOpen([{ id: ' ', title: '', url: `${URL_BASE}/2` }]);
    expect(rendered.problems).toEqual([]);
  });
});

describe('change-requests list cap and counts render through guidance (FAC-CRQ)', () => {
  it('[FAC-CRQ] 600 open Change Requests render with the real count and a capped list', () => {
    const open = Array.from({ length: 600 }, (_, i) => ({
      id: String(i + 1),
      title: `Change ${i + 1}`,
      url: `${URL_BASE}/${i + 1}`,
    }));
    const rendered = renderOpen(open);
    expect(rendered.problems).toEqual([]);
    expect(rendered.summary).toContain('600');
    expect(JSON.stringify(rendered)).not.toContain('‹');
  });

  it('[FAC-CRQ] count exceeds the listed entries when blank entries are dropped', () => {
    const [blocker] = translateChangeRequests({
      open: [
        { id: ' ', title: '', url: ' ' },
        { id: '3', title: 'Kept', url: `${URL_BASE}/3` },
      ],
    }).blockers;
    expect(blocker?.params).toEqual({ count: 2, ids: ['3: Kept'] });
    expect(
      renderOpen([
        { id: ' ', title: '', url: ' ' },
        { id: '3', title: 'Kept', url: `${URL_BASE}/3` },
      ]).problems,
    ).toEqual([]);
  });
});
