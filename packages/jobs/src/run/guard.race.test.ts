import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startQueuedRun } from '../run-leases.ts';
import { createRun, requestRunCancel } from './guard.ts';
import { Harness, silentLog, step } from './harness.fixture.ts';
import { requeueOrphanedQueuedRuns } from './orphans.ts';

// These tests wait on a real database; a loaded CI box needs more than the 5 s default.
vi.setConfig({ testTimeout: 30_000 });

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase('gm_t070e_');
}, 120_000);
afterAll(async () => {
  await t?.drop();
}, 60_000);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The invariant: a Migration is `running` exactly while one of its Runs is queued or running. */
async function expectConsistent(h: Harness, migrationId: string): Promise<void> {
  const runs = await h.db.run.findMany({ where: { migrationId } });
  const active = runs.filter((r) => r.status === 'queued' || r.status === 'running');
  const migration = await h.migration(migrationId);
  expect(active.length).toBeLessThanOrEqual(1);
  expect(migration.status === 'running').toBe(active.length === 1);
}

describe('[LIF-040] cancelling a queued Run while it starts', () => {
  it('[LIF-040] a cancel that waits behind the start of the Run sees it running and requests the cancel instead of finishing it', async () => {
    const h = new Harness(t);
    const { world, runId } = await h.queuedRun();
    // A worker has started the Run but not committed yet.
    const client = await t.db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "UPDATE app.run SET status = 'running', started_at = now(), lease_owner = 'w1' WHERE id = $1",
        [runId],
      );
      const cancel = requestRunCancel(h.db, runId);
      await sleep(150); // the cancel is now waiting for the Run row
      await client.query('COMMIT');
      expect(await cancel).toBe('requested');
    } finally {
      client.release();
    }
    const run = await h.run(runId);
    expect(run.status).toBe('running');
    expect(run.cancelRequestedAt).not.toBeNull();
    expect((await h.migration(world.migrationId)).status).toBe('running');
    await expectConsistent(h, world.migrationId);
  });

  it('[LIF-040] a worker that starts after the cancel finds a finished Run and does not start it', async () => {
    const h = new Harness(t);
    const { world, runId } = await h.queuedRun();
    expect(await requestRunCancel(h.db, runId)).toBe('cancelled');
    expect(await startQueuedRun(t.db.pool, runId, 'late-worker')).toBe(false);
    expect((await h.run(runId)).status).toBe('cancelled');
    await expectConsistent(h, world.migrationId);
  });

  it('[LIF-040] whichever of start and cancel wins, the Migration and the Run agree', async () => {
    const h = new Harness(t);
    h.registry.register('migrate', { steps: () => [step('preflight')] });
    for (let round = 0; round < 12; round++) {
      const { world, runId } = await h.queuedRun();
      const outcomes = await Promise.allSettled([
        h.execute(runId, { jobId: `r${round}` }),
        requestRunCancel(h.db, runId),
        requestRunCancel(h.db, runId),
      ]);
      for (const outcome of outcomes) expect(outcome.status).toBe('fulfilled');
      await expectConsistent(h, world.migrationId);
      const run = await h.run(runId);
      expect(['succeeded', 'cancelled']).toContain(run.status);
    }
  }, 120_000);

  it('[DOM-010] create, execute and cancel racing on one Migration keep the Migration and its Runs consistent', async () => {
    const h = new Harness(t);
    h.registry.register('migrate', { steps: () => [step('preflight')] });
    for (let round = 0; round < 6; round++) {
      const { world, runId } = await h.queuedRun();
      await Promise.allSettled([
        h.execute(runId),
        requestRunCancel(h.db, runId),
        createRun(h.db, {
          migrationId: world.migrationId,
          kind: 'verify',
          triggeredById: world.actorId,
        }),
        createRun(h.db, {
          migrationId: world.migrationId,
          kind: 'migrate',
          triggeredById: world.actorId,
        }),
      ]);
      await expectConsistent(h, world.migrationId);
    }
  }, 120_000);
});

describe('[DOM-010] requeueing queued Runs', () => {
  it('[DOM-010] does not enqueue a Run that was cancelled after the list was read', async () => {
    const h = new Harness(t);
    const first = await h.queuedRun();
    const second = await h.queuedRun();
    await t.db.pool.query(
      "UPDATE app.run SET created_at = now() - interval '1 hour' WHERE id = ANY($1)",
      [[first.runId, second.runId]],
    );
    await t.db.pool.query(
      "UPDATE app.run SET created_at = now() - interval '2 hours' WHERE id = $1",
      [first.runId],
    );
    const enqueued: string[] = [];
    let cancelled = false;
    const runs = {
      async isRunJobPending() {
        // While the first Run is being looked at, the second one is cancelled.
        if (!cancelled) {
          cancelled = true;
          await requestRunCancel(h.db, second.runId);
        }
        return false;
      },
      async enqueueRun(runId: string) {
        enqueued.push(runId);
      },
    };
    await requeueOrphanedQueuedRuns(t.db.pool, runs, silentLog);
    expect(enqueued).toContain(first.runId);
    expect(enqueued).not.toContain(second.runId);
  });
});
