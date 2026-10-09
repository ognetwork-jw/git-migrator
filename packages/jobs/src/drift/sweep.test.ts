import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import { createLogger } from '@git-migrator/observability';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { seedParityWorld } from '../parity/parity.fixture.ts';
import { JOB_PAYLOADS, parsePayload } from '../payloads.ts';
import { runDriftSweep, scheduleIntervalMs } from './sweep.ts';

vi.setConfig({ testTimeout: 30_000 });

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase('gm_t089b_');
}, 120_000);
afterAll(async () => {
  await t?.drop();
}, 60_000);

const db = () => t.db.privileged;
const log = createLogger({ level: 'silent' });

interface Call {
  migrationId: string;
  drift?: boolean | undefined;
  delayMs?: number | undefined;
}

function sweepWith(
  schedule: string,
  fail: (id: string) => boolean = () => false,
): { calls: Call[]; run: () => ReturnType<typeof runDriftSweep> } {
  const calls: Call[] = [];
  return {
    calls,
    run: () =>
      runDriftSweep({
        db: db(),
        runtime: {
          enqueueParity: async (migrationId, options) => {
            if (fail(migrationId)) throw new Error('queue down');
            calls.push({ migrationId, drift: options?.drift, delayMs: options?.delayMs });
            return {} as never;
          },
        },
        schedule,
        log,
      }),
  };
}

describe('[JOB-050] the drift schedule', () => {
  it('[JOB-050] spreads over the interval between two firings of the schedule, within a minute and a day', () => {
    const at = new Date('2026-10-09T12:00:00Z');
    expect(scheduleIntervalMs('17 3 * * *', at)).toBe(24 * 3_600_000);
    expect(scheduleIntervalMs('0 */6 * * *', at)).toBe(6 * 3_600_000);
    expect(scheduleIntervalMs('* * * * *', at)).toBe(60_000);
    // Less often than daily is still spread over a day; a schedule it cannot read gives a day.
    expect(scheduleIntervalMs('0 0 1 * *', at)).toBe(24 * 3_600_000);
    expect(scheduleIntervalMs('not a cron', at)).toBe(24 * 3_600_000);
  });

  it('[JOB-011] a drift check has its own payload: IDs only, drift literally true', () => {
    expect(parsePayload('parity.migration', { migrationId: 'm1' })).toEqual({ migrationId: 'm1' });
    expect(parsePayload('parity.migration', { migrationId: 'm1', drift: true })).toEqual({
      migrationId: 'm1',
      drift: true,
    });
    expect(() => parsePayload('parity.migration', { migrationId: 'm1', drift: false })).toThrow();
    expect(() => parsePayload('parity.migration', { migrationId: 'm1', token: 'x' })).toThrow();
    expect(JOB_PAYLOADS['drift.sweep'].safeParse({}).success).toBe(true);
  });
});

describe('[LIF-065] the drift sweep', () => {
  it('[LIF-065] enqueues a drift check for each verified or manually completed repository Migration, and for no other', async () => {
    const wanted = [
      await seedParityWorld(db(), 'verified'),
      await seedParityWorld(db(), 'manually_completed'),
      await seedParityWorld(db(), 'verified'),
    ];
    // Not eligible: another status, an endpoint Migration, a retired Route, a missing source.
    await seedParityWorld(db(), 'migrated');
    await seedParityWorld(db(), 'partial');
    await seedParityWorld(db(), 'drifted');
    await seedParityWorld(db(), 'analyzed');
    await seedParityWorld(db(), 'verified', { scope: 'endpoint' });
    const retired = await seedParityWorld(db(), 'verified');
    await db().route.update({ where: { id: retired.routeId }, data: { retiredAt: new Date() } });
    const gone = await seedParityWorld(db(), 'verified');
    await db().repository.update({
      where: { id: gone.sourceRepositoryId },
      data: { presence: 'missing' },
    });
    const noTarget = await seedParityWorld(db(), 'verified');
    await db()
      .$executeRaw`UPDATE app.migration SET target_repository_id = NULL WHERE id = ${noTarget.migrationId}`;

    const sweep = sweepWith('17 3 * * *');
    const out = await sweep.run();
    expect(out).toMatchObject({ eligible: 3, enqueued: 3, failed: 0 });
    expect(sweep.calls.map((c) => c.migrationId).sort()).toEqual(
      wanted.map((w) => w.migrationId).sort(),
    );
    expect(sweep.calls.every((c) => c.drift === true)).toBe(true);
  });

  it('[LIF-065] gives every Migration its own slot across the interval, so thousands do not reach the providers at once', async () => {
    const sweep = sweepWith('17 3 * * *');
    const out = await sweep.run();
    const delays = sweep.calls.map((c) => c.delayMs ?? -1);
    expect(delays[0]).toBe(0);
    expect(delays).toEqual([...delays].sort((a, b) => a - b));
    expect(new Set(delays).size).toBe(delays.length);
    expect(Math.max(...delays)).toBeLessThan(out.intervalMs);
    // A faster schedule compresses the spread into its own interval.
    const fast = sweepWith('0 */6 * * *');
    const quick = await fast.run();
    expect(quick.intervalMs).toBe(6 * 3_600_000);
    expect(Math.max(...fast.calls.map((c) => c.delayMs ?? 0))).toBeLessThan(6 * 3_600_000);
  });

  it('[LIF-065] a failed enqueue costs only that Migration its check until the next sweep', async () => {
    const first = sweepWith('17 3 * * *');
    await first.run();
    const bad = first.calls[0]?.migrationId as string;
    const sweep = sweepWith('17 3 * * *', (id) => id === bad);
    const out = await sweep.run();
    expect(out.failed).toBe(1);
    expect(out.enqueued).toBe(first.calls.length - 1);
    expect(sweep.calls.map((c) => c.migrationId)).not.toContain(bad);
  });

  it('[LIF-065] pages through the Migrations: a small page still visits each one once, in order', async () => {
    const whole = sweepWith('17 3 * * *');
    await whole.run();
    const calls: Call[] = [];
    const out = await runDriftSweep({
      db: db(),
      runtime: {
        enqueueParity: async (migrationId, options) => {
          calls.push({ migrationId, drift: options?.drift, delayMs: options?.delayMs });
          return {} as never;
        },
      },
      schedule: '17 3 * * *',
      log,
      pageSize: 2,
    });
    expect(out.enqueued).toBe(whole.calls.length);
    expect(calls.map((c) => c.migrationId)).toEqual(whole.calls.map((c) => c.migrationId));
    expect(calls.map((c) => c.delayMs)).toEqual(whole.calls.map((c) => c.delayMs));
  });

  it('[LIF-065] the sweep itself calls no provider and runs no check', async () => {
    // It has no connector and no parity dependency at all: only the database and the queue.
    const sweep = sweepWith('17 3 * * *');
    await expect(sweep.run()).resolves.toBeDefined();
  });
});
