import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import { createLogger } from '@git-migrator/observability';
import { QuotaService } from '@git-migrator/quota';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPruner, maintenanceHandlers, RETENTION_INTERVAL_MS } from './maintenance.ts';
import type { JobRuntime } from './runtime.ts';
import { seedRun } from './world.fixture.ts';

const log = createLogger({ level: 'silent' });
let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase('gm_t028m_');
}, 120_000);
afterAll(async () => {
  await t?.drop();
}, 60_000);

const deps = (extra: Partial<Parameters<typeof createPruner>[0]> = {}) => ({
  appPool: t.db.pool,
  quota: { prune: async () => ({ events: 0, leases: 0 }) },
  runtime: {} as JobRuntime,
  log,
  scratchRoot: '/nonexistent-scratch',
  ...extra,
});

describe('maintenance.prune', () => {
  it('[JOB-046] prunes the quota ledger through QuotaService.prune() and expired leases', async () => {
    const quota = new QuotaService({ pool: t.db.pool });
    await t.db.pool.query(
      `INSERT INTO app.quota_event (bucket_key, pool, at)
       VALUES ('e:a:g', 'background', clock_timestamp() - interval '10 hours'),
              ('e:a:g', 'background', clock_timestamp())`,
    );
    await t.db.pool.query(
      `INSERT INTO app.quota_lease (bucket_key, holder, expires_at, updated_at)
       VALUES ('e:a:g', 'h', clock_timestamp() - interval '1 minute', now())`,
    );
    const prune = createPruner(deps({ quota }));
    const result = await prune();
    expect(result.events).toBe(1);
    expect(result.leases).toBe(1);
    const left = await t.db.pool.query('SELECT count(*)::int AS n FROM app.quota_event');
    expect(left.rows[0].n).toBe(1);
    expect(result.retention).toBeDefined();
  }, 60_000);

  it('[JOB-046] runs the retention pass once per hour', async () => {
    let clock = 1_000_000;
    let quotaCalls = 0;
    const prune = createPruner(
      deps({
        quota: {
          prune: async () => {
            quotaCalls += 1;
            return { events: 0, leases: 0 };
          },
        },
        now: () => clock,
      }),
    );
    expect((await prune()).retention).toBeDefined();
    clock += 10 * 60_000;
    expect((await prune()).retention).toBeUndefined();
    clock += 49 * 60_000;
    expect((await prune()).retention).toBeUndefined();
    clock += 60_000;
    expect(RETENTION_INTERVAL_MS).toBe(3_600_000);
    expect((await prune()).retention).toBeDefined();
    expect(quotaCalls).toBe(4);
  }, 60_000);
});

describe('maintenance handlers', () => {
  it('[JOB-050] registers the maintenance jobs and completes unfinished scheduled jobs as skipped', async () => {
    const handlers = maintenanceHandlers(deps());
    for (const name of [
      'maintenance.prune',
      'maintenance.scratch-cleanup',
      'maintenance.run-reaper',
      'drift.sweep',
    ] as const) {
      expect(handlers[name]).toBeTypeOf('function');
    }
    // User-triggered jobs stay unregistered, so they fail visibly until their task lands.
    expect(handlers['run.execute']).toBeUndefined();
    expect(handlers['analysis.migration']).toBeUndefined();
    // The feeder has its own processor now (T-061); the others still complete as skipped.
    expect(handlers['analysis.feeder']).toBeUndefined();
    // `parity.migration` has its own processor now (T-072, parityHandlers).
    expect(handlers['parity.migration']).toBeUndefined();
    const sweep = handlers['drift.sweep'] as unknown as () => Promise<unknown>;
    expect(await sweep()).toEqual({ skipped: true });
  });

  it('[JOB-015] maintenance.scratch-cleanup removes scratch directories older than a day', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gm-maint-'));
    try {
      await mkdir(join(root, 'old'));
      const longAgo = new Date(Date.now() - 3 * 86_400_000);
      await utimes(join(root, 'old'), longAgo, longAgo);
      await mkdir(join(root, 'new'));
      const handlers = maintenanceHandlers(deps({ scratchRoot: root }));
      const handler = handlers['maintenance.scratch-cleanup'] as unknown as () => Promise<{
        removed: string[];
      }>;
      expect((await handler()).removed).toEqual(['old']);
      expect(existsSync(join(root, 'new'))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('[LIF-046] maintenance.run-reaper runs the reaper over the application pool', async () => {
    const handlers = maintenanceHandlers(deps());
    const handler = handlers['maintenance.run-reaper'] as unknown as () => Promise<{
      resumed: string[];
    }>;
    expect((await handler()).resumed).toEqual([]);
  }, 60_000);

  it('[LIF-046] maintenance.run-reaper also settles a Migration left running behind an abandoned Run and re-enqueues a lost queued Run', async () => {
    const abandoned = await seedRun(
      { db: t.db.privileged, pool: t.db.pool },
      { leaseOwner: 'dead', leaseExpiresInSeconds: -30, reaperResumes: 3 },
    );
    const queued = await seedRun({ db: t.db.privileged, pool: t.db.pool }, { status: 'queued' });
    await t.db.pool.query(
      "UPDATE app.run SET created_at = now() - interval '1 hour' WHERE id = $1",
      [queued],
    );
    await t.db.pool.query(
      "UPDATE app.migration SET status = 'running', status_before_run = 'analyzed' WHERE id IN (SELECT migration_id FROM app.run WHERE id = ANY($1))",
      [[abandoned, queued]],
    );
    const enqueued: string[] = [];
    const runtime = {
      enqueueRun: async (runId: string) => void enqueued.push(runId),
      isRunJobPending: async () => false,
    } as unknown as JobRuntime;
    const handlers = maintenanceHandlers(deps({ db: t.db.privileged, runtime }));
    const handler = handlers['maintenance.run-reaper'] as unknown as () => Promise<{
      abandoned: string[];
      settled: string[];
      requeued: string[];
    }>;
    const result = await handler();
    expect(result.abandoned).toContain(abandoned);
    expect(result.requeued).toContain(queued);
    expect(enqueued).toContain(queued);
    const migration = await t.db.pool.query(
      'SELECT m.status FROM app.migration m JOIN app.run r ON r.migration_id = m.id WHERE r.id = $1',
      [abandoned],
    );
    expect(migration.rows[0].status).toBe('failed');
    expect(result.settled).toHaveLength(1);
  }, 60_000);
});
