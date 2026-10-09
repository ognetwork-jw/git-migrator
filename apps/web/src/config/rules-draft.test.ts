import { describe, expect, it } from 'vitest';
import {
  matchingPatterns,
  overlayProblems,
  parseOverlayData,
  patternProblem,
} from './rules-draft.ts';

describe('[UI-031] webhook allowlist patterns', () => {
  it('[UI-031] a pattern must be a non-empty http or https URL without spaces', () => {
    expect(patternProblem('   ')).toBe('empty');
    expect(patternProblem('x'.repeat(2049))).toBe('tooLong');
    expect(patternProblem('https://ci.example.test/a b')).toBe('shape');
    expect(patternProblem('ftp://ci.example.test/hooks')).toBe('shape');
    expect(patternProblem('not a url')).toBe('shape');
    expect(patternProblem('https://*.example.test/hooks/**')).toBeUndefined();
  });

  it('[UI-031] [FAC-WEB-002] refuses patterns the sync would never match', () => {
    expect(patternProblem('https://**.example.test/hooks')).toBe('hostDoubleStar');
    expect(patternProblem('https://ci.example.test/hooks/**')).toBeUndefined();
    expect(patternProblem('https://ci.example.test\\hooks')).toBe('characters');
    expect(patternProblem('https://ci.example.test/hooks\u0000x')).toBe('characters');
    expect(patternProblem('https://ci.example.test/hooks\u007f')).toBe('characters');
    // The same rule as the sync: what the form accepts, the matcher can match.
    expect(
      matchingPatterns('https://a.example.test/x', [{ pattern: 'https://*.example.test/x' }]),
    ).toHaveLength(1);
  });

  it('[UI-031] [FAC-WEB-002] the tester ignores a URL over 2048 characters and stays fast on a hostile pattern', () => {
    const entries = [{ id: 'a', pattern: 'https://ci.example.test/**' }];
    expect(matchingPatterns(`https://ci.example.test/${'a'.repeat(2100)}`, entries)).toEqual([]);
    const hostile = [{ id: 'h', pattern: `https://ci.example.test/${'**/'.repeat(8)}never` }];
    const url = `https://ci.example.test/${Array.from({ length: 40 }, (_, i) => `s${i}`).join('/')}`;
    const started = performance.now();
    expect(matchingPatterns(url, hostile)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('[UI-031] the tester answers with the patterns the sync would match (FAC-WEB-002)', () => {
    const entries = [
      { id: 'a', pattern: 'https://*.example.test/hooks/**' },
      { id: 'b', pattern: 'https://ci.example.test/other' },
      { id: 'c', pattern: 'http://*.example.test/hooks/**' },
    ];
    expect(
      matchingPatterns('https://ci.example.test/hooks/build/42?token=x', entries).map((e) => e.id),
    ).toEqual(['a']);
    expect(matchingPatterns('  ', entries)).toEqual([]);
    expect(matchingPatterns('https://evil.example.org/hooks/x', entries)).toEqual([]);
  });
});

describe('[UI-032] overlay documents', () => {
  it('[UI-032] an overlay is a JSON object: other JSON and invalid text are refused', () => {
    expect(parseOverlayData('{"a": 1}')).toEqual({ ok: true, data: { a: 1 } });
    expect(parseOverlayData('{"a":')).toEqual({ ok: false, problem: 'notJson' });
    expect(parseOverlayData('[1, 2]')).toEqual({ ok: false, problem: 'notObject' });
    expect(parseOverlayData('"text"')).toEqual({ ok: false, problem: 'notObject' });
    expect(parseOverlayData('null')).toEqual({ ok: false, problem: 'notObject' });
  });
});

describe('[UI-032] [DOM-003] overlay documents against the Facet schema', () => {
  it('[UI-032] the browser runs the server check: unknown keys, wrong types and prototype keys', () => {
    expect(overlayProblems('webhooks', { hooks: [{ active: false }] })).toEqual([]);
    expect(overlayProblems('webhooks', { hooks: [{ active: 'yes' }] })[0]?.path).toBe(
      'hooks.0.active',
    );
    expect(overlayProblems('webhooks', { nope: 1 })[0]?.message).toMatch(/nope/);
    expect(overlayProblems('webhooks', JSON.parse('{"__proto__": {"x": 1}}'))[0]?.message).toMatch(
      /not allowed/,
    );
    // A Facet this build does not know is left to the server.
    expect(overlayProblems('unknown-facet', { a: 1 })).toEqual([]);
  });
});
