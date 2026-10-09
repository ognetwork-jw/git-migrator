import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import { createLogger } from '@git-migrator/observability';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { reapRuns } from './reaper.ts';
import {
  claimRunLease,
  handOffRun,
  keepRunLease,
  parsePendingMarker,
  pendingMarker,
  RUN_LEASE_RENEW_MS,
  RUN_LEASE_TTL_SECONDS,
  type RunEnqueuerLike,
  releaseRunLease,
  renewRunLease,
  startQueuedRun,
} from './run-leases.ts';
import { type SeedRunFields, seedRun } from './world.fixture.ts';

const log = createLogger({ level: 'silent' });
let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase('gm_t028e_');
}, 120_000);
afterAll(async () => {
  await t?.drop();
}, 60_000);

const makeRun = (fields: SeedRunFields = {}) =>
  seedRun({ db: t.db.privileged, pool: t.db.pool }, fields);
const rowOf = async (id: string) =>
  (await t.db.pool.query('SELECT * FROM app.run WHERE id = $1', [id])).rows[0];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function recorder() {
  const calls: Array<{
    runId: string;
    routing: unknown;
    dedupeId: string | undefined;
    delayMs?: number | undefined;
  }> = [];
  const runs: RunEnqueuerLike & { isRunJobPending(dedupeId: string): Promise<boolean> } = {
    async enqueueRun(runId, routing, options) {
      calls.push({ runId, routing, dedupeId: options?.dedupeId, delayMs: options?.delayMs });
    },
    // Every enqueued job is still waiting.
    async isRunJobPending(dedupeId) {
      return calls.some((call) => call.dedupeId === dedupeId);
    },
  };
  return { calls, runs };
}

const routing = { kind: 'migrate', scope: 'repository', sizeClass: 'standard' } as const;

describe('Run leases', () => {
  it('[LIF-046] renews every 30 s and is valid for 2 minutes', () => {
    expect(RUN_LEASE_RENEW_MS).toBe(30_000);
    expect(RUN_LEASE_TTL_SECONDS).toBe(120);
  });

  it('[LIF-046] lets one token hold the lease until it is released, and never re-enters', async () => {
    const id = await makeRun();
    expect(await claimRunLease(t.db.pool, id, 'tok-a')).toBe(true);
    expect(await claimRunLease(t.db.pool, id, 'tok-b')).toBe(false);
    expect(await claimRunLease(t.db.pool, id, 'tok-a')).toBe(false); // not re-entrant
    const row = await rowOf(id);
    const seconds = (row.lease_expires_at.getTime() - Date.now()) / 1000;
    expect(seconds).toBeGreaterThan(100);
    expect(seconds).toBeLessThanOrEqual(120);
    expect(row.reaper_resumes).toBe(0); // the first claim is not a resumption

    expect(await renewRunLease(t.db.pool, id, 'tok-b')).toBe(false);
    expect(await renewRunLease(t.db.pool, id, 'tok-a')).toBe(true);
    expect(await releaseRunLease(t.db.pool, id, 'tok-b')).toBe(false);
    expect(await releaseRunLease(t.db.pool, id, 'tok-a')).toBe(true);
    expect((await rowOf(id)).lease_owner).toBeNull();
    expect(await claimRunLease(t.db.pool, id, 'tok-b')).toBe(true);
  }, 60_000);

  it('[LIF-046] counts a takeover of an expired lease as one resumption, for a running Run only', async () => {
    const expired = await makeRun({ leaseOwner: 'dead', leaseExpiresInSeconds: -5 });
    expect(await claimRunLease(t.db.pool, expired, 'tok-b')).toBe(true);
    expect((await rowOf(expired)).reaper_resumes).toBe(1);
    const queued = await makeRun({ status: 'queued' });
    expect(await claimRunLease(t.db.pool, queued, 'tok-b')).toBe(false);
  }, 60_000);

  it('[LIF-046] the same worker claiming after a reap cannot steal the lease from a live job', async () => {
    const id = await makeRun();
    const first = await keepRunLease({
      pool: t.db.pool,
      runId: id,
      workerId: 'pod-1',
      jobId: 'j1',
      log,
      renewMs: 50,
    });
    expect(first).toBeDefined();
    // J1 is cut off: its lease expires and the reaper marks the Run for a resume.
    await t.db.pool.query(
      "UPDATE app.run SET lease_owner = 'gone', lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
      [id],
    );
    const { runs } = recorder();
    await reapRuns({ pool: t.db.pool, runs, log });
    const second = await keepRunLease({
      pool: t.db.pool,
      runId: id,
      workerId: 'pod-1',
      jobId: 'j2',
      log,
      renewMs: 50,
    });
    expect(second).toBeDefined();
    expect(second?.token).not.toBe(first?.token);
    await sleep(300);
    expect(first?.lost.aborted).toBe(true);
    expect(second?.lost.aborted).toBe(false);
    expect((await rowOf(id)).lease_owner).toBe(second?.token);
    await second?.release();
  }, 60_000);

  it('[LIF-046] refuses a second job on the same worker while the first holds the lease', async () => {
    const id = await makeRun();
    const first = await keepRunLease({ pool: t.db.pool, runId: id, workerId: 'pod-1', jobId: 'a' });
    expect(first).toBeDefined();
    expect(
      await keepRunLease({ pool: t.db.pool, runId: id, workerId: 'pod-1', jobId: 'b' }),
    ).toBeUndefined();
    await first?.release();
  }, 60_000);

  it('[LIF-046] keeps renewing, reports a lost lease, and releases on request', async () => {
    const id = await makeRun();
    const handle = await keepRunLease({
      pool: t.db.pool,
      runId: id,
      workerId: 'w1',
      log,
      renewMs: 50,
    });
    expect(handle).toBeDefined();
    const before = (await rowOf(id)).lease_expires_at.getTime();
    await vi.waitFor(
      async () => {
        expect((await rowOf(id)).lease_expires_at.getTime()).toBeGreaterThan(before);
      },
      { timeout: 5_000, interval: 50 },
    );
    await t.db.pool.query("UPDATE app.run SET lease_owner = 'thief' WHERE id = $1", [id]);
    await sleep(200);
    expect(handle?.lost.aborted).toBe(true);
    await handle?.release();
    expect((await rowOf(id)).lease_owner).toBe('thief'); // not ours to release

    const other = await makeRun();
    const mine = await keepRunLease({ pool: t.db.pool, runId: other, workerId: 'w1', log });
    await mine?.release();
    expect((await rowOf(other)).lease_owner).toBeNull();
    expect(mine?.lost.aborted).toBe(false);
  }, 60_000);

  it('[LIF-046] aborts `lost` 90 s after the last renewal that succeeded was sent, at the production tick', async () => {
    const id = await makeRun();
    vi.useFakeTimers({
      toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'],
    });
    try {
      let failing = false;
      const flaky = {
        query: async (...args: unknown[]) => {
          if (String(args[0]).includes('SET lease_expires_at = clock_timestamp()')) {
            // The renewal statement: answered here so the fake clock alone drives the test.
            if (failing) throw new Error('connection lost');
            return { rowCount: 1 };
          }
          return (t.db.pool.query as (...a: unknown[]) => Promise<unknown>).apply(t.db.pool, args);
        },
      } as unknown as typeof t.db.pool;
      const started = Date.now();
      const handle = await keepRunLease({ pool: flaky, runId: id, workerId: 'w1', log });
      expect(handle).toBeDefined();
      // Ticks at 30 s and 60 s succeed; the last successful send is at 60 s.
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(1);
      failing = true;
      // Ticks at 90 s and 120 s fail. The limit is 90 s after the 60 s send, i.e. 150 s.
      await vi.advanceTimersByTimeAsync(89_000);
      expect(handle?.lost.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(handle?.lost.aborted).toBe(true);
      const abortedAt = Date.now() - started;
      expect(abortedAt).toBeLessThanOrEqual(60_001 + 90_000 + 2_000);
      handle?.stop();
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);

  it('[LIF-046] a slow renewal answering after a faster later one never moves the deadline earlier', async () => {
    const id = await makeRun();
    vi.useFakeTimers({
      toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'],
    });
    try {
      let renewals = 0;
      let answerSlow: (value: { rowCount: number }) => void = () => undefined;
      let failing = false;
      const pool = {
        query: async (...args: unknown[]) => {
          if (String(args[0]).includes('SET lease_expires_at = clock_timestamp()')) {
            renewals += 1;
            // The renewal sent at 30 s is slow; the one sent at 60 s answers at once.
            if (renewals === 1) return new Promise((resolve) => (answerSlow = resolve));
            if (failing) throw new Error('connection lost');
            return { rowCount: 1 };
          }
          return (t.db.pool.query as (...a: unknown[]) => Promise<unknown>).apply(t.db.pool, args);
        },
      } as unknown as typeof t.db.pool;
      const handle = await keepRunLease({ pool, runId: id, workerId: 'w1', log });
      await vi.advanceTimersByTimeAsync(60_001); // 30 s send hangs, 60 s send succeeds
      failing = true;
      await vi.advanceTimersByTimeAsync(10_000);
      answerSlow({ rowCount: 1 }); // the 30 s send succeeds late, at 70 s
      // Deadline stays 60 s + 90 s = 150 s; re-arming from the 30 s send would abort at 120 s.
      await vi.advanceTimersByTimeAsync(78_000); // 148 s
      expect(handle?.lost.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(3_000); // 151 s
      expect(handle?.lost.aborted).toBe(true);
      handle?.stop();
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);

  it('[LIF-046] aborts `lost` at 90 s when renewals hang and never answer', async () => {
    const id = await makeRun();
    vi.useFakeTimers({
      toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'],
    });
    try {
      let hang = false;
      const stuck = {
        query: async (...args: unknown[]) => {
          if (String(args[0]).includes('SET lease_expires_at = clock_timestamp()')) {
            return hang ? new Promise(() => undefined) : { rowCount: 1 };
          }
          return (t.db.pool.query as (...a: unknown[]) => Promise<unknown>).apply(t.db.pool, args);
        },
      } as unknown as typeof t.db.pool;
      const handle = await keepRunLease({ pool: stuck, runId: id, workerId: 'w1', log });
      hang = true;
      await vi.advanceTimersByTimeAsync(89_000);
      expect(handle?.lost.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(handle?.lost.aborted).toBe(true);
      handle?.stop();
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);
});

describe('pending markers', () => {
  it('[LIF-046] carry the deduplication id of the awaited job and tell resume from hand-off', () => {
    expect(pendingMarker('resume', 'run-1:resume-2')).toBe('reaper:resume-pending:run-1:resume-2');
    expect(parsePendingMarker(pendingMarker('handoff', 'run-1:handoff-a:b'))).toEqual({
      kind: 'handoff',
      dedupeId: 'run-1:handoff-a:b',
    });
    expect(parsePendingMarker('handoff-pending')).toEqual({ kind: 'handoff', dedupeId: undefined });
    expect(parsePendingMarker('pod-1:job-1:abc')).toBeUndefined();
    expect(parsePendingMarker(null)).toBeUndefined();
  });
});

describe('SIGTERM hand-off', () => {
  it('[LIF-046] releases with a grace period, enqueues a distinct id and counts no resumption', async () => {
    const id = await makeRun();
    const handle = await keepRunLease({ pool: t.db.pool, runId: id, workerId: 'w1', log });
    const { calls, runs } = recorder();
    const done = await handOffRun({
      pool: t.db.pool,
      runs,
      runId: id,
      token: handle?.token as string,
      routing,
    });
    handle?.stop();
    expect(done).toBe(true);
    expect(calls).toEqual([{ runId: id, routing, dedupeId: `run-${id}:handoff-${handle?.token}` }]);
    const row = await rowOf(id);
    expect(row.lease_owner).toBe(pendingMarker('handoff', `run-${id}:handoff-${handle?.token}`));
    expect(row.reaper_resumes).toBe(0);
    expect(row.lease_expires_at.getTime()).toBeGreaterThan(Date.now() + 100_000);
    // The reaper leaves the Run alone during the grace period.
    expect((await reapRuns({ pool: t.db.pool, runs, log })).resumed).not.toContain(id);
    // The handed-off job claims it without counting a resumption.
    expect(await claimRunLease(t.db.pool, id, 'next')).toBe(true);
    expect((await rowOf(id)).reaper_resumes).toBe(0);
  }, 60_000);

  it('[LIF-046] three rolling deploys do not abandon a long Run', async () => {
    const id = await makeRun();
    const { runs } = recorder();
    for (let deploy = 0; deploy < 4; deploy += 1) {
      const handle = await keepRunLease({ pool: t.db.pool, runId: id, workerId: 'w', log });
      expect(handle).toBeDefined();
      await handOffRun({
        pool: t.db.pool,
        runs,
        runId: id,
        token: handle?.token as string,
        routing,
      });
      handle?.stop();
    }
    const row = await rowOf(id);
    expect(row.status).toBe('running');
    expect(row.reaper_resumes).toBe(0);
  }, 60_000);

  it('[LIF-046] does nothing when the lease is no longer ours', async () => {
    const id = await makeRun({ leaseOwner: 'someone-else', leaseExpiresInSeconds: 90 });
    const { calls, runs } = recorder();
    expect(await handOffRun({ pool: t.db.pool, runs, runId: id, token: 'stale', routing })).toBe(
      false,
    );
    expect(calls).toEqual([]);
  }, 60_000);
});

describe('Run leases of the executor (LIF-040, LIF-046)', () => {
  it('[LIF-040] starts a queued Run and takes its lease in one statement, for one job only', async () => {
    const id = await makeRun({ status: 'queued' });
    const [a, b] = await Promise.all([
      startQueuedRun(t.db.pool, id, 'tok-a'),
      startQueuedRun(t.db.pool, id, 'tok-b'),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const row = await rowOf(id);
    expect(row.status).toBe('running');
    expect(row.started_at).not.toBeNull();
    expect(row.reaper_resumes).toBe(0);
    expect(await startQueuedRun(t.db.pool, id, 'tok-c')).toBe(false);
  }, 60_000);

  it('[LIF-040] never starts a queued Run whose cancel was requested', async () => {
    const id = await makeRun({ status: 'queued' });
    await t.db.pool.query('UPDATE app.run SET cancel_requested_at = now() WHERE id = $1', [id]);
    expect(await startQueuedRun(t.db.pool, id, 'tok-a')).toBe(false);
    expect((await rowOf(id)).status).toBe('queued');
  });

  it('[LIF-046] keepRunLease starts a queued Run only when asked to', async () => {
    const id = await makeRun({ status: 'queued' });
    expect(await keepRunLease({ pool: t.db.pool, runId: id, workerId: 'w' })).toBeUndefined();
    const lease = await keepRunLease({
      pool: t.db.pool,
      runId: id,
      workerId: 'w',
      startQueued: true,
    });
    expect(lease).toBeDefined();
    await lease?.release();
  });

  it('[LIF-046] a hand-off can delay the next job, and the marker still waits for it', async () => {
    const id = await makeRun({ leaseOwner: 'tok-a', leaseExpiresInSeconds: 60 });
    const { calls, runs } = recorder();
    expect(
      await handOffRun({
        pool: t.db.pool,
        runs,
        runId: id,
        token: 'tok-a',
        routing,
        delayMs: 90_000,
      }),
    ).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ runId: id });
    expect((calls[0] as unknown as { delayMs?: number }).delayMs).toBe(90_000);
  });
});
