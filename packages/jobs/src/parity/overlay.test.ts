import { describe, expect, it } from 'vitest';
import { mergeOverlay } from './overlay.ts';

const schema = {
  collections: [
    { path: '/rules', key: 'pattern' },
    { path: '/rules/restrictPushes', key: 'principal' },
  ],
  sets: ['/tags'],
};

describe('mergeOverlay', () => {
  it('[LIF-048] overlay values win over the translated document and the inputs are not changed', () => {
    const desired = { a: { b: 1, c: 2 }, tags: ['x'], name: 'old' };
    const overlay = { a: { b: 9 }, name: 'new', tags: ['y'] };
    const before = structuredClone(desired);
    expect(mergeOverlay(schema, desired, overlay)).toEqual({
      a: { b: 9, c: 2 },
      tags: ['y'],
      name: 'new',
    });
    expect(desired).toEqual(before);
  });

  it('[LIF-048] a keyed collection merges by key: matching elements merge, new ones are added', () => {
    const desired = {
      rules: [
        { pattern: 'main', enforcement: 'enforced', minApprovals: 1 },
        { pattern: 'dev', enforcement: 'advisory', minApprovals: 0 },
      ],
    };
    const overlay = {
      rules: [
        { pattern: 'main', minApprovals: 3 },
        { pattern: 'release', enforcement: 'enforced' },
      ],
    };
    expect(mergeOverlay(schema, desired, overlay)).toEqual({
      rules: [
        { pattern: 'main', enforcement: 'enforced', minApprovals: 3 },
        { pattern: 'dev', enforcement: 'advisory', minApprovals: 0 },
        { pattern: 'release', enforcement: 'enforced' },
      ],
    });
  });

  it('[LIF-048] collections nested in elements merge by their own key; principals key by kind and id', () => {
    const desired = {
      rules: [
        { pattern: 'main', restrictPushes: [{ principal: { kind: 'identity', id: '1' }, n: 1 }] },
      ],
    };
    const overlay = {
      rules: [
        {
          pattern: 'main',
          restrictPushes: [
            { principal: { kind: 'identity', id: '1' }, n: 2 },
            { principal: { kind: 'group', id: 'ops' }, n: 3 },
          ],
        },
      ],
    };
    expect(mergeOverlay(schema, desired, overlay)).toEqual({
      rules: [
        {
          pattern: 'main',
          restrictPushes: [
            { principal: { kind: 'identity', id: '1' }, n: 2 },
            { principal: { kind: 'group', id: 'ops' }, n: 3 },
          ],
        },
      ],
    });
  });

  it('[LIF-048] an overlay may add a member the desired document lacks', () => {
    expect(mergeOverlay(schema, { a: 1 }, { b: { c: 2 } })).toEqual({ a: 1, b: { c: 2 } });
  });
});
