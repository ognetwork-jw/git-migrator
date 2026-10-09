import { AdapterError } from '@git-migrator/adapter-sdk';
import type { FieldDiff } from '@git-migrator/core';
import { describe, expect, it } from 'vitest';
import { applyContainment, checkLfsObjects, MAX_LISTED_OIDS, type RefRelation } from './git.ts';

const ref = (name: string, target: string, peeled?: string) => ({
  name,
  target,
  ...(peeled ? { peeled } : {}),
});
const diffOf = (name: string, field: string, desired: unknown, actual: unknown): FieldDiff => ({
  path: `/refs[name=${name}]/${field}`,
  desired,
  actual,
});

const relations = (table: Record<string, RefRelation>) => {
  const calls: string[] = [];
  return {
    calls,
    compare: async (base: string, head: string): Promise<RefRelation> => {
      calls.push(`${base}...${head}`);
      const relation = table[`${base}...${head}`];
      if (!relation) throw new AdapterError({ code: 'not_found', provider: 'x', message: 'no' });
      return relation;
    },
  };
};

describe('post-cutover containment (FAC-GIT-006)', () => {
  const desired = {
    refs: [ref('refs/heads/main', 'a1'), ref('refs/heads/dev', 'd1'), ref('refs/tags/v1', 't1')],
  };

  it('[FAC-GIT-006] a target ref that is ahead of the source passes; one that is behind or diverged does not', async () => {
    const actual = {
      refs: [ref('refs/heads/main', 'a2'), ref('refs/heads/dev', 'd0'), ref('refs/tags/v1', 'tx')],
    };
    const diffs = [
      diffOf('refs/heads/main', 'target', 'a1', 'a2'),
      diffOf('refs/heads/dev', 'target', 'd1', 'd0'),
      diffOf('refs/tags/v1', 'target', 't1', 'tx'),
    ];
    const r = relations({ 'a1...a2': 'ahead', 'd1...d0': 'behind', 't1...tx': 'diverged' });
    const kept = await applyContainment({ diffs, desired, actual, compare: r.compare });
    expect(kept.map((d) => d.path)).toEqual([
      '/refs[name=refs/heads/dev]/target',
      '/refs[name=refs/tags/v1]/target',
    ]);
  });

  it('[FAC-GIT-006] extra target refs are allowed, and a ref missing on the target is a difference', async () => {
    const actual = { refs: [ref('refs/heads/main', 'a1'), ref('refs/heads/feature', 'f1')] };
    const diffs = [
      diffOf('refs/heads/feature', 'target', undefined, 'f1'),
      diffOf('refs/heads/dev', 'target', 'd1', undefined),
      diffOf('refs/tags/v1', 'target', 't1', undefined),
    ];
    const kept = await applyContainment({
      diffs,
      desired,
      actual,
      compare: relations({}).compare,
    });
    expect(kept.map((d) => d.path)).toEqual([
      '/refs[name=refs/heads/dev]/target',
      '/refs[name=refs/tags/v1]/target',
    ]);
  });

  it('[FAC-GIT-006] a commit the target does not know counts as diverged; other errors propagate', async () => {
    const actual = { refs: [ref('refs/heads/main', 'zz')] };
    const diffs = [diffOf('refs/heads/main', 'target', 'a1', 'zz')];
    const kept = await applyContainment({
      diffs,
      desired,
      actual,
      compare: relations({}).compare,
    });
    expect(kept).toHaveLength(1);
    await expect(
      applyContainment({
        diffs,
        desired,
        actual,
        compare: async () => {
          throw new AdapterError({ code: 'transient', provider: 'x', message: 'boom' });
        },
      }),
    ).rejects.toMatchObject({ code: 'transient' });
  });

  it('[FAC-GIT-006] the default branch is not relaxed, and an annotated tag compares by its commit', async () => {
    const d = { refs: [ref('refs/tags/v1', 'tagobj1', 'c1')] };
    const a = { refs: [ref('refs/tags/v1', 'tagobj2', 'c1')] };
    const r = relations({});
    const kept = await applyContainment({
      diffs: [
        { path: '/defaultBranch', desired: 'main', actual: 'trunk' },
        diffOf('refs/tags/v1', 'target', 'tagobj1', 'tagobj2'),
      ],
      desired: d,
      actual: a,
      compare: r.compare,
    });
    expect(kept.map((x) => x.path)).toEqual(['/defaultBranch']);
    expect(r.calls).toEqual([]); // same commit: no API call
  });

  it('[FAC-GIT-006] one compare call serves all the diffs of a ref', async () => {
    const actual = { refs: [ref('refs/heads/main', 'a2')] };
    const r = relations({ 'a1...a2': 'identical' });
    const kept = await applyContainment({
      diffs: [
        diffOf('refs/heads/main', 'target', 'a1', 'a2'),
        diffOf('refs/heads/main', 'kind', 'branch', 'branch'),
      ],
      desired,
      actual,
      compare: r.compare,
    });
    expect(kept).toEqual([]);
    expect(r.calls).toHaveLength(1);
  });
});

describe('LFS parity (FAC-GIT-005)', () => {
  const object = (n: number) => ({ oid: n.toString(16).padStart(64, '0'), size: n });

  it('[FAC-GIT-005] reports the objects the target cannot serve at /lfs/oids', async () => {
    const objects = [object(1), object(2), object(3)];
    const result = await checkLfsObjects({
      objects,
      missing: async (oids) => oids.filter((o) => o === objects[1]?.oid),
    });
    expect(result.checked).toBe(3);
    expect(result.diffs).toEqual([{ path: '/lfs/oids', desired: [objects[1]?.oid], actual: [] }]);
  });

  it('[FAC-GIT-005] nothing missing, or nothing referenced, is no difference', async () => {
    expect(
      (await checkLfsObjects({ objects: [object(1)], missing: async () => [] })).diffs,
    ).toEqual([]);
    const none = await checkLfsObjects({
      objects: [],
      missing: async () => {
        throw new Error('not called');
      },
    });
    expect(none).toEqual({ checked: 0, diffs: [] });
  });

  it('[FAC-GIT-005] objects are asked for in groups of at most 100, and the listing is capped', async () => {
    const objects = Array.from({ length: 250 }, (_, i) => object(i + 1));
    const groups: number[] = [];
    const result = await checkLfsObjects({
      objects,
      missing: async (oids) => {
        groups.push(oids.length);
        return oids;
      },
    });
    expect(groups).toEqual([100, 100, 50]);
    const listed = result.diffs[0]?.desired as string[] | undefined;
    expect(listed).toHaveLength(MAX_LISTED_OIDS);
  });

  it('[FAC-GIT-005] a failing batch call propagates, so the Facet is unverifiable and not equal', async () => {
    await expect(
      checkLfsObjects({
        objects: [object(1)],
        missing: async () => {
          throw new AdapterError({ code: 'transient', provider: 'x', message: 'boom' });
        },
      }),
    ).rejects.toMatchObject({ code: 'transient' });
  });
});
