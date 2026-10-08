import type { QuotaGate } from '@git-migrator/adapter-sdk';
import { describe, expect, it } from 'vitest';
import { createGitQuota, GIT_UNITS, lfsUnits } from './quota.ts';

type Acquire = QuotaGate['acquire'];

function gate(result: Awaited<ReturnType<Acquire>>) {
  const calls: Parameters<Acquire>[] = [];
  return {
    calls,
    acquire: async (...args: Parameters<Acquire>) => {
      calls.push(args);
      return result;
    },
  };
}

describe('git quota (JOB-041)', () => {
  it('[JOB-041] costs: ls-remote 1, fetch and clone 3, push 3', () => {
    expect(GIT_UNITS).toEqual({ lsRemote: 1, fetch: 3, clone: 3, push: 3 });
  });

  it('[JOB-041] LFS costs 1 unit per 100 objects', () => {
    expect([0, 1, 99, 100, 101, 250, 10_000].map(lfsUnits)).toEqual([0, 1, 1, 1, 2, 3, 100]);
    expect(lfsUnits(-5)).toBe(0);
  });

  it('[JOB-041] acquires units from the git bucket in the given pool', async () => {
    const g = gate({ granted: true, at: new Date(), buckets: [] });
    const quota = createGitQuota({
      gate: g,
      bucketKey: 'ep1:acct:git',
      limit: 60_000,
      windowSeconds: 3600,
      pool: 'background',
    });
    await quota.acquire(3);
    await quota.acquire(0);
    expect(g.calls).toEqual([
      [[{ key: 'ep1:acct:git', limit: 60_000, windowSeconds: 3600, units: 3 }], 'background'],
    ]);
  });

  it('[JOB-044] a denied acquire is rate_limited with the time quota frees', async () => {
    const retryAt = new Date('2026-01-01T00:10:00Z');
    const g = gate({ granted: false, reason: 'limit', bucketKey: 'ep1:acct:git', retryAt });
    const quota = createGitQuota({
      gate: g,
      bucketKey: 'ep1:acct:git',
      limit: 10,
      windowSeconds: 60,
      pool: 'interactive',
      now: () => new Date('2026-01-01T00:09:00Z'),
    });
    const error = await quota.acquire(1).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'rate_limited',
      retryable: true,
      retryAt,
      retryAfterMs: 60_000,
    });
  });
});
