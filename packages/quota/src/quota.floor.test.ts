import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { selectCredential } from './credentials.ts';
import { QuotaLockTimeoutError } from './db.ts';
import { QuotaLeases } from './leases.ts';
import { type BucketSpec, QuotaService } from './ledger.ts';

let testDb: TestDatabase;
let clock = new Date('2026-10-08T12:00:00.000Z');
const now = () => clock;
const advance = (seconds: number) => {
  clock = new Date(clock.getTime() + seconds * 1000);
};
const at = (seconds: number) => new Date(clock.getTime() + seconds * 1000);

let quota: QuotaService;
let counter = 0;
const newKey = (group = 'g') => `ep:floor${++counter}:${group}`;
const spec = (key: string, limit = 100, windowSeconds = 3600): BucketSpec => ({
  key,
  limit,
  windowSeconds,
});

beforeAll(async () => {
  testDb = await createTestDatabase('gm_t025f_');
}, 120_000);

afterAll(async () => {
  await testDb?.drop();
});

beforeEach(() => {
  clock = new Date('2026-10-08T12:00:00.000Z');
  quota = new QuotaService({ pool: testDb.db.pool, now });
});

const countEvents = async (key: string): Promise<number> => {
  const result = await testDb.db.pool.query<{ n: string }>(
    'SELECT count(*) AS n FROM app.quota_event WHERE bucket_key = $1',
    [key],
  );
  return Number(result.rows[0]?.n);
};

const grantMany = async (
  key: string,
  count: number,
  pool: 'background' | 'interactive',
  limit = 100,
  windowSeconds = 3600,
): Promise<number> => {
  let granted = 0;
  for (let i = 0; i < count; i++) {
    if ((await quota.acquire([spec(key, limit, windowSeconds)], pool)).granted) granted++;
  }
  return granted;
};

describe('reported use is a floor, never a replacement (ADR-0180)', () => {
  it('[JOB-043] a near-limit report after the ledger passed the background share never lets interactive exceed the effective limit', async () => {
    const key = newKey();
    await grantMany(key, 90, 'interactive');
    await quota.recordFeedback({
      bucketKey: key,
      limit: 100,
      windowSeconds: 3600,
      nearLimit: true,
    });
    expect(await grantMany(key, 50, 'interactive')).toBe(5);
    expect(await countEvents(key)).toBe(95);
  });

  it('[JOB-043] a near-limit report on every response never lets more than the effective limit through in a window', async () => {
    const key = newKey();
    let granted = 0;
    for (let i = 0; i < 200; i++) {
      granted += await grantMany(key, 1, 'interactive');
      await quota.recordFeedback({
        bucketKey: key,
        limit: 100,
        windowSeconds: 3600,
        nearLimit: true,
      });
    }
    expect(granted).toBe(95);
  });

  it('[JOB-043] the rolling window is not wiped when the stored reset passes', async () => {
    const key = newKey();
    await grantMany(key, 95, 'interactive');
    await quota.recordFeedback({
      bucketKey: key,
      limit: 100,
      windowSeconds: 3600,
      nearLimit: true,
    });
    advance(3599);
    expect(await grantMany(key, 1, 'interactive')).toBe(0);
    advance(2);
    expect(await grantMany(key, 1, 'interactive')).toBe(1);
  });

  it('[JOB-043] a near-limit call followed by a limit-only call keeps the background clamp until the window advances', async () => {
    const key = newKey();
    await quota.recordFeedback({
      bucketKey: key,
      limit: 100,
      windowSeconds: 3600,
      nearLimit: true,
    });
    await quota.recordFeedback({ bucketKey: key, limit: 100, windowSeconds: 3600 });
    expect(await grantMany(key, 1, 'background')).toBe(0);
    const bucket = (await quota.snapshot()).find((b) => b.bucketKey === key);
    expect(bucket).toMatchObject({ nearLimit: true, remaining: null });
    expect(bucket?.backgroundClampedUntil).toEqual(at(3600));
    advance(3601);
    expect(await grantMany(key, 1, 'background')).toBe(1);
    expect((await quota.snapshot()).find((b) => b.bucketKey === key)?.nearLimit).toBe(false);
  });

  it('[JOB-043] a configuration override takes effect once the provider window has passed', async () => {
    const key = newKey();
    await quota.recordFeedback({
      bucketKey: key,
      limit: 20,
      windowSeconds: 3600,
      remaining: 5,
      resetAt: at(60),
    });
    advance(61);
    const result = await quota.acquire([spec(key, 1000)], 'interactive');
    expect(result).toMatchObject({ granted: true });
    if (result.granted) expect(result.buckets[0]?.ceiling).toBe(950);
    expect((await quota.snapshot()).find((b) => b.bucketKey === key)).toMatchObject({
      limit: 1000,
      remaining: null,
    });
  });

  it('[JOB-045] a declared fixed window counts only events since its reset; a rolling one keeps the sliding count', async () => {
    const fixed = newKey('core');
    const rolling = newKey('core');
    await grantMany(fixed, 95, 'interactive');
    await grantMany(rolling, 95, 'interactive');
    const resetAt = at(60);
    await quota.recordFeedback({
      bucketKey: fixed,
      limit: 100,
      windowSeconds: 3600,
      remaining: 5,
      resetAt,
      fixedWindow: true,
    });
    await quota.recordFeedback({
      bucketKey: rolling,
      limit: 100,
      windowSeconds: 3600,
      remaining: 5,
      resetAt,
    });
    advance(61);
    expect(await grantMany(fixed, 1, 'interactive')).toBe(1);
    expect(await grantMany(rolling, 1, 'interactive')).toBe(0);
  });

  it('[JOB-045] requests in flight at report time are counted when the adapter passes observedSince', async () => {
    const key = newKey('core');
    const acquiredAt = clock;
    await grantMany(key, 10, 'interactive', 30, 60);
    advance(1);
    await quota.recordFeedback({
      bucketKey: key,
      limit: 30,
      windowSeconds: 60,
      remaining: 29,
      resetAt: at(60),
      observedSince: acquiredAt,
    });
    // effective limit is floor(30 x 0.95) = 28; reported use is 1 + 10 in flight = 11
    expect(await grantMany(key, 40, 'interactive', 30, 60)).toBe(17);
  });

  it('[JOB-045] without observedSince the sliding count still bounds the total', async () => {
    const key = newKey('core');
    await grantMany(key, 10, 'interactive', 30, 60);
    advance(1);
    await quota.recordFeedback({
      bucketKey: key,
      limit: 30,
      windowSeconds: 60,
      remaining: 29,
      resetAt: at(60),
    });
    expect(10 + (await grantMany(key, 40, 'interactive', 30, 60))).toBeLessThanOrEqual(28);
  });

  it('[JOB-045] a stale report from an earlier window does not overwrite a newer one', async () => {
    const key = newKey('core');
    await quota.recordFeedback({
      bucketKey: key,
      limit: 100,
      windowSeconds: 3600,
      remaining: 10,
      resetAt: at(600),
    });
    await quota.recordFeedback({
      bucketKey: key,
      limit: 100,
      windowSeconds: 3600,
      remaining: 90,
      resetAt: at(300),
    });
    expect((await quota.snapshot()).find((b) => b.bucketKey === key)?.remaining).toBe(10);
  });
});

describe('database clock', () => {
  it('[JOB-041] events are stamped from the database clock, not the application clock', async () => {
    const real = new QuotaService({ pool: testDb.db.pool });
    const key = newKey();
    const before = await testDb.db.pool.query<{ t: Date }>('SELECT clock_timestamp() AS t');
    await real.acquire([spec(key)], 'interactive');
    const after = await testDb.db.pool.query<{ t: Date }>('SELECT clock_timestamp() AS t');
    const stamped = await testDb.db.pool.query<{ at: Date }>(
      'SELECT at FROM app.quota_event WHERE bucket_key = $1',
      [key],
    );
    const t = stamped.rows[0]?.at.getTime() ?? 0;
    expect(t).toBeGreaterThanOrEqual((before.rows[0]?.t.getTime() ?? 0) - 1);
    expect(t).toBeLessThanOrEqual((after.rows[0]?.t.getTime() ?? 0) + 1);
  });

  it('[JOB-041] services without a test clock never over-grant, however many run in parallel', async () => {
    const services = [0, 1, 2].map(() => new QuotaService({ pool: testDb.db.pool }));
    const key = newKey();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        (services[i % 3] as QuotaService).acquire([spec(key, 10)], 'interactive'),
      ),
    );
    expect(results.filter((r) => r.granted)).toHaveLength(9);
  });

  it('[JOB-041] a lock wait that times out is a retryable error and frees the connection', async () => {
    const key = newKey();
    const holder = await testDb.db.pool.connect();
    try {
      await holder.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [`gm-quota:${key}`]);
      const error = await quota.acquire([spec(key, 10)], 'interactive').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(QuotaLockTimeoutError);
      expect((error as QuotaLockTimeoutError).retryable).toBe(true);
    } finally {
      await holder.query('SELECT pg_advisory_unlock_all()');
      holder.release();
    }
    expect((await quota.acquire([spec(key, 10)], 'interactive')).granted).toBe(true);
  }, 30_000);
});

describe('secondary-limit and validation edge cases', () => {
  const base = (key: string) => ({ bucketKey: key, limit: 100, windowSeconds: 3600 });

  it('[JOB-045] simultaneous secondary-limit hits count once and give a 60 s block', async () => {
    const key = newKey('core');
    const untils = await Promise.all(
      Array.from({ length: 10 }, () => quota.recordSecondaryLimit(base(key))),
    );
    for (const until of untils) expect(until).toEqual(at(60));
  });

  it('[JOB-045] retry-after wins on a fresh bucket and the counter still advances', async () => {
    const key = newKey('core');
    const first = await quota.recordSecondaryLimit({ ...base(key), retryAfterSeconds: 7 });
    expect(first).toEqual(at(7));
    clock = first;
    const second = await quota.recordSecondaryLimit(base(key));
    expect((second.getTime() - clock.getTime()) / 1000).toBe(120);
  });

  it('[JOB-045] a secondary-limit retry-after is clamped to 15 minutes', async () => {
    const until = await quota.recordSecondaryLimit({
      ...base(newKey('core')),
      retryAfterSeconds: 1e9,
    });
    expect(until).toEqual(at(900));
  });

  it('[JOB-044] retry-after is validated and clamped to 24 hours', async () => {
    const b = base(newKey());
    await expect(
      quota.recordRateLimited({ ...b, retryAfterSeconds: Number.NaN }),
    ).rejects.toThrow();
    await expect(quota.recordRateLimited({ ...b, retryAfterSeconds: -5 })).rejects.toThrow();
    await expect(
      quota.recordRateLimited({ ...b, retryAfterSeconds: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow();
    await expect(quota.recordSecondaryLimit({ ...b, retryAfterSeconds: -1 })).rejects.toThrow();
    await expect(quota.recordRateLimited({ ...b, minBlockSeconds: -1 })).rejects.toThrow();
    expect(await quota.recordRateLimited({ ...b, retryAfterSeconds: 1e12 })).toEqual(at(86_400));
  });

  it('[JOB-043] feedback numbers are validated', async () => {
    const b = base(newKey());
    await expect(quota.recordFeedback({ ...b, windowSeconds: 0 })).rejects.toThrow();
    await expect(quota.recordFeedback({ ...b, limit: 0 })).rejects.toThrow();
    await expect(quota.recordFeedback({ ...b, remaining: -1 })).rejects.toThrow();
    await expect(quota.recordFeedback({ ...b, remaining: Number.NaN })).rejects.toThrow();
    await expect(quota.recordFeedback({ ...b, resetAt: new Date('nope') })).rejects.toThrow();
    await expect(quota.recordFeedback({ ...b, observedSince: new Date('nope') })).rejects.toThrow();
    await expect(quota.recordFeedback({ ...b, bucketKey: 'bad#key' })).rejects.toThrow();
  });

  it('[JOB-040] acquire rejects an empty list and malformed or internal bucket keys', async () => {
    await expect(quota.acquire([], 'interactive')).rejects.toThrow(/at least one bucket/);
    await expect(quota.acquire([spec('nocolons', 10)], 'interactive')).rejects.toThrow(
      /Invalid bucket key/,
    );
    await expect(
      quota.acquire([spec(`${newKey()}#feedback`, 10)], 'interactive'),
    ).rejects.toThrow();
  });

  it('[JOB-042] a candidate with no buckets is rejected rather than winning with infinite capacity', async () => {
    await expect(
      selectCredential(quota, [{ credential: 'x', buckets: [] }], 'interactive'),
    ).rejects.toThrow(/at least one bucket/);
  });
});

describe('round 3 hardening', () => {
  it('[JOB-041] a granted acquire returns the database stamp used for its events', async () => {
    const result = await quota.acquire([spec(newKey())], 'interactive');
    expect(result.granted && result.at).toEqual(clock);
  });

  it('[JOB-045] a future observedSince never freezes the reported floor', async () => {
    const key = newKey('core');
    await grantMany(key, 1, 'interactive');
    await quota.recordFeedback({
      bucketKey: key,
      limit: 100,
      windowSeconds: 3600,
      remaining: 49,
      resetAt: at(3600),
      observedSince: at(5),
    });
    // reported use is 51 plus the grant since the clamped observation point
    expect(await grantMany(key, 200, 'interactive')).toBeLessThanOrEqual(44);
  });

  it('[JOB-045] a far-future resetAt is clamped and a later correct report is accepted', async () => {
    const key = newKey('core');
    await quota.recordFeedback({
      bucketKey: key,
      limit: 100,
      windowSeconds: 3600,
      remaining: 0,
      resetAt: new Date('2100-01-01T00:00:00Z'),
    });
    const stored = (await quota.snapshot()).find((b) => b.bucketKey === key);
    expect(stored?.resetAt?.getTime()).toBeLessThanOrEqual(at(3660).getTime());
    advance(3661);
    await quota.recordFeedback({
      bucketKey: key,
      limit: 100,
      windowSeconds: 3600,
      remaining: 50,
      resetAt: at(600),
    });
    expect((await quota.snapshot()).find((b) => b.bucketKey === key)?.remaining).toBe(50);
  });

  it('[JOB-045] a report without remaining keeps the live floor of its window', async () => {
    const key = newKey('core');
    await quota.recordFeedback({
      bucketKey: key,
      limit: 100,
      windowSeconds: 3600,
      remaining: 3,
      resetAt: at(600),
    });
    await quota.recordFeedback({ bucketKey: key, limit: 100, windowSeconds: 3600 });
    expect(await grantMany(key, 5, 'interactive')).toBe(0);
    expect((await quota.snapshot()).find((b) => b.bucketKey === key)?.remaining).toBe(3);
  });

  it('[JOB-045] lease inputs are validated', async () => {
    const leases = new QuotaLeases({ pool: testDb.db.pool, now });
    await expect(leases.acquire(newKey('c'), 'pod', Number.NaN)).rejects.toThrow(/Invalid cap/);
    await expect(leases.acquire(newKey('c'), 'pod', 0)).rejects.toThrow(/Invalid cap/);
    await expect(leases.acquire('bad', 'pod', 1)).rejects.toThrow(/Invalid bucket key/);
  });

  it('[JOB-047] per-pool snapshot counts agree with used after a fixed-window reset', async () => {
    const key = newKey('core');
    await grantMany(key, 50, 'background');
    await grantMany(key, 45, 'interactive');
    await quota.recordFeedback({
      bucketKey: key,
      limit: 100,
      windowSeconds: 3600,
      remaining: 5,
      resetAt: at(60),
      fixedWindow: true,
    });
    advance(61);
    await grantMany(key, 1, 'interactive');
    const bucket = (await quota.snapshot()).find((b) => b.bucketKey === key);
    expect(bucket?.used).toBe(1);
    expect((bucket?.usedBackground ?? 0) + (bucket?.usedInteractive ?? 0)).toBe(1);
  });
});
