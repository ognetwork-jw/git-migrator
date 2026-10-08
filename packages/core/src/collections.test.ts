import { describe, expect, it } from 'vitest';
import {
  CollectionError,
  CollectionSpecError,
  compareStrings,
  type DocumentSchema,
  flattenDocument,
  getAtPath,
  normalizeDocument,
  renderKeyValue,
  validateCollections,
} from './collections.ts';
import { canonicalize, hashCanonical } from './jcs.ts';

const schema: DocumentSchema = {
  collections: [
    { path: '/rules', key: 'pattern' },
    { path: '/rules/restrictPushes', key: 'principal' },
    { path: '/hooks', key: 'url' },
  ],
  sets: ['/labels', '/rules/events'],
};

describe('[ADP-021] collection normalization', () => {
  it('[ADP-021] sorts keyed collections by key, at every nesting level', () => {
    const doc = {
      description: 'd',
      rules: [
        {
          pattern: 'main',
          restrictPushes: [
            { principal: { kind: 'identity', id: '9' }, x: 1 },
            { principal: { kind: 'group', id: 'dev' } },
          ],
        },
        { pattern: 'dev' },
        { pattern: 'Zed' },
      ],
    };
    const out = normalizeDocument(doc, schema);
    expect(out.rules.map((r) => r.pattern)).toEqual(['Zed', 'dev', 'main']); // code-unit order
    expect(out.rules[2]?.restrictPushes?.map((p) => p.principal)).toEqual([
      { kind: 'group', id: 'dev' },
      { kind: 'identity', id: '9' },
    ]);
  });

  it('[ADP-021] ordering of the input never changes the output (all permutations)', () => {
    const items = [{ pattern: 'c' }, { pattern: 'a' }, { pattern: 'b' }, { pattern: 'B' }];
    const perms = (xs: typeof items): (typeof items)[] =>
      xs.length <= 1
        ? [xs]
        : xs.flatMap((x, i) =>
            perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]),
          );
    const expected = normalizeDocument({ rules: items }, schema);
    for (const p of perms(items)) expect(normalizeDocument({ rules: p }, schema)).toEqual(expected);
  });

  it('[ADP-021] is idempotent and does not mutate its input', () => {
    const doc = { rules: [{ pattern: 'b' }, { pattern: 'a' }], labels: ['y', 'x', 'x'] };
    const before = structuredClone(doc);
    const once = normalizeDocument(doc, schema);
    expect(doc).toEqual(before);
    expect(normalizeDocument(once, schema)).toEqual(once);
    expect(once).not.toBe(doc);
  });

  it('[ADP-021] keeps empty collections and sets, and leaves absent ones absent', () => {
    expect(normalizeDocument({ rules: [], labels: [] }, schema)).toEqual({ rules: [], labels: [] });
    expect(normalizeDocument({ description: 'x' }, schema)).toEqual({ description: 'x' });
    expect(normalizeDocument({ rules: [{ pattern: 'a', restrictPushes: [] }] }, schema)).toEqual({
      rules: [{ pattern: 'a', restrictPushes: [] }],
    });
  });

  it('[ADP-021] sorts primitive sets as a deduplicated set with a total order', () => {
    const out = normalizeDocument(
      { labels: ['b', 2, true, null, 'a', 2, -0, 0, false, 10, 'b'] },
      schema,
    );
    expect(out.labels).toEqual([null, false, true, 0, 2, 10, 'a', 'b']);
    expect(Object.is(out.labels[3], -0)).toBe(false);
    expect(
      normalizeDocument({ rules: [{ pattern: 'a', events: ['push', 'create', 'push'] }] }, schema)
        .rules[0]?.events,
    ).toEqual(['create', 'push']);
  });

  it('[ADP-021] null is a legal value of a nullable array and stays distinct from []', () => {
    const branchRules: DocumentSchema = {
      collections: [
        { path: '/rules', key: 'pattern' },
        { path: '/rules/restrictPushes', key: 'principal' },
        { path: '/rules/restrictMerges', key: 'principal' },
      ],
    };
    const envs: DocumentSchema = {
      collections: [{ path: '/environments', key: 'name' }],
      sets: ['/environments/deploymentBranches'],
    };
    const doc = {
      rules: [
        { pattern: 'b', restrictPushes: null, restrictMerges: [] },
        {
          pattern: 'a',
          restrictPushes: [{ principal: { kind: 'identity', id: '1' } }],
          restrictMerges: null,
        },
      ],
    };
    const out = normalizeDocument(doc, branchRules);
    expect(out.rules.map((r) => [r.restrictPushes === null, r.restrictMerges])).toEqual([
      [false, null],
      [true, []],
    ]);
    const e = normalizeDocument(
      {
        environments: [
          { name: 'prod', deploymentBranches: null },
          { name: 'dev', deploymentBranches: ['z', 'a'] },
          { name: 'qa', deploymentBranches: [] },
        ],
      },
      envs,
    );
    expect(e.environments.map((x) => x.deploymentBranches)).toEqual([['a', 'z'], null, []]);
    expect(validateCollections(doc, branchRules)).toEqual([]);
    const flat = flattenDocument(out, branchRules);
    expect(flat.get('/rules[pattern=b]/restrictPushes')).toBeNull();
    expect(flat.get('/rules[pattern=b]/restrictMerges')).toEqual([]);
    expect(getAtPath(out, '/rules[pattern=b]/restrictPushes')).toEqual({
      found: true,
      value: null,
    });
    expect(hashCanonical(out)).not.toBe(
      hashCanonical({
        rules: [{ pattern: 'b', restrictPushes: [], restrictMerges: [] }, out.rules[0]],
      }),
    );
  });

  it('[ADP-021] a "__proto__" member survives normalization as an own property', () => {
    const doc = JSON.parse('{"__proto__":{"x":1},"a":1,"rules":[{"pattern":"p","__proto__":2}]}');
    const out = normalizeDocument(doc, schema) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.hasOwn(out, '__proto__')).toBe(true);
    expect(canonicalize(out)).toBe(canonicalize(doc));
    expect(hashCanonical(out)).toBe(hashCanonical(doc));
  });

  it('[ADP-021] a schema may omit `sets`', () => {
    expect(
      normalizeDocument(
        { a: [{ k: 'b' }, { k: 'a' }] },
        { collections: [{ path: '/a', key: 'k' }] },
      ),
    ).toEqual({ a: [{ k: 'a' }, { k: 'b' }] });
  });

  it('[ADP-021] sets may contain several nulls and booleans, which collapse', () => {
    expect(
      normalizeDocument({ labels: [null, true, null, true, false, false] }, schema).labels,
    ).toEqual([null, false, true]);
  });

  it('[ADP-021] duplicate keys are rejected, not merged or last-wins', () => {
    const doc = {
      rules: [
        { pattern: 'a', n: 1 },
        { pattern: 'a', n: 2 },
      ],
    };
    expect(() => normalizeDocument(doc, schema)).toThrow(CollectionError);
    const issues = validateCollections(doc, schema);
    expect(issues).toEqual([
      { code: 'duplicate_key', path: '/rules[pattern=a]', message: '"pattern" is not unique' },
    ]);
  });

  it('[ADP-021] keys that render to the same text collide across types; case differs', () => {
    expect(
      validateCollections({ rules: [{ pattern: 1 }, { pattern: '1' }] }, schema)[0]?.code,
    ).toBe('duplicate_key');
    expect(validateCollections({ rules: [{ pattern: 'A' }, { pattern: 'a' }] }, schema)).toEqual(
      [],
    );
    expect(validateCollections({ rules: [{ pattern: 'é' }, { pattern: 'é' }] }, schema)).toEqual(
      [],
    );
  });

  it('[ADP-021] duplicate keys are scoped to their own parent collection', () => {
    const doc = {
      rules: [
        { pattern: 'a', restrictPushes: [{ principal: { kind: 'identity', id: 1 } }] },
        { pattern: 'b', restrictPushes: [{ principal: { kind: 'identity', id: 1 } }] },
      ],
    };
    expect(validateCollections(doc, schema)).toEqual([]);
  });

  it('[ADP-021] reports every violation with a concrete path', () => {
    const doc = {
      rules: [
        { pattern: 'ok' },
        { other: 1 },
        { pattern: undefined },
        { pattern: '' },
        { pattern: Number.NaN },
        { pattern: { kind: 'identity' } },
        { pattern: { kind: 'identity', id: 1, extra: true } },
        'text',
        null,
        { pattern: 'ok2', restrictPushes: 'nope' },
      ],
      hooks: { not: 'an array' },
      labels: [{ a: 1 }, [1], Number.POSITIVE_INFINITY, undefined],
      extra: [1, 2],
      when: new Date(0),
    };
    const issues = validateCollections(doc, schema);
    expect(issues.map((i) => i.code).sort()).toEqual(
      [
        'missing_key',
        'missing_key',
        'invalid_key',
        'invalid_key',
        'invalid_key',
        'invalid_key',
        'not_object',
        'not_object',
        'not_array',
        'not_array',
        'invalid_set_member',
        'invalid_set_member',
        'invalid_set_member',
        'invalid_set_member',
        'undeclared_array',
        'invalid_value',
      ].sort(),
    );
    expect(issues.find((i) => i.code === 'undeclared_array')?.path).toBe('/extra');
    expect(issues.find((i) => i.code === 'not_array' && i.path === '/hooks')).toBeDefined();
    expect(() => normalizeDocument(doc, schema)).toThrow(/missing_key/);
    expect(new CollectionError(issues).issues).toBe(issues);
  });

  it('[ADP-021] an undeclared array is rejected (every array is keyed or a primitive set)', () => {
    const issues = validateCollections({ deep: { list: [1] } }, schema);
    expect(issues).toEqual([
      { code: 'undeclared_array', path: '/deep/list', message: expect.any(String) },
    ]);
    // declared by path, so the same field name elsewhere is still undeclared
    expect(validateCollections({ other: { labels: [] } }, schema)[0]?.code).toBe(
      'undeclared_array',
    );
  });

  it('[ADP-021] rejects a non-object root and drops undefined members', () => {
    expect(validateCollections([], schema)[0]?.code).toBe('root_not_object');
    expect(validateCollections(null, schema)[0]?.code).toBe('root_not_object');
    expect(normalizeDocument({ a: undefined, b: 1 }, schema)).toEqual({ b: 1 });
    expect(Object.keys(normalizeDocument({ a: undefined, b: 1 }, schema))).toEqual(['b']);
  });

  it('[ADP-021] renders keys: strings, numbers, booleans and principals as kind:id', () => {
    expect(renderKeyValue('main')).toBe('main');
    expect(renderKeyValue(42)).toBe('42');
    expect(renderKeyValue(-0)).toBe('0');
    expect(renderKeyValue(true)).toBe('true');
    expect(renderKeyValue({ kind: 'identity', id: '42' })).toBe('identity:42');
    expect(renderKeyValue({ kind: 'group', id: 7 })).toBe('group:7');
    for (const bad of [
      '',
      Number.NaN,
      null,
      undefined,
      {},
      [],
      { kind: '', id: 'x' },
      { kind: 'a', id: '' },
      { kind: 'a', id: Number.NaN },
      { kind: 'a', id: 1, z: 1 },
      10n,
    ]) {
      expect(renderKeyValue(bad)).toBeUndefined();
    }
  });

  it('[ADP-021] compareStrings orders by UTF-16 code unit', () => {
    expect(compareStrings('a', 'b')).toBe(-1);
    expect(compareStrings('b', 'a')).toBe(1);
    expect(compareStrings('a', 'a')).toBe(0);
    expect(compareStrings('\u{1F600}', 'דּ')).toBe(-1);
  });

  it('[ADP-021] rejects bad declarations', () => {
    const bad: DocumentSchema[] = [
      {
        collections: [
          { path: '/a', key: 'k' },
          { path: '/a', key: 'k' },
        ],
      },
      { collections: [{ path: '/a[k=v]', key: 'k' }] },
      { collections: [{ path: '', key: 'k' }] },
      { collections: [{ path: 'a', key: 'k' }] },
      { collections: [{ path: '/a', key: '' }] },
      { collections: [{ path: '/a', key: 'k' }], sets: ['/a'] },
      { collections: [], sets: ['bad'] },
    ];
    for (const s of bad) expect(() => normalizeDocument({}, s)).toThrow(CollectionSpecError);
  });

  it('[ADP-020] getAtPath resolves keyed segments independent of array order', () => {
    const doc = {
      description: 'd',
      rules: [
        { pattern: 'z/y', enforcement: 'x' },
        { pattern: 'main', restrictPushes: [{ principal: { kind: 'identity', id: '1' }, v: 1 }] },
      ],
    };
    expect(getAtPath(doc, '/description')).toEqual({ found: true, value: 'd' });
    expect(getAtPath(doc, '/rules[pattern=z/y]/enforcement')).toEqual({ found: true, value: 'x' });
    expect(getAtPath(doc, '/rules[pattern=main]/restrictPushes[principal=identity:1]/v')).toEqual({
      found: true,
      value: 1,
    });
    expect(getAtPath(doc, '')).toEqual({ found: true, value: doc });
    expect(getAtPath(doc, '/rules[pattern=nope]')).toEqual({ found: false });
    expect(getAtPath(doc, '/rules[pattern=main]/missing')).toEqual({ found: false });
    expect(getAtPath(doc, '/description[k=v]')).toEqual({ found: false });
    expect(getAtPath(doc, '/description/x')).toEqual({ found: false });
    expect(getAtPath(doc, '/missing/x')).toEqual({ found: false });
    expect(getAtPath(doc, '/rules[pattern=main]/restrictPushes[nope=1]')).toEqual({ found: false });
    expect(getAtPath({ a: undefined }, '/a')).toEqual({ found: false });
    expect(getAtPath(doc, [{ name: 'description' }])).toEqual({ found: true, value: 'd' });
    expect(getAtPath(null, '/a')).toEqual({ found: false });
  });

  it('[ADP-020] flattenDocument addresses elements by key so reordering changes nothing', () => {
    const a = {
      name: 'n',
      rules: [
        { pattern: 'main', on: true },
        { pattern: 'dev', on: false },
      ],
      labels: ['x'],
      empty: {},
      none: [],
    };
    const b = { ...a, rules: [...a.rules].reverse() };
    const flat = flattenDocument(a, {
      collections: [
        { path: '/rules', key: 'pattern' },
        { path: '/none', key: 'k' },
      ],
      sets: ['/labels'],
    });
    expect([...flat.keys()].sort()).toEqual(
      [
        '/empty',
        '/labels',
        '/name',
        '/none',
        '/rules[pattern=dev]/on',
        '/rules[pattern=dev]/pattern',
        '/rules[pattern=main]/on',
        '/rules[pattern=main]/pattern',
      ].sort(),
    );
    expect(flat.get('/rules[pattern=main]/on')).toBe(true);
    expect(flat.get('/labels')).toEqual(['x']);
    const flatB = flattenDocument(b, {
      collections: [
        { path: '/rules', key: 'pattern' },
        { path: '/none', key: 'k' },
      ],
      sets: ['/labels'],
    });
    expect(new Map([...flatB].sort())).toEqual(new Map([...flat].sort()));
    // every flattened path resolves back to its leaf
    for (const [path, value] of flat) expect(getAtPath(a, path)).toEqual({ found: true, value });
  });

  it('[ADP-020] flattenDocument handles an empty root and refuses unkeyed elements', () => {
    expect(flattenDocument({}, schema).size).toBe(0);
    expect(flattenDocument('x', schema).get('')).toBe('x');
    expect(flattenDocument({ a: undefined }, schema).size).toBe(0);
    expect(() => flattenDocument({ rules: [{ nokey: 1 }] }, schema)).toThrow(CollectionError);
    expect(() => flattenDocument({ rules: [1] }, schema)).toThrow(CollectionError);
    expect(() => flattenDocument({ rules: [{ pattern: 'a' }, { pattern: 'a' }] }, schema)).toThrow(
      /duplicate_key/,
    );
    // a declared collection that is not an array is a leaf
    expect(flattenDocument({ rules: 'x' }, schema).get('/rules')).toBe('x');
  });
});
