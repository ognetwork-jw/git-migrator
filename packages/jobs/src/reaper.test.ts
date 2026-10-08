import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import { createLogger } from '@git-migrator/observability';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_REAPER_RESUMES, RUN_ABANDONED, type RunEnqueuer, reapRuns } from './reaper.ts';
import { claimRunLease, pendingMarker } from './run-leases.ts';
import { type SeedRunFields, seedRun } from './world.fixture.ts';

const log = createLogger({ level: 'silent' });
let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase('gm_t028r_');
}, 120_000);
afterAll(async () => {
  await t?.drop();
}, 60_000);

const makeRun = (fields: SeedRunFields = {}) =>
  seedRun({ db: t.db.privileged, pool: t.db.pool }, fields);
const rowOf = async (id: string) =>
  (await t.db.pool.query('SELECT * FROM app.run WHERE id = $1', [id])).rows[0];
const expire = (id: string) =>
  t.db.pool.query(
    "UPDATE app.run SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
    [id],
  );

/** A fake queue: enqueued jobs wait until the test marks them dead (failed or removed). */
function recorder(alreadyPending: readonly string[] = []) {
  const calls: Array<{ runId: string; routing: unknown; dedupeId: string | undefined }> = [];
  const pending = new Set(alreadyPending);
  const runs: RunEnqueuer = {
    async enqueueRun(runId, routing, options) {
      calls.push({ runId, routing, dedupeId: options?.dedupeId });
      if (options?.dedupeId) pending.add(options.dedupeId);
    },
    async isRunJobPending(dedupeId) {
      return pending.has(dedupeId);
    },
  };
  const die = (dedupeId: string) => pending.delete(dedupeId);
  return { calls, runs, die };
}

describe('run reaper', () => {
  it('[LIF-046] marks expired Runs for a resume, enqueues once and leaves live ones alone', async () => {
    const expired = await makeRun({ leaseOwner: 'dead', leaseExpiresInSeconds: -30 });
    const live = await makeRun({ leaseOwner: 'alive', leaseExpiresInSeconds: 90 });
    const queued = await makeRun({ status: 'queued' });
    const { calls, runs } = recorder();
    const result = await reapRuns({ pool: t.db.pool, runs, log });
    expect(result.resumed).toContain(expired);
    expect(result.resumed).not.toContain(live);
    expect(result.resumed).not.toContain(queued);
    const call = calls.find((c) => c.runId === expired);
    expect(call?.routing).toEqual({ kind: 'migrate', scope: 'repository', sizeClass: 'standard' });
    expect(call?.dedupeId).toBe(`run-${expired}:resume-1`);

    const row = await rowOf(expired);
    expect(row.reaper_resumes).toBe(0); // counted when the resumed job claims, not now
    expect(row.status).toBe('running');
    expect(row.lease_owner).toBe(pendingMarker('resume', `run-${expired}:resume-1`));
    // A fresh lease period: a second pass right away does nothing.
    const again = await reapRuns({ pool: t.db.pool, runs, log });
    expect(again.resumed).not.toContain(expired);
  }, 60_000);

  it('[LIF-046] passes with no claim neither abandon the Run nor add jobs', async () => {
    const id = await makeRun({ leaseOwner: 'dead', leaseExpiresInSeconds: -30 });
    const { calls, runs } = recorder();
    for (let pass = 0; pass < 5; pass += 1) {
      const result = await reapRuns({ pool: t.db.pool, runs, log });
      expect(result.abandoned).not.toContain(id);
      // The resume job still waits: the marker expires again, as in a backlogged queue.
      await expire(id);
    }
    const ids = new Set(calls.filter((c) => c.runId === id).map((c) => c.dedupeId));
    expect([...ids]).toEqual([`run-${id}:resume-1`]); // one stable id: BullMQ keeps one job
    const row = await rowOf(id);
    expect(row.reaper_resumes).toBe(0);
    expect(row.status).toBe('running');
    // The job finally claims: now it counts.
    expect(await claimRunLease(t.db.pool, id, 'tok')).toBe(true);
    expect((await rowOf(id)).reaper_resumes).toBe(1);
  }, 60_000);

  it('[LIF-046] routes a large repository Run to the large queue', async () => {
    const id = await makeRun({ sizeClass: 'large', leaseOwner: 'dead', leaseExpiresInSeconds: -1 });
    const { calls, runs } = recorder();
    await reapRuns({ pool: t.db.pool, runs, log });
    expect(calls.find((c) => c.runId === id)?.routing).toEqual({
      kind: 'migrate',
      scope: 'repository',
      sizeClass: 'large',
    });
  }, 60_000);

  it('[LIF-046] marks a Run failed with run.abandoned after 3 claimed resumptions', async () => {
    expect(MAX_REAPER_RESUMES).toBe(3);
    const id = await makeRun({ reaperResumes: 3, leaseOwner: 'dead', leaseExpiresInSeconds: -1 });
    const recorded: unknown[] = [];
    const { calls, runs } = recorder();
    const result = await reapRuns({
      pool: t.db.pool,
      runs,
      log,
      metrics: { recordRun: (...args) => void recorded.push(args) },
    });
    expect(result.abandoned).toEqual([id]);
    expect(calls.find((c) => c.runId === id)).toBeUndefined();
    const row = await rowOf(id);
    expect(row.status).toBe('failed');
    expect(row.error).toMatchObject({ code: RUN_ABANDONED });
    expect(row.finished_at).not.toBeNull();
    expect(row.lease_owner).toBeNull();
    expect(recorded).toHaveLength(1);
    expect((recorded[0] as unknown[]).slice(0, 2)).toEqual(['migrate', 'failed']);
    expect((await reapRuns({ pool: t.db.pool, runs, log })).abandoned).not.toContain(id);
  }, 60_000);

  it('[LIF-046] keeps waiting for a live pending resume, even past 3 resumptions', async () => {
    const dedupeId = 'resume-live-4';
    const id = await makeRun({
      reaperResumes: 3,
      leaseOwner: pendingMarker('resume', dedupeId),
      leaseExpiresInSeconds: -1,
    });
    const { calls, runs } = recorder([dedupeId]);
    const result = await reapRuns({ pool: t.db.pool, runs, log });
    expect(result.abandoned).toEqual([]);
    expect(calls.find((c) => c.runId === id)).toBeUndefined();
    const row = await rowOf(id);
    expect(row.status).toBe('running');
    expect(row.lease_expires_at.getTime()).toBeGreaterThan(Date.now());
  }, 60_000);

  it('[LIF-046] counts a pending resume whose job died, and abandons the Run after 4 passes', async () => {
    const id = await makeRun({
      leaseOwner: pendingMarker('resume', 'failed-resume-1'),
      leaseExpiresInSeconds: -1,
    });
    // The resume job failed (run.execute has no handler until T-070), and so does every later one.
    const { calls, runs, die } = recorder();
    const outcomes: string[] = [];
    for (let pass = 0; pass < 4; pass += 1) {
      const result = await reapRuns({ pool: t.db.pool, runs, log });
      outcomes.push(result.abandoned.includes(id) ? 'abandoned' : 'resumed');
      for (const call of calls) if (call.dedupeId) die(call.dedupeId);
      await expire(id);
    }
    expect(outcomes).toEqual(['resumed', 'resumed', 'resumed', 'abandoned']);
    expect(calls.filter((c) => c.runId === id).map((c) => c.dedupeId)).toEqual([
      `run-${id}:resume-2`,
      `run-${id}:resume-3`,
      `run-${id}:resume-4`,
    ]);
    const row = await rowOf(id);
    expect(row.status).toBe('failed');
    expect(row.error).toMatchObject({ code: RUN_ABANDONED, resumes: 3 });
    expect(row.reaper_resumes).toBe(3);
  }, 60_000);

  it('[LIF-046] turns a dead hand-off or first job into a counted resume, and abandons it at the bound', async () => {
    const handoff = await makeRun({
      leaseOwner: pendingMarker('handoff', 'gone-handoff'),
      leaseExpiresInSeconds: -1,
    });
    const first = await makeRun({ reaperResumes: 1 });
    await t.db.pool.query(
      "UPDATE app.run SET updated_at = clock_timestamp() - interval '10 minutes' WHERE id = $1",
      [first],
    );
    const atBound = await makeRun({
      reaperResumes: 3,
      leaseOwner: pendingMarker('handoff', 'gone-too'),
      leaseExpiresInSeconds: -1,
    });
    const { calls, runs } = recorder();
    const result = await reapRuns({ pool: t.db.pool, runs, log });
    expect(result.resumed).toEqual(expect.arrayContaining([handoff, first]));
    expect(result.abandoned).toContain(atBound);
    expect(result.abandoned).not.toContain(handoff);
    expect(calls.find((c) => c.runId === handoff)?.dedupeId).toBe(`run-${handoff}:resume-1`);
    expect(calls.find((c) => c.runId === first)?.dedupeId).toBe(`run-${first}:resume-2`);
    expect((await rowOf(handoff)).reaper_resumes).toBe(0); // counted when claimed
    expect(await claimRunLease(t.db.pool, handoff, 'tok')).toBe(true);
    expect((await rowOf(handoff)).reaper_resumes).toBe(1);
  }, 60_000);

  it('[LIF-046] waits for the next pass when the job lookup fails', async () => {
    const marker = pendingMarker('resume', 'lookup-fails');
    const id = await makeRun({ leaseOwner: marker, leaseExpiresInSeconds: -1 });
    const runs: RunEnqueuer = {
      enqueueRun: async () => undefined,
      isRunJobPending: async () => {
        throw new Error('queue down');
      },
    };
    const result = await reapRuns({ pool: t.db.pool, runs, log });
    expect(result.resumed).not.toContain(id);
    expect(result.abandoned).not.toContain(id);
    const row = await rowOf(id);
    expect(row.reaper_resumes).toBe(0);
    expect(row.lease_owner).toBe(marker);
  }, 60_000);

  it('[LIF-046] reaps a running Run that never got a lease once its last update is old', async () => {
    const id = await makeRun();
    const { runs } = recorder();
    expect((await reapRuns({ pool: t.db.pool, runs, log })).resumed).not.toContain(id);
    await t.db.pool.query(
      "UPDATE app.run SET updated_at = clock_timestamp() - interval '5 minutes' WHERE id = $1",
      [id],
    );
    expect((await reapRuns({ pool: t.db.pool, runs, log })).resumed).toContain(id);
  }, 60_000);

  it('[LIF-046] survives an enqueue failure and retries after the lease period', async () => {
    const id = await makeRun({ leaseOwner: 'dead', leaseExpiresInSeconds: -1 });
    const failing: RunEnqueuer = {
      enqueueRun: async () => {
        throw new Error('queue down');
      },
      isRunJobPending: async () => false,
    };
    const result = await reapRuns({ pool: t.db.pool, runs: failing, log });
    expect(result.resumed).toContain(id);
    expect((await rowOf(id)).lease_expires_at.getTime()).toBeGreaterThan(Date.now());
  }, 60_000);

  it('[LIF-046] a hand-off left unclaimed through 4 passes at 3 resumptions stays running and counts 0', async () => {
    const dedupeId = 'handoff-backlogged';
    const marker = pendingMarker('handoff', dedupeId);
    const id = await makeRun({ reaperResumes: 3, leaseOwner: marker, leaseExpiresInSeconds: -1 });
    const { calls, runs } = recorder([dedupeId]);
    for (let pass = 0; pass < 4; pass += 1) {
      const result = await reapRuns({ pool: t.db.pool, runs, log });
      expect(result.abandoned).not.toContain(id);
      expect((await rowOf(id)).lease_owner).toBe(marker);
      await expire(id);
    }
    expect(calls.filter((c) => c.runId === id)).toEqual([]); // the waiting job is enough
    const row = await rowOf(id);
    expect(row.status).toBe('running');
    expect(row.reaper_resumes).toBe(3);
    // The eventual claim is not a resumption.
    expect(await claimRunLease(t.db.pool, id, 'tok')).toBe(true);
    expect((await rowOf(id)).reaper_resumes).toBe(3);
  }, 60_000);

  it('[LIF-046] a running Run whose first job is still queued is never abandoned or counted', async () => {
    const id = await makeRun({ reaperResumes: 3 });
    await t.db.pool.query(
      "UPDATE app.run SET updated_at = clock_timestamp() - interval '10 minutes' WHERE id = $1",
      [id],
    );
    const { calls, runs } = recorder([`run-${id}`]);
    const result = await reapRuns({ pool: t.db.pool, runs, log });
    expect(result.abandoned).toEqual([]);
    expect(calls.find((c) => c.runId === id)).toBeUndefined();
    expect((await rowOf(id)).lease_owner).toBeNull();
    expect(await claimRunLease(t.db.pool, id, 'tok')).toBe(true);
    expect((await rowOf(id)).reaper_resumes).toBe(3);
  }, 60_000);
});
