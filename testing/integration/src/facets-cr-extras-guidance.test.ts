import {
  changeRequestsDefinition,
  extrasDefinition,
  translateChangeRequests,
} from '@git-migrator/facets';
import { assertGuidanceCoverage, type ParamValues, renderGuidance } from '@git-migrator/guidance';
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
    expect(rendered.summary).not.toContain('‹');
  });

  it.each(hostile)('[FAC-CRQ] %s in an id', (_name, id) => {
    const rendered = renderOpen([{ id, title: 'Plain', url: `${URL_BASE}/1` }]);
    expect(rendered.problems).toEqual([]);
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
    expect(rendered.summary).not.toContain('‹');
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
