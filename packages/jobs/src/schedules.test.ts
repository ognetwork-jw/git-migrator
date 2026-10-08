import { resolveConfig } from '@git-migrator/config';
import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import { createLogger } from '@git-migrator/observability';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { migrateBullmqSchema } from './connection.ts';
import { JobRuntime } from './runtime.ts';
import {
  desiredSchedulers,
  endpointMigrationIds,
  reconcileSchedulers,
  SchedulerManager,
} from './schedules.ts';
import { seedBasics } from './world.fixture.ts';

const YAML = `
endpoints:
  - id: src-a
    provider: bitbucket-cloud
    options: { workspace: acme }
  - id: dst-a
    provider: github
    options: { org: acme-org, appId: 1, installationId: 2 }
routes:
  - id: r1
    source: src-a
    target: dst-a
    targetNamespace: acme-org
schedules:
  inventory: "0 */4 * * *"
`;
const config = resolveConfig({ text: YAML, env: {} });
const log = createLogger({ level: 'silent' });

let t: TestDatabase;
let runtime: JobRuntime | undefined;
beforeAll(async () => {
  t = await createTestDatabase('gm_t028s_');
  await migrateBullmqSchema(t.connectionString);
}, 120_000);
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});
afterAll(async () => {
  await t?.drop();
}, 60_000);

describe('job schedulers from config', () => {
  it('[JOB-050] derives the schedulers and cron patterns from config', () => {
    const specs = desiredSchedulers(config, ['m1']);
    const byId = Object.fromEntries(specs.map((s) => [s.id, s]));
    expect(byId['inventory:src-a']).toMatchObject({
      queue: 'inventory',
      job: 'inventory.endpoint',
      data: { endpointId: 'src-a' },
      pattern: '0 */4 * * *',
    });
    expect(byId['inventory:dst-a']?.data).toEqual({ endpointId: 'dst-a' });
    expect(byId['analysis-feeder']).toMatchObject({
      queue: 'maintenance',
      job: 'analysis.feeder',
      pattern: '* * * * *',
    });
    expect(byId['drift-sweep']).toMatchObject({
      queue: 'parity',
      job: 'drift.sweep',
      pattern: '17 3 * * *',
    });
    expect(byId.prune).toMatchObject({ job: 'maintenance.prune', pattern: '*/10 * * * *' });
    expect(byId['run-reaper']).toMatchObject({
      job: 'maintenance.run-reaper',
      pattern: '* * * * *',
    });
    expect(byId['endpoint-parity:m1']).toMatchObject({
      queue: 'parity',
      job: 'parity.migration',
      data: { migrationId: 'm1' },
      pattern: '47 3 * * *',
    });
  });

  it('[JOB-050] leaves scratch cleanup to every pod, not to a scheduler', () => {
    const jobs = desiredSchedulers(config, []).map((s) => s.job as string);
    expect(jobs).not.toContain('maintenance.scratch-cleanup');
  });

  it('[JOB-050] registers the schedulers in BullMQ, idempotently, and removes stale ones', async () => {
    runtime = new JobRuntime({ connectionString: t.connectionString, log, workerCount: 0 });
    await runtime.waitUntilReady();
    const first = await reconcileSchedulers(runtime, desiredSchedulers(config, ['m1', 'm2']));
    expect(first.removed).toBe(0);
    const keys = async (queue: 'inventory' | 'parity' | 'maintenance') =>
      (await runtime?.queue(queue).getJobSchedulers(0, -1))?.map((s) => s.key).sort();
    expect(await keys('inventory')).toEqual(['inventory:dst-a', 'inventory:src-a']);
    expect(await keys('parity')).toEqual([
      'drift-sweep',
      'endpoint-parity:m1',
      'endpoint-parity:m2',
    ]);
    expect(await keys('maintenance')).toEqual(['analysis-feeder', 'prune', 'run-reaper']);
    const schedulers = await runtime.queue('inventory').getJobSchedulers(0, -1);
    expect(schedulers.every((s) => s.pattern === '0 */4 * * *')).toBe(true);

    await reconcileSchedulers(runtime, desiredSchedulers(config, ['m1', 'm2']));
    expect(await keys('parity')).toHaveLength(3);

    const second = await reconcileSchedulers(runtime, desiredSchedulers(config, ['m1']));
    expect(second.removed).toBe(1);
    expect(await keys('parity')).toEqual(['drift-sweep', 'endpoint-parity:m1']);
  }, 60_000);

  it('[JOB-050] reads endpoint Migrations of live Routes and re-reconciles from the database', async () => {
    runtime = new JobRuntime({ connectionString: t.connectionString, log, workerCount: 0 });
    await runtime.waitUntilReady();
    const world = await seedBasics(t.db.privileged);
    const endpointMigration = await t.db.privileged.migration.create({
      data: { scope: 'endpoint', routeId: world.routeId },
    });
    const retired = await seedBasics(t.db.privileged);
    await t.db.privileged.migration.create({
      data: { scope: 'endpoint', routeId: retired.routeId },
    });
    await t.db.pool.query('UPDATE app.route SET retired_at = now() WHERE id = $1', [
      retired.routeId,
    ]);
    expect(await endpointMigrationIds(t.db.pool)).toEqual([endpointMigration.id]);

    const manager = new SchedulerManager({
      runtime,
      appPool: t.db.pool,
      config,
      log,
      refreshMs: 100,
    });
    const result = await manager.start();
    expect(result.upserted).toBe(2 + 4 + 1);
    const later = await seedBasics(t.db.privileged);
    const added = await t.db.privileged.migration.create({
      data: { scope: 'endpoint', routeId: later.routeId },
    });
    const wanted = `endpoint-parity:${added.id}`;
    const deadline = Date.now() + 10_000;
    for (;;) {
      const keys = (await runtime.queue('parity').getJobSchedulers(0, -1)).map((s) => s.key);
      if (keys.includes(wanted)) break;
      if (Date.now() > deadline) throw new Error('scheduler not re-reconciled');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    manager.stop();
  }, 60_000);
});
