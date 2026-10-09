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

  it('[DOM-003] fails closed for a parser that is not a Zod schema', () => {
    const issues = validateOverlayDocument({ parse: (value: unknown) => value }, {});
    expect(issues[0]?.message).toMatch(/cannot be applied/);
  });
});
