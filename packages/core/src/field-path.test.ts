import { describe, expect, it } from 'vitest';
import {
  canonicalFieldPath,
  FieldPathError,
  formatFieldPath,
  isFieldPath,
  itemSeg,
  joinFieldPath,
  parseFieldPath,
  parsePathPattern,
  seg,
} from './field-path.ts';

/** Deterministic PRNG so failures reproduce. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = [
  'a',
  'Z',
  '0',
  '/',
  '[',
  ']',
  '=',
  '*',
  '\\',
  ' ',
  '-',
  ':',
  '.',
  'é',
  'e\u0301',
  '😀',
  '\n',
  '\u0000',
  '日',
  '~',
];

function randomString(next: () => number, max = 8): string {
  let s = '';
  for (let i = Math.floor(next() * max); i > 0; i--)
    s += ALPHABET[Math.floor(next() * ALPHABET.length)];
  return s;
}

describe('[ADP-020] field paths', () => {
  it('[ADP-020] parses and formats the examples from the spec unchanged', () => {
    const examples = [
      '/description',
      '/rules[pattern=main]/blockForcePush',
      '/grants[principal=group:developers]/role',
      '/refs[name=refs/heads/main]/target',
      '/rules[pattern=main]/restrictPushes[principal=identity:42]',
    ];
    for (const p of examples) expect(formatFieldPath(parseFieldPath(p))).toBe(p);
    expect(parseFieldPath('/refs[name=refs/heads/main]/target')).toEqual([
      { name: 'refs', key: { field: 'name', value: 'refs/heads/main' } },
      { name: 'target' },
    ]);
  });

  it('[ADP-020] the root is the empty string and has no segments', () => {
    expect(parseFieldPath('')).toEqual([]);
    expect(formatFieldPath([])).toBe('');
    expect(isFieldPath('')).toBe(true);
  });

  it('[ADP-020] builders produce the same text as parsing', () => {
    expect(formatFieldPath([itemSeg('rules', 'pattern', 'main'), seg('enforcement')])).toBe(
      '/rules[pattern=main]/enforcement',
    );
    expect(joinFieldPath('/rules[pattern=main]', seg('a'), itemSeg('b', 'k', 'v'))).toBe(
      '/rules[pattern=main]/a/b[k=v]',
    );
    expect(joinFieldPath('')).toBe('');
  });

  it('[ADP-020] keeps unicode and escaped keys intact', () => {
    const segments = [
      itemSeg('règles', 'motif', 'main/ünï-😀'),
      itemSeg('a/b[c]', 'k=ey', 'v]al\\ue/with=eq'),
      seg('na\\me*'),
    ];
    const text = formatFieldPath(segments);
    expect(text).toBe(
      '/règles[motif=main/ünï-😀]/a\\/b\\[c\\][k\\=ey=v\\]al\\\\ue/with=eq]/na\\\\me\\*',
    );
    expect(parseFieldPath(text)).toEqual(segments);
  });

  it('[ADP-020] a key value may be empty, contain "[" and "=", and compose characters distinctly', () => {
    expect(parseFieldPath('/a[k=]')).toEqual([itemSeg('a', 'k', '')]);
    expect(parseFieldPath('/a[k=x[y=z]')).toEqual([itemSeg('a', 'k', 'x[y=z')]);
    expect(formatFieldPath([itemSeg('a', 'k', '\u00e9')])).not.toBe(
      formatFieldPath([itemSeg('a', 'k', 'e\u0301')]),
    );
  });

  it('[ADP-020] a trailing slash and a lone slash are empty-named segments', () => {
    expect(parseFieldPath('/')).toEqual([seg('')]);
    expect(parseFieldPath('/a/')).toEqual([seg('a'), seg('')]);
    expect(parseFieldPath('//')).toEqual([seg(''), seg('')]);
    expect(formatFieldPath(parseFieldPath('//a'))).toBe('//a');
  });

  it('[ADP-020] round-trips arbitrary names, fields and values (property test)', () => {
    const next = rng(20260);
    for (let n = 0; n < 3000; n++) {
      const segments = Array.from({ length: Math.floor(next() * 4) }, () =>
        next() < 0.5
          ? seg(randomString(next))
          : itemSeg(randomString(next), randomString(next), randomString(next)),
      );
      const text = formatFieldPath(segments);
      expect(parseFieldPath(text)).toEqual(segments);
      expect(formatFieldPath(parseFieldPath(text))).toBe(text);
    }
  });

  it('[ADP-020] formatting escapes a literal * so a concrete path never acts as a wildcard', () => {
    const p = formatFieldPath([itemSeg('rules', 'pattern', '*')]);
    expect(p).toBe('/rules[pattern=\\*]');
    expect(parseFieldPath(p)).toEqual([itemSeg('rules', 'pattern', '*')]);
    // an unescaped star in an incoming concrete path is read as a literal and re-rendered escaped
    expect(parseFieldPath('/rules[pattern=*]')).toEqual([itemSeg('rules', 'pattern', '*')]);
    expect(canonicalFieldPath('/rules[pattern=*]')).toBe('/rules[pattern=\\*]');
  });

  it('[ADP-020] rejects malformed paths with the failing index', () => {
    const bad: [string, RegExp][] = [
      ['description', /must start with "\/"/],
      ['/a[k=v', /unterminated/],
      ['/a[k', /expected "="/],
      ['/a[kv]', /expected "="/],
      ['/a[k=v]x', /expected "\/"/],
      ['/a[k=v][j=w]', /expected "\/"/],
      ['/a]', /unexpected "\]"/],
      ['/a\\', /invalid escape/],
      ['/a\\q', /invalid escape/],
      ['/a[k=v\\q]', /invalid escape/],
      ['/a[k\\q=v]', /invalid escape/],
      ['/a[k[=v]', /expected "="/],
      ['/a[k=v\\]', /unterminated/],
    ];
    for (const [text, re] of bad) {
      expect(() => parseFieldPath(text), text).toThrow(FieldPathError);
      expect(() => parseFieldPath(text), text).toThrow(re);
      expect(isFieldPath(text)).toBe(false);
    }
    try {
      parseFieldPath('/ok/bad]');
    } catch (e) {
      expect((e as FieldPathError).index).toBe(7);
      expect((e as FieldPathError).path).toBe('/ok/bad]');
    }
  });

  it('[ADP-020] canonicalFieldPath normalizes the spelling and rejects garbage', () => {
    expect(canonicalFieldPath('/a[k=v]/b')).toBe('/a[k=v]/b');
    expect(() => canonicalFieldPath('nope')).toThrow(FieldPathError);
  });
});

describe('[ADP-020] path patterns', () => {
  it('[ADP-020] parses exact, any, prefix and deep forms', () => {
    expect(parsePathPattern('/rules[pattern=*]/enforcement')).toEqual({
      segments: [
        { name: 'rules', key: { field: 'pattern', value: { kind: 'any' } } },
        { name: 'enforcement' },
      ],
      deep: false,
    });
    expect(parsePathPattern('/refs[name=refs/heads/git-migrator/*]').segments[0]).toEqual({
      name: 'refs',
      key: { field: 'name', value: { kind: 'prefix', prefix: 'refs/heads/git-migrator/' } },
    });
    expect(parsePathPattern('/hooks[url=*]/**')).toEqual({
      segments: [{ name: 'hooks', key: { field: 'url', value: { kind: 'any' } } }],
      deep: true,
    });
    expect(parsePathPattern('/**')).toEqual({ segments: [], deep: true });
    expect(parsePathPattern('/a[k=exact]').segments[0]).toEqual({
      name: 'a',
      key: { field: 'k', value: { kind: 'exact', value: 'exact' } },
    });
  });

  it('[ADP-020] an escaped star is a literal, in values and in names', () => {
    expect(parsePathPattern('/a[k=\\*]').segments[0]).toEqual({
      name: 'a',
      key: { field: 'k', value: { kind: 'exact', value: '*' } },
    });
    expect(parsePathPattern('/a[k=x\\**]').segments[0]).toEqual({
      name: 'a',
      key: { field: 'k', value: { kind: 'prefix', prefix: 'x*' } },
    });
    // `\*\*` is a field literally named "**", not the deep wildcard
    expect(parsePathPattern('/\\*\\*')).toEqual({ segments: [seg('**')], deep: false });
  });

  it('[ADP-020] rejects wildcards anywhere but a whole or trailing selector value, and a misplaced **', () => {
    const bad = [
      '',
      '/**/x',
      '/a/**/b',
      '/a*',
      '/*',
      '/*/x',
      '/a/***',
      '/a/*x',
      '/a[k=*x]',
      '/a[k=x*y]',
      '/a[k=**]',
      '/a[k=x**]',
      '/a[k=*]*',
      '/a[k*=v]',
      '/a[k=v]**',
      '/a[k=v]/**x',
      '/a[k=v]/**[j=w]',
      'rules',
    ];
    for (const p of bad)
      expect(() => parsePathPattern(p), JSON.stringify(p)).toThrow(FieldPathError);
  });
});

describe('[ADP-020] patternForPath', () => {
  it('[ADP-020] escapes stars so a stored path never over-matches', async () => {
    const { patternForPath } = await import('./field-path.ts');
    const { matchesPattern } = await import('./pattern.ts');
    const p = patternForPath('/refs[name=release/*]');
    expect(p).toBe('/refs[name=release/\\*]');
    expect(matchesPattern(p, '/refs[name=release/1.0]')).toBe(false);
    expect(matchesPattern(p, '/refs[name=release/\\*]/x')).toBe(true);
    expect(matchesPattern('/refs[name=release/*]', '/refs[name=release/1.0]')).toBe(true); // raw string is a glob
  });
});
