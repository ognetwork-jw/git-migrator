import { CANONICAL_FACETS } from '@git-migrator/canonical';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { OVERLAY_MAX_BYTES, validateOverlayDocument } from './index.ts';

const webhooks = CANONICAL_FACETS.webhooks.schema;
const settings = CANONICAL_FACETS['repository-settings'].schema;

describe('[DOM-003] overlay document validation', () => {
  it('[DOM-003] accepts a partial document and refuses a non-object', () => {
    expect(validateOverlayDocument(webhooks, {})).toEqual([]);
    expect(validateOverlayDocument(webhooks, [])).toHaveLength(1);
    expect(validateOverlayDocument(webhooks, 'x')[0]?.message).toMatch(/JSON object/);
    expect(validateOverlayDocument(webhooks, null)).toHaveLength(1);
  });

  it('[DOM-003] makes fields optional through arrays and refuses unknown keys at any depth', () => {
    const ok = { hooks: [{ active: false }] };
    expect(validateOverlayDocument(webhooks, ok)).toEqual([]);
    const unknownTop = validateOverlayDocument(webhooks, { nope: 1 });
    expect(unknownTop[0]?.message).toMatch(/nope/);
    const unknownDeep = validateOverlayDocument(webhooks, { hooks: [{ active: true, zzz: 1 }] });
    expect(unknownDeep.some((issue) => /zzz/.test(issue.message))).toBe(true);
  });

  it('[DOM-003] keeps field-level rules: a wrong type or a bad URL is reported with its path', () => {
    const wrongType = validateOverlayDocument(webhooks, { hooks: [{ active: 'yes' }] });
    expect(wrongType[0]?.path).toBe('hooks.0.active');
    const badUrl = validateOverlayDocument(webhooks, { hooks: [{ url: 'ftp://x.test' }] });
    expect(badUrl[0]?.path).toBe('hooks.0.url');
  });

  it('[DOM-003] refuses __proto__, constructor and prototype at any depth', () => {
    const proto = JSON.parse('{"__proto__": {"polluted": true}}') as unknown;
    expect(validateOverlayDocument(webhooks, proto)[0]?.message).toMatch(/__proto__/);
    const deep = JSON.parse('{"hooks":[{"constructor":{"x":1}}]}') as unknown;
    const issues = validateOverlayDocument(webhooks, deep);
    expect(issues[0]?.path).toBe('hooks.0.constructor');
    expect(validateOverlayDocument(webhooks, { prototype: 1 })[0]?.message).toMatch(/prototype/);
  });

  it('[DOM-003] refuses NUL characters and lone surrogates in strings and keys', () => {
    const bad = [
      { hooks: [{ key: 'a\u0000b' }] },
      { hooks: [{ key: 'a\uD800b' }] },
      { hooks: [{ key: '\uDC00' }] },
      { hooks: [{ 'k\u0000': 1 }] },
      { '\uD83D': 1 },
    ];
    for (const doc of bad) {
      const issues = validateOverlayDocument(webhooks, doc);
      expect(issues[0]?.message, JSON.stringify(doc)).toMatch(/NUL|surrogate/);
    }
    expect(validateOverlayDocument(webhooks, { hooks: [{ key: 'emoji \u{1F600}' }] })).toEqual([]);
  });

  it('[DOM-003] refuses a document over 64 KB and one nested too deeply', () => {
    const big = { hooks: [{ note: 'x'.repeat(OVERLAY_MAX_BYTES) }] };
    expect(validateOverlayDocument(webhooks, big)[0]?.message).toMatch(/larger than/);
    let nested: Record<string, unknown> = {};
    for (let i = 0; i < 40; i += 1) nested = { a: nested };
    expect(validateOverlayDocument(webhooks, nested)[0]?.message).toMatch(/nesting/);
  });

  it('[DOM-003] does not apply schema defaults and validates repository settings partially', () => {
    expect(validateOverlayDocument(settings, {})).toEqual([]);
    const defaulted = z.object({ a: z.string().default('x'), b: z.number() });
    expect(validateOverlayDocument(defaulted, {})).toEqual([]);
    expect(validateOverlayDocument(defaulted, { b: 'no' })[0]?.path).toBe('b');
  });

  it('[DOM-003] keeps array length rules but not refinements a partial collection cannot meet', () => {
    const schema = z.object({
      a: z.array(z.string()).min(1).max(2),
      b: z.array(z.number()).length(1),
    });
    expect(validateOverlayDocument(schema, { a: ['x'], b: [1] })).toEqual([]);
    expect(validateOverlayDocument(schema, { a: ['x', 'y', 'z'] })[0]?.path).toBe('a');
    expect(validateOverlayDocument(schema, { a: [] })[0]?.path).toBe('a');
    expect(validateOverlayDocument(schema, { b: [1, 2] })[0]?.path).toBe('b');
    const unique = z.object({
      items: z
        .array(z.object({ key: z.string(), v: z.number() }))
        .refine((xs) => new Set(xs.map((x) => x.key)).size === xs.length),
    });
    expect(validateOverlayDocument(unique, { items: [{ v: 1 }, { v: 2 }] })).toEqual([]);
  });

  it('[DOM-003] tuples and lazy schemas are made partial and strict too', () => {
    const tuple = z.object({ t: z.tuple([z.object({ x: z.number(), y: z.number() })]) });
    expect(validateOverlayDocument(tuple, { t: [{ x: 1 }] })).toEqual([]);
    expect(validateOverlayDocument(tuple, { t: [{ zzz: 1 }] }).length).toBeGreaterThan(0);
    interface Node {
      name: string;
      children: Node[];
    }
    const node: z.ZodType<Node> = z.lazy(() =>
      z.object({ name: z.string(), children: z.array(node) }),
    );
    const tree = z.object({ root: node });
    expect(validateOverlayDocument(tree, { root: { children: [{ name: 'a' }] } })).toEqual([]);
    const deep = validateOverlayDocument(tree, { root: { children: [{ zzz: 1 }] } });
    expect(deep.some((issue) => /zzz/.test(issue.message))).toBe(true);
  });

  it('[DOM-003] fails closed for schema parts it cannot make partial', () => {
    const inner = z.object({ a: z.string() });
    for (const schema of [
      z.object({ p: inner.pipe(z.object({ a: z.string() })) }),
      z.object({ p: inner.transform((v) => v) }),
      z.object({ p: z.intersection(inner, z.object({ b: z.string() })) }),
      z.object({ p: z.lazy(() => inner.transform((v) => v)) }),
    ]) {
      expect(validateOverlayDocument(schema, {})[0]?.message).toMatch(/cannot be applied/);
    }
  });

  it('[DOM-003] fails closed for a parser that is not a Zod schema', () => {
    const issues = validateOverlayDocument({ parse: (value: unknown) => value }, {});
    expect(issues[0]?.message).toMatch(/cannot be applied/);
  });
});
