import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CanonicalJsonError, canonicalize, hashCanonical } from './jcs.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('[DOM-001] JCS canonical JSON (RFC 8785)', () => {
  it('[DOM-001] reproduces the RFC 8785 section 3.2.4 example', () => {
    const input = JSON.parse(
      '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],' +
        '"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"/","literals":[null,true,false]}',
    );
    expect(canonicalize(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it('[DOM-001] sorts members by UTF-16 code units (RFC 8785 section 3.2.3)', () => {
    const input = {
      '€': 'Euro Sign',
      '\r': 'Carriage Return',
      דּ: 'Hebrew Letter Dalet With Dagesh',
      '1': 'One',
      '😀': 'Emoji: Grinning Face',
      '\u0080': 'Control',
      ö: 'Latin Small Letter O With Diaeresis',
    };
    // (checked on the text: JSON.parse would re-order integer-like keys such as "1")
    const order = [...canonicalize(input).matchAll(/"((?:[^"\\]|\\.)*)":"/g)].map((m) => m[1]);
    expect(order).toEqual(['\\r', '1', '\u0080', '\u00f6', '\u20ac', '\ud83d\ude00', '\ufb33']);
    // code-unit order, not code-point order: U+FB33 sorts after U+1F600 (surrogate D83D)
    expect(canonicalize({ דּ: 1, '\u{1F600}': 2 })).toBe('{"\u{1F600}":2,"דּ":1}');
  });

  it('[DOM-001] is independent of member insertion order and nests sorting', () => {
    expect(canonicalize({ b: { d: 1, c: 2 }, a: [{ z: 1, y: 2 }] })).toBe(
      '{"a":[{"y":2,"z":1}],"b":{"c":2,"d":1}}',
    );
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
  });

  it('[DOM-001] serializes numbers as ECMAScript does (RFC 8785 appendix B)', () => {
    const cases: [number, string][] = [
      [0, '0'],
      [-0, '0'],
      [5e-324, '5e-324'],
      [-5e-324, '-5e-324'],
      [Number.MAX_VALUE, '1.7976931348623157e+308'],
      [9007199254740992, '9007199254740992'],
      [18014398509481984, '18014398509481984'],
      [9.999999999999997e22, '9.999999999999997e+22'],
      [1e23, '1e+23'],
      [1.0000000000000001e23, '1.0000000000000001e+23'],
      [999999999999999700000, '999999999999999700000'],
      [999999999999999900000, '999999999999999900000'],
      [1e21, '1e+21'],
      [9.999999999999997e-7, '9.999999999999997e-7'],
      [0.000001, '0.000001'],
      [333333333.3333332, '333333333.3333332'],
      [295147905179352830000, '295147905179352830000'],
      [1.5, '1.5'],
      [-1, '-1'],
      [4.5, '4.5'],
      [0.1 + 0.2, '0.30000000000000004'],
    ];
    for (const [n, expected] of cases) expect(canonicalize(n)).toBe(expected);
    expect(canonicalize([-0])).toBe('[0]');
    expect(canonicalize({ x: -0 })).toBe('{"x":0}');
  });

  it('[DOM-001] treats large integers as doubles unless told to reject them', () => {
    expect(canonicalize(2 ** 53 + 2)).toBe('9007199254740994');
    expect(canonicalize(2 ** 53 - 1, { unsafeIntegers: 'reject' })).toBe('9007199254740991');
    expect(canonicalize(-(2 ** 53 - 1), { unsafeIntegers: 'reject' })).toBe('-9007199254740991');
    expect(() => canonicalize(2 ** 53, { unsafeIntegers: 'reject' })).toThrow(CanonicalJsonError);
    expect(() => canonicalize({ n: 1e300 }, { unsafeIntegers: 'reject' })).toThrow(/safe range/);
    expect(canonicalize(1.5, { unsafeIntegers: 'reject' })).toBe('1.5'); // only integers are checked
  });

  it('[DOM-001] rejects NaN and infinities with the offending pointer', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => canonicalize(bad)).toThrow(/non-finite/);
    }
    expect(() => canonicalize({ a: [1, { 'b/c': Number.NaN }] })).toThrow(/"\/a\/1\/b~1c"/);
  });

  it('[DOM-001] rejects values JSON cannot carry instead of altering them', () => {
    expect(() => canonicalize(undefined)).toThrow(CanonicalJsonError);
    expect(() => canonicalize(10n)).toThrow(/bigint/);
    expect(() => canonicalize(() => 1)).toThrow(/function/);
    expect(() => canonicalize(Symbol('x'))).toThrow(/symbol/);
    expect(() => canonicalize(new Date(0))).toThrow(/plain object/);
    expect(() => canonicalize(new Map())).toThrow(/plain object/);
    expect(() => canonicalize([1, undefined, 3])).toThrow(/undefined array element/);
    // biome-ignore lint/suspicious/noSparseArray: the hole is the test
    expect(() => canonicalize([1, , 3])).toThrow(/undefined array element/);
  });

  it('[DOM-001] omits undefined members so an absent optional field hashes like a missing one', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(hashCanonical({ a: 1, b: undefined })).toBe(hashCanonical({ a: 1 }));
  });

  it('[DOM-001] accepts null-prototype objects and an own "__proto__" member', () => {
    const np = Object.create(null) as Record<string, unknown>;
    np.k = 1;
    expect(canonicalize(np)).toBe('{"k":1}');
    expect(canonicalize(JSON.parse('{"__proto__":{"x":1},"a":2}'))).toBe(
      '{"__proto__":{"x":1},"a":2}',
    );
  });

  it('[DOM-001] detects cycles but allows shared references', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => canonicalize(a)).toThrow(/circular/);
    const arr: unknown[] = [];
    arr.push(arr);
    expect(() => canonicalize(arr)).toThrow(/circular/);
    const shared = { x: 1 };
    expect(canonicalize({ p: shared, q: shared, r: [shared, shared] })).toBe(
      '{"p":{"x":1},"q":{"x":1},"r":[{"x":1},{"x":1}]}',
    );
  });

  it('[DOM-001] limits nesting depth', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 600; i++) deep = [deep];
    expect(() => canonicalize(deep)).toThrow(/deeper than 512/);
    expect(canonicalize(deep, { maxDepth: 1000 }).length).toBe(1201);
    expect(() => canonicalize([[1]], { maxDepth: 1 })).toThrow(/deeper than 1/);
  });

  it('[DOM-001] escapes strings exactly as RFC 8785 requires', () => {
    expect(canonicalize('\u0000\u0008\t\n\u000b\f\r\u001f"\\/\u007f')).toBe(
      '"\\u0000\\b\\t\\n\\u000b\\f\\r\\u001f\\"\\\\/\u007f"',
    );
    // U+2028/2029 and astral characters are written literally
    expect(canonicalize('  \u{1F600}')).toBe('"  \u{1F600}"');
  });

  it('[DOM-001] does not Unicode-normalize strings or keys', () => {
    expect(canonicalize({ é: 1 })).not.toBe(canonicalize({ é: 1 }));
  });

  it('[DOM-001] rejects lone surrogates in strings and keys (I-JSON)', () => {
    expect(() => canonicalize('\ud800')).toThrow(/lone surrogate/);
    expect(() => canonicalize({ '\udc00x': 1 })).toThrow(/lone surrogate/);
    expect(canonicalize('😀')).toBe('"\u{1F600}"');
  });

  it('[DOM-001] serializes empty containers and scalars', () => {
    expect(canonicalize({})).toBe('{}');
    expect(canonicalize([])).toBe('[]');
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize(true)).toBe('true');
    expect(canonicalize(false)).toBe('false');
    expect(canonicalize('')).toBe('""');
  });

  it('[DOM-001] hashCanonical is sha256 of the canonical text', () => {
    expect(hashCanonical({})).toBe(
      '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    );
    const v = { b: [1, 2], a: 'x' };
    expect(hashCanonical(v)).toBe(sha('{"a":"x","b":[1,2]}'));
    expect(hashCanonical({ n: 2 ** 60 }, { unsafeIntegers: 'allow' })).toBe(
      sha('{"n":1152921504606847000}'),
    );
    expect(() => hashCanonical({ n: 2 ** 60 }, { unsafeIntegers: 'reject' })).toThrow();
  });

  it('[DOM-001] error carries its pointer', () => {
    try {
      canonicalize({ a: { b: Number.NaN } });
      expect.unreachable();
    } catch (e) {
      expect((e as CanonicalJsonError).pointer).toBe('/a/b');
    }
  });
});
