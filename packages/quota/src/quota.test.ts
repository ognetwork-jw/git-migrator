import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { selectCredential } from './credentials.ts';
import { QuotaLeases } from './leases.ts';
import { type BucketSpec, type QuotaMetricsSink, QuotaService } from './ledger.ts';

let testDb: TestDatabase;
let clock = new Date('2026-10-08T12:00:00.000Z');
const now = () => clock;
const advance = (seconds: number) => {
  clock = new Date(clock.getTime() + seconds * 1000);
};
const at = (seconds: number) => new Date(clock.getTime() + seconds * 1000);

interface Gauges {
  used: Map<string, number>;
  limit: Map<string, number>;
}
const gauges: Gauges = { used: new Map(), limit: new Map() };
const sink: QuotaMetricsSink = {
  setQuotaUsed: (bucket, pool, value) => gauges.used.set(`${bucket}|${pool}`, value),
  setQuotaLimit: (bucket, value) => gauges.limit.set(bucket, value),
};

let quota: QuotaService;
let leases: QuotaLeases;
let counter = 0;
const newKey = (group = 'g') => `ep:acct${++counter}:${group}`;
const spec = (key: string, limit = 100, windowSeconds = 3600, units?: number): BucketSpec =>
  units === undefined ? { key, limit, windowSeconds } : { key, limit, windowSeconds, units };

beforeAll(async () => {
  testDb = await createTestDatabase('gm_t025_');
}, 120_000);

afterAll(async () => {
  await testDb?.drop();
});

beforeEach(() => {
  clock = new Date('2026-10-08T12:00:00.000Z');
  gauges.used.clear();
  gauges.limit.clear();
  quota = new QuotaService({ pool: testDb.db.pool, metrics: sink, now });
  leases = new QuotaLeases({ pool: testDb.db.pool, now });
});

const countEvents = async (key: string): Promise<number> => {
  const result = await testDb.db.pool.query<{ n: string }>(
    'SELECT count(*) AS n FROM app.quota_event WHERE bucket_key = $1',
    [key],
  );
  return Number(result.rows[0]?.n);
};

describe('sliding-window ledger', () => {
  it('[JOB-041] grants while count < floor(limit x 0.95) and records one event per grant', async () => {
    const key = newKey();
    // limit 10 -> effective floor(9.5) = 9
    for (let i = 0; i < 9; i++) {
      const result = await quota.acquire([spec(key, 10)], 'interactive');
      expect(result.granted).toBe(true);
    }
    const denied = await quota.acquire([spec(key, 10)], 'interactive');
    expect(denied).toMatchObject({ granted: false, reason: 'limit', bucketKey: key });
    expect(await countEvents(key)).toBe(9);
  });

  it('[JOB-041] counts events in the window only: old events fall out and capacity returns', async () => {
    const key = newKey();
    for (let i = 0; i < 9; i++) await quota.acquire([spec(key, 10, 60)], 'interactive');
    expect((await quota.acquire([spec(key, 10, 60)], 'interactive')).granted).toBe(false);
    advance(61);
    expect((await quota.acquire([spec(key, 10, 60)], 'interactive')).granted).toBe(true);
  });

  it('[JOB-041] a denial reports when the oldest needed event leaves the window', async () => {
    const key = newKey();
    for (let i = 0; i < 9; i++) {
      await quota.acquire([spec(key, 10, 60)], 'interactive');
      advance(1);
    }
    const first = new Date('2026-10-08T12:00:00.000Z');
    const denied = await quota.acquire([spec(key, 10, 60)], 'interactive');
    expect(denied).toMatchObject({ granted: false });
    if (!denied.granted) expect(denied.retryAt).toEqual(new Date(first.getTime() + 60_000));
  });

  it('[JOB-041] background is granted only while count < floor(effective x 0.9); interactive keeps the headroom', async () => {
    const key = newKey();
    // limit 100 -> effective 95 -> background cap 85
    for (let i = 0; i < 85; i++) {
      expect((await quota.acquire([spec(key, 100)], 'background')).granted).toBe(true);
    }
    const bg = await quota.acquire([spec(key, 100)], 'background');
    expect(bg).toMatchObject({ granted: false, reason: 'pool' });
    for (let i = 0; i < 10; i++) {
      expect((await quota.acquire([spec(key, 100)], 'interactive')).granted).toBe(true);
    }
    expect(await quota.acquire([spec(key, 100)], 'interactive')).toMatchObject({
      granted: false,
      reason: 'limit',
    });
  });

  it('[JOB-041] the count is all events, background and interactive together', async () => {
    const key = newKey();
    for (let i = 0; i < 80; i++) await quota.acquire([spec(key, 100)], 'interactive');
    for (let i = 0; i < 5; i++) {
      expect((await quota.acquire([spec(key, 100)], 'background')).granted).toBe(true);
    }
    expect((await quota.acquire([spec(key, 100)], 'background')).granted).toBe(false);
  });

  it('[JOB-041] a request counted in two groups acquires both, or neither', async () => {
    const files = newKey('raw-files');
    const data = newKey('repository-data');
    for (let i = 0; i < 9; i++) await quota.acquire([spec(data, 10)], 'interactive');
    const denied = await quota.acquire([spec(files, 10), spec(data, 10)], 'interactive');
    expect(denied).toMatchObject({ granted: false, bucketKey: data });
    expect(await countEvents(files)).toBe(0);
    const ok = await quota.acquire([spec(files, 10), spec(newKey(), 10)], 'interactive');
    expect(ok.granted).toBe(true);
  });

  it('[JOB-041] units charge several events at once (git fetch costs 3)', async () => {
    const key = newKey('git');
    const granted = await quota.acquire([spec(key, 100, 3600, 3)], 'interactive');
    expect(granted.granted).toBe(true);
    expect(await countEvents(key)).toBe(3);
    // 95 effective: 92 left; 31 fetches would need 93.
    for (let i = 0; i < 30; i++) await quota.acquire([spec(key, 100, 3600, 3)], 'interactive');
    expect((await quota.acquire([spec(key, 100, 3600, 3)], 'interactive')).granted).toBe(false);
    expect((await quota.acquire([spec(key, 100, 3600, 1)], 'interactive')).granted).toBe(true);
  });

  it('[JOB-041] invalid specs are rejected', async () => {
    await expect(quota.acquire([spec(newKey(), 10, 60, 0)], 'interactive')).rejects.toThrow();
    await expect(quota.acquire([spec(newKey(), -1)], 'interactive')).rejects.toThrow();
    await expect(quota.acquire([spec(newKey(), 10, 0)], 'interactive')).rejects.toThrow();
  });

  it('[JOB-041] custom safetyFactor and backgroundShare are honored', async () => {
    const custom = new QuotaService({
      pool: testDb.db.pool,
      tuning: { safetyFactor: 0.5, backgroundShare: 0.5 },
      now,
    });
    const key = newKey();
    // limit 100 -> effective 50 -> background 25
    for (let i = 0; i < 25; i++) await custom.acquire([spec(key, 100)], 'background');
    expect((await custom.acquire([spec(key, 100)], 'background')).granted).toBe(false);
    expect((await custom.acquire([spec(key, 100)], 'interactive')).granted).toBe(true);
  });
});

describe('concurrency', () => {
  it('[JOB-041] 20 parallel acquirers never exceed the limit', async () => {
    const key = newKey();
    // limit 10 -> effective 9
    const results = await Promise.all(
      Array.from({ length: 20 }, () => quota.acquire([spec(key, 10)], 'interactive')),
    );
    expect(results.filter((r) => r.granted)).toHaveLength(9);
    expect(results.filter((r) => !r.granted)).toHaveLength(11);
    expect(await countEvents(key)).toBe(9);
  });

  it('[JOB-041] 20 parallel background acquirers stay within the background share', async () => {
    const key = newKey();
    // limit 20 -> effective 19 -> background floor(17.1) = 17
    const results = await Promise.all(
      Array.from({ length: 20 }, () => quota.acquire([spec(key, 20)], 'background')),
    );
    expect(results.filter((r) => r.granted)).toHaveLength(17);
  });

  it('[JOB-041] opposite-ordered multi-bucket acquirers do not deadlock and stay within limits', async () => {
    const a = newKey('a');
    const b = newKey('b');
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        quota.acquire(
          i % 2 === 0 ? [spec(a, 10), spec(b, 10)] : [spec(b, 10), spec(a, 10)],
          'interactive',
        ),
      ),
    );
    expect(results.filter((r) => r.granted)).toHaveLength(9);
    expect(await countEvents(a)).toBe(9);
    expect(await countEvents(b)).toBe(9);
  });
});

describe('credential selection', () => {
  it('[JOB-042] picks the credential whose bucket has the most free capacity', async () => {
    const busy = newKey();
    const idle = newKey();
    for (let i = 0; i < 50; i++) await quota.acquire([spec(busy, 100)], 'interactive');
    const chosen = await selectCredential(
      quota,
      [
        { credential: 'busy', buckets: [spec(busy, 100)] },
        { credential: 'idle', buckets: [spec(idle, 100)] },
      ],
      'interactive',
    );
    expect(chosen).toEqual({ credential: 'idle', free: 95 });
  });

  it("[JOB-042] free capacity is the smallest across a credential's buckets and respects the pool", async () => {
    const x = newKey('x');
    const y = newKey('y');
    for (let i = 0; i < 80; i++) await quota.acquire([spec(y, 100)], 'interactive');
    const chosen = await selectCredential(
      quota,
      [
        { credential: 'one', buckets: [spec(x, 100), spec(y, 100)] },
        { credential: 'two', buckets: [spec(newKey(), 100)] },
      ],
      'background',
    );
    expect(chosen?.credential).toBe('two');
    expect(chosen?.free).toBe(85);
  });

  it('[JOB-042] credentials of one account tie because they share a bucket; blocked ones lose', async () => {
    const shared = newKey();
    const other = newKey();
    await quota.recordRateLimited({
      bucketKey: other,
      limit: 100,
      windowSeconds: 3600,
      retryAfterSeconds: 30,
    });
    const chosen = await selectCredential(
      quota,
      [
        { credential: 'blocked', buckets: [spec(other, 100)] },
        { credential: 'a', buckets: [spec(shared, 100)] },
        { credential: 'b', buckets: [spec(shared, 100)] },
      ],
      'interactive',
    );
    expect(chosen?.credential).toBe('a');
    expect(await selectCredential(quota, [], 'interactive')).toBeUndefined();
  });

  it('[JOB-042] when every credential is blocked the earliest to unblock is chosen', async () => {
    const early = newKey();
    const late = newKey();
    await quota.recordRateLimited({
      bucketKey: late,
      limit: 100,
      windowSeconds: 3600,
      retryAfterSeconds: 300,
    });
    await quota.recordRateLimited({
      bucketKey: early,
      limit: 100,
      windowSeconds: 3600,
      retryAfterSeconds: 30,
    });
    const chosen = await selectCredential(
      quota,
      [
        { credential: 'late', buckets: [spec(late, 100)] },
        { credential: 'early', buckets: [spec(early, 100)] },
      ],
      'interactive',
    );
    expect(chosen?.credential).toBe('early');
  });
});

describe('provider feedback', () => {
  it('[JOB-043] a near-limit signal clamps background to 0 but keeps interactive, until the window advances', async () => {
    const key = newKey();
    await quota.recordFeedback({
      bucketKey: key,
      limit: 1000,
      windowSeconds: 3600,
      nearLimit: true,
    });
    expect(await quota.acquire([spec(key, 1000)], 'background')).toMatchObject({
      granted: false,
      reason: 'pool',
    });
    expect((await quota.acquire([spec(key, 1000)], 'interactive')).granted).toBe(true);
    advance(3601);
    expect((await quota.acquire([spec(key, 1000)], 'background')).granted).toBe(true);
  });

  it('[JOB-043] a reported limit replaces the configured one while its window is live', async () => {
    const key = newKey();
    await quota.recordFeedback({ bucketKey: key, limit: 20, windowSeconds: 3600 });
    // configured 1000, reported 20 -> effective 19
    for (let i = 0; i < 19; i++) await quota.acquire([spec(key, 1000)], 'interactive');
    expect((await quota.acquire([spec(key, 1000)], 'interactive')).granted).toBe(false);
    advance(3601);
    expect((await quota.acquire([spec(key, 1000)], 'interactive')).granted).toBe(true);
  });

  it('[JOB-043] the configured limit follows config changes when no feedback is live', async () => {
    const key = newKey();
    await quota.acquire([spec(key, 10)], 'interactive');
    const result = await quota.acquire([spec(key, 1000)], 'interactive');
    expect(result).toMatchObject({ granted: true });
    if (result.granted) expect(result.buckets[0]?.ceiling).toBe(950);
  });

  it('[JOB-045] remaining and reset drive used = limit - remaining and the same pool rule', async () => {
    const key = newKey('core');
    const resetAt = at(1800);
    await quota.recordFeedback({
      bucketKey: key,
      limit: 5000,
      windowSeconds: 3600,
      remaining: 5000 - 4300,
      resetAt,
    });
    // used 4300 > background cap floor(4750 x 0.9) = 4275 -> background denied, interactive ok
    expect(await quota.acquire([spec(key, 5000)], 'background')).toMatchObject({
      granted: false,
      reason: 'pool',
      retryAt: resetAt,
    });
    expect((await quota.acquire([spec(key, 5000)], 'interactive')).granted).toBe(true);
    await quota.recordFeedback({
      bucketKey: key,
      limit: 5000,
      windowSeconds: 3600,
      remaining: 5000 - 4750,
      resetAt,
    });
    expect(await quota.acquire([spec(key, 5000)], 'interactive')).toMatchObject({
      granted: false,
      reason: 'limit',
      retryAt: resetAt,
    });
  });

  it('[JOB-045] buckets are per resource: one exhausted resource does not block another', async () => {
    const core = newKey('core');
    const graphql = newKey('graphql');
    await quota.recordFeedback({
      bucketKey: core,
      limit: 5000,
      windowSeconds: 3600,
      remaining: 0,
      resetAt: at(600),
    });
    expect((await quota.acquire([spec(core, 5000)], 'interactive')).granted).toBe(false);
    expect((await quota.acquire([spec(graphql, 5000)], 'interactive')).granted).toBe(true);
  });

  it('[JOB-045] grants made after a report add to the reported use', async () => {
    const key = newKey('core');
    await quota.recordFeedback({
      bucketKey: key,
      limit: 100,
      windowSeconds: 3600,
      remaining: 10,
      resetAt: at(600),
    });
    advance(1);
    // effective 95, used 90 -> 5 grants left
    for (let i = 0; i < 5; i++) {
      expect((await quota.acquire([spec(key, 100)], 'interactive')).granted).toBe(true);
    }
    expect((await quota.acquire([spec(key, 100)], 'interactive')).granted).toBe(false);
  });

  it('[JOB-045] after the provider window resets, only grants since the reset count', async () => {
    const key = newKey('core');
    await quota.recordFeedback({
      bucketKey: key,
      limit: 100,
      windowSeconds: 3600,
      remaining: 0,
      resetAt: at(60),
    });
    expect((await quota.acquire([spec(key, 100)], 'interactive')).granted).toBe(false);
    advance(61);
    expect((await quota.acquire([spec(key, 100)], 'interactive')).granted).toBe(true);
  });

  it('[JOB-045] out-of-order responses keep the smallest remaining within one window', async () => {
    const key = newKey('core');
    const resetAt = at(600);
    await quota.recordFeedback({
      bucketKey: key,
      limit: 100,
      windowSeconds: 3600,
      remaining: 10,
      resetAt,
    });
    await quota.recordFeedback({
      bucketKey: key,
      limit: 100,
      windowSeconds: 3600,
      remaining: 40,
      resetAt,
    });
    const snapshot = (await quota.snapshot()).find((b) => b.bucketKey === key);
    expect(snapshot?.remaining).toBe(10);
  });

  it('[JOB-045] GraphQL estimates reconcile with the reported cost', async () => {
    const key = newKey('graphql');
    await quota.acquire([spec(key, 100)], 'interactive');
    await quota.adjust(key, 'interactive', 4);
    expect(await countEvents(key)).toBe(5);
    await quota.adjust(key, 'interactive', -2);
    expect(await countEvents(key)).toBe(3);
    await quota.adjust(key, 'interactive', 0);
    expect(await countEvents(key)).toBe(3);
  });
});

describe('blockedUntil', () => {
  it('[JOB-044] honors Retry-After and refuses every pool until then', async () => {
    const key = newKey();
    const until = await quota.recordRateLimited({
      bucketKey: key,
      limit: 100,
      windowSeconds: 3600,
      retryAfterSeconds: 90,
    });
    expect(until).toEqual(at(90));
    for (const pool of ['background', 'interactive'] as const) {
      expect(await quota.acquire([spec(key, 100)], pool)).toMatchObject({
        granted: false,
        reason: 'blocked',
        retryAt: until,
      });
    }
    advance(91);
    expect((await quota.acquire([spec(key, 100)], 'interactive')).granted).toBe(true);
  });

  it('[JOB-044] without Retry-After blocks until the oldest event in the window leaves it', async () => {
    const key = newKey();
    await quota.acquire([spec(key, 100, 600)], 'interactive');
    const first = clock;
    advance(100);
    await quota.acquire([spec(key, 100, 600)], 'interactive');
    const until = await quota.recordRateLimited({ bucketKey: key, limit: 100, windowSeconds: 600 });
    expect(until).toEqual(new Date(first.getTime() + 600_000));
  });

  it('[JOB-044] applies the minimum block (60 s) when the oldest event would free sooner', async () => {
    const key = newKey();
    await quota.acquire([spec(key, 100, 600)], 'interactive');
    advance(590);
    const until = await quota.recordRateLimited({
      bucketKey: key,
      limit: 100,
      windowSeconds: 600,
      minBlockSeconds: 60,
    });
    expect(until).toEqual(at(60));
  });

  it('[JOB-044] an empty window blocks for one window, and a block is never shortened', async () => {
    const key = newKey();
    const long = await quota.recordRateLimited({ bucketKey: key, limit: 100, windowSeconds: 600 });
    expect(long).toEqual(at(600));
    const shorter = await quota.recordRateLimited({
      bucketKey: key,
      limit: 100,
      windowSeconds: 600,
      retryAfterSeconds: 5,
    });
    expect(shorter).toEqual(long);
  });

  it('[JOB-044] the request that hit the 429 still counts in the ledger', async () => {
    const key = newKey();
    await quota.acquire([spec(key, 100)], 'interactive');
    await quota.recordRateLimited({
      bucketKey: key,
      limit: 100,
      windowSeconds: 3600,
      retryAfterSeconds: 10,
    });
    expect(await countEvents(key)).toBe(1);
  });

  it('[JOB-047] a blocked bucket reports blockedUntil in the snapshot, and clears when it passes', async () => {
    const key = newKey();
    const until = await quota.recordRateLimited({
      bucketKey: key,
      limit: 100,
      windowSeconds: 3600,
      retryAfterSeconds: 30,
    });
    expect((await quota.snapshot()).find((b) => b.bucketKey === key)?.blockedUntil).toEqual(until);
    advance(31);
    expect((await quota.snapshot()).find((b) => b.bucketKey === key)?.blockedUntil).toBeNull();
  });

  it('[JOB-045] a secondary-limit hit waits retry-after, else 60 s doubled per consecutive hit, capped at 15 min', async () => {
    const key = newKey('core');
    const input = { bucketKey: key, limit: 100, windowSeconds: 3600 };
    const waits: number[] = [];
    for (let i = 0; i < 7; i++) {
      const until = await quota.recordSecondaryLimit(input);
      waits.push((until.getTime() - clock.getTime()) / 1000);
      clock = until;
    }
    expect(waits).toEqual([60, 120, 240, 480, 900, 900, 900]);
    const explicit = await quota.recordSecondaryLimit({ ...input, retryAfterSeconds: 7 });
    expect(explicit.getTime()).toBeGreaterThan(clock.getTime());
  });

  it('[JOB-045] the secondary backoff resets after a quiet period', async () => {
    const key = newKey('core');
    const input = { bucketKey: key, limit: 100, windowSeconds: 3600 };
    const first = await quota.recordSecondaryLimit(input);
    clock = new Date(first.getTime() + 16 * 60 * 1000);
    const second = await quota.recordSecondaryLimit(input);
    expect((second.getTime() - clock.getTime()) / 1000).toBe(60);
  });
});

describe('concurrency leases', () => {
  it('[JOB-045] refuses the insert when the unexpired count reaches the cap, and release frees a slot', async () => {
    const key = newKey('concurrent');
    const ids: bigint[] = [];
    for (let i = 0; i < 3; i++) {
      const id = await leases.acquire(key, `pod-${i}`, 3);
      expect(id).toBeDefined();
      if (id !== undefined) ids.push(id);
    }
    expect(await leases.acquire(key, 'pod-x', 3)).toBeUndefined();
    await leases.release(ids[0] as bigint);
    expect(await leases.acquire(key, 'pod-x', 3)).toBeDefined();
  });

  it('[JOB-045] a lease expires after 60 s', async () => {
    const key = newKey('concurrent');
    expect(await leases.acquire(key, 'a', 1)).toBeDefined();
    expect(await leases.acquire(key, 'b', 1)).toBeUndefined();
    advance(61);
    expect(await leases.acquire(key, 'b', 1)).toBeDefined();
  });

  it('[JOB-045] 20 parallel lease requests never exceed the cap across pods', async () => {
    const key = newKey('concurrent');
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => leases.acquire(key, `pod-${i}`, 10)),
    );
    expect(results.filter((id) => id !== undefined)).toHaveLength(10);
  });
});

describe('pruning', () => {
  it('[JOB-046] deletes events older than 2 x the longest window and expired leases only', async () => {
    const key = newKey();
    await quota.acquire([spec(key, 100, 3600)], 'interactive');
    const old = new Date(clock.getTime() - 3 * 3600 * 1000);
    await testDb.db.pool.query(
      "INSERT INTO app.quota_event (bucket_key, pool, at) VALUES ($1, 'background', $2)",
      [key, old],
    );
    await leases.acquire(key, 'pod', 5);
    advance(3601);
    const first = await quota.prune();
    expect(first.events).toBeGreaterThanOrEqual(1);
    expect(first.leases).toBeGreaterThanOrEqual(1);
    // The 1-hour-old event survives (< 2 x the longest window of 3600 s).
    expect(await countEvents(key)).toBe(1);
    advance(2 * 3600);
    await quota.prune();
    expect(await countEvents(key)).toBe(0);
  });

  it('[JOB-046] keeps unexpired leases', async () => {
    const key = newKey('concurrent');
    await leases.acquire(key, 'pod', 5);
    await quota.prune();
    const left = await testDb.db.pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM app.quota_lease WHERE bucket_key = $1',
      [key],
    );
    expect(Number(left.rows[0]?.n)).toBe(1);
  });
});

describe('visibility and metrics', () => {
  it('[JOB-047] the snapshot reports limit, used, pool split and background rate per bucket', async () => {
    const key = newKey('vis');
    for (let i = 0; i < 3; i++) await quota.acquire([spec(key, 100, 100)], 'background');
    await quota.acquire([spec(key, 100, 100)], 'interactive');
    const bucket = (await quota.snapshot()).find((b) => b.bucketKey === key);
    expect(bucket).toMatchObject({
      limit: 100,
      effectiveLimit: 95,
      backgroundLimit: 85,
      windowSeconds: 100,
      used: 4,
      usedBackground: 3,
      usedInteractive: 1,
      remaining: null,
      blockedUntil: null,
      backgroundRatePerSecond: 0.85,
    });
  });

  it('[JOB-047] snapshots omit internal bookkeeping rows', async () => {
    const key = newKey('vis');
    await quota.recordSecondaryLimit({ bucketKey: key, limit: 100, windowSeconds: 60 });
    const keys = (await quota.snapshot()).map((b) => b.bucketKey);
    expect(keys).toContain(key);
    expect(keys.some((k) => k.includes('#'))).toBe(false);
  });

  it('[JOB-047] gauges are updated on acquire and exported from the snapshot', async () => {
    const key = newKey('gauge');
    await quota.acquire([spec(key, 100)], 'background');
    await quota.acquire([spec(key, 100)], 'interactive');
    expect(gauges.limit.get(key)).toBe(100);
    expect(gauges.used.get(`${key}|background`)).toBe(1);
    expect(gauges.used.get(`${key}|interactive`)).toBe(1);
    gauges.used.clear();
    await quota.exportMetrics();
    expect(gauges.used.get(`${key}|background`)).toBe(1);
    expect(gauges.used.get(`${key}|interactive`)).toBe(1);
  });

  it('[JOB-047] a denied acquire does not inflate the used gauge', async () => {
    const key = newKey('gauge');
    for (let i = 0; i < 9; i++) await quota.acquire([spec(key, 10)], 'interactive');
    await quota.acquire([spec(key, 10)], 'interactive');
    expect(gauges.used.get(`${key}|interactive`)).toBe(9);
  });
});
