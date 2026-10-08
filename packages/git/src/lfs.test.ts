import { describe, expect, it } from 'vitest';
import { type LfsBatchClient, lfsBytes, verifyLfsParity } from './lfs.ts';

const oid = (n: number): string => n.toString(16).padStart(64, '0');
const objects = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ oid: oid(i), size: i + 1 }));

describe('verifyLfsParity (FAC-GIT-005)', () => {
  it('[FAC-GIT-005] checks in groups of at most 100 objects and reports what the target cannot serve', async () => {
    const sizes: number[] = [];
    const batch: LfsBatchClient = {
      async download(group) {
        sizes.push(group.length);
        return group.map((o) => {
          const n = Number.parseInt(o.oid, 16);
          if (n % 50 === 7) return { oid: o.oid, error: { code: 404, message: 'missing' } };
          if (n === 3) return { oid: o.oid, error: { code: 500, message: 'boom' } };
          if (n === 4) return { oid: o.oid };
          return { oid: o.oid, actions: { download: { href: 'x' } } };
        });
      },
    };
    const result = await verifyLfsParity(batch, objects(230), { batchSize: 500 });
    expect(sizes).toEqual([100, 100, 30]);
    expect(result.checked).toBe(230);
    expect(result.missing).toEqual([oid(4), oid(7), oid(57), oid(107), oid(157), oid(207)]);
    expect(result.failed).toEqual([{ oid: oid(3), code: 500, message: 'boom' }]);
  });

  it('[FAC-GIT-005] a response that omits an object is an error, and nothing to check costs no call', async () => {
    const batch: LfsBatchClient = { download: async () => [] };
    await expect(verifyLfsParity(batch, objects(1))).rejects.toMatchObject({ code: 'invalid' });
    const never: LfsBatchClient = {
      download: async () => {
        throw new Error('called');
      },
    };
    expect(await verifyLfsParity(never, [])).toEqual({ checked: 0, missing: [], failed: [] });
  });

  it('[JOB-015] sums LFS bytes for the size class', () => {
    expect(
      lfsBytes([
        { oid: oid(1), size: 10, paths: [], downloaded: false },
        { oid: oid(2), size: 32, paths: [], downloaded: true },
      ]),
    ).toBe(42);
  });
});

describe('verifyLfsParity batch size', () => {
  it('[FAC-GIT-005] refuses a batch size below 1 instead of looping forever', async () => {
    const batch: LfsBatchClient = { download: async () => [] };
    for (const batchSize of [0, -5, 1.5, Number.NaN]) {
      await expect(verifyLfsParity(batch, objects(3), { batchSize })).rejects.toMatchObject({
        code: 'invalid',
      });
    }
  });
});
