import { describe, expect, it } from 'vitest';
import { mergeOverlay, OverlayError } from './overlay.ts';

const schema = {
  collections: [
    { path: '/rules', key: 'pattern' },
    { path: '/rules/restrictPushes', key: 'principal' },
  ],
  sets: ['/labels'],
};

const desired = {
  title: 'from source',
  labels: ['a'],
  rules: [
    {
      pattern: 'main',
      approvals: 1,
      restrictPushes: [{ principal: { kind: 'identity', id: '1' } }],
    },
    { pattern: 'dev', approvals: 0, restrictPushes: [] },
  ],
};

describe('[LIF-048] overlay merge', () => {
  it('[LIF-048] overlay values win, other desired values stay, and the merged paths are reported', () => {
    const out = mergeOverlay(
      desired,
      { title: 'overlay', rules: [{ pattern: 'main', approvals: 2 }] },
      schema,
    );
    expect(out.merged).toEqual({
      title: 'overlay',
      labels: ['a'],
      rules: [
        {
          pattern: 'dev',
          approvals: 0,
          restrictPushes: [],
        },
        {
          pattern: 'main',
          approvals: 2,
          restrictPushes: [{ principal: { kind: 'identity', id: '1' } }],
        },
      ],
    });
    expect(out.paths).toEqual(['/rules[pattern=main]/approvals', '/title']);
  });

  it('[LIF-048] a new key is added to a keyed collection, nested collections merge by key, sets are a union', () => {
    const out = mergeOverlay(
      desired,
      {
        labels: ['b'],
        rules: [
          { pattern: 'release', approvals: 3 },
          { pattern: 'main', restrictPushes: [{ principal: { kind: 'group', id: 'g' } }] },
        ],
      },
      schema,
    );
    expect((out.merged.rules as { pattern: string }[]).map((r) => r.pattern)).toEqual([
      'dev',
      'main',
      'release',
    ]);
    expect(out.merged.labels).toEqual(['a', 'b']);
    const main = (out.merged.rules as { pattern: string; restrictPushes: unknown[] }[]).find(
      (r) => r.pattern === 'main',
    );
    expect(main?.restrictPushes).toHaveLength(2);
  });

  it('[LIF-048] changes neither the desired document nor the overlay', () => {
    const before = structuredClone(desired);
    const overlay = { rules: [{ pattern: 'main', approvals: 9 }] };
    const overlayBefore = structuredClone(overlay);
    mergeOverlay(desired, overlay, schema);
    expect(desired).toEqual(before);
    expect(overlay).toEqual(overlayBefore);
  });

  it('[LIF-048] refuses keys that reach a prototype, at any depth, and never pollutes Object.prototype', () => {
    const hostile = JSON.parse('{"rules":[{"pattern":"main","__proto__":{"polluted":true}}]}');
    expect(() => mergeOverlay(desired, hostile, schema)).toThrow(OverlayError);
    expect(() => mergeOverlay(desired, JSON.parse('{"__proto__":{"x":1}}'), schema)).toThrow(
      /forbidden key/,
    );
    expect(() => mergeOverlay(desired, { constructor: { prototype: { x: 1 } } }, schema)).toThrow(
      OverlayError,
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it('[LIF-048] refuses an overlay that is not an object or has an unkeyed collection element', () => {
    expect(() => mergeOverlay(desired, [], schema)).toThrow(OverlayError);
    expect(() => mergeOverlay(desired, null, schema)).toThrow(OverlayError);
    expect(() => mergeOverlay(desired, { rules: [{ approvals: 1 }] }, schema)).toThrow(
      OverlayError,
    );
  });
});
