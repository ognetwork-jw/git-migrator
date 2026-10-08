import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashConfig, syncConfig } from './migrate.ts';
import { markAnalysesStale } from './staleness.ts';
import { createTestDatabase, type TestDatabase } from './test-support.ts';

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase('gm_t061_');
  const endpoint = (id: string) => ({
    id,
    providerType: 'type-a',
    displayName: id,
    baseUrl: `http://${id}.test`,
    configHash: hashConfig({ id }),
  });
  const route = (id: string) => {
    const spec = {
      id,
      sourceEndpointId: 'src',
      targetEndpointId: 'dst',
      targetNamespacePath: 'acme',
      policies: {},
      defaults: {},
      sourcePostAction: 'read-only',
    };
    return { ...spec, configHash: hashConfig(spec) };
  };
  await syncConfig(t.db.privileged, {
    endpoints: [endpoint('src'), endpoint('dst')],
    routes: [route('r1'), route('r2'), route('r3'), route('r4')],
  });
}, 120_000);
afterAll(async () => {
  await t?.drop();
});

const FUTURE = new Date('2099-01-01T00:00:00Z');

async function analyzedMigration(routeId: string, staleAt: Date | null): Promise<string> {
  const p = t.db.privileged;
  const m = await p.migration.findFirstOrThrow({ where: { routeId, scope: 'endpoint' } });
  const analysis = await p.analysis.create({
    data: { migrationId: m.id, readiness: 'ready', translation: {} },
  });
  await p.migration.update({
    where: { id: m.id },
    data: { latestAnalysisId: analysis.id, analysisStaleAt: staleAt },
  });
  return m.id;
}
const staleAt = async (id: string) =>
  (await t.db.privileged.migration.findUniqueOrThrow({ where: { id } })).analysisStaleAt;

describe('API-012 staleness triggers', () => {
  it('[LIF-021] a NamingRule, WebhookAllowlistEntry or Overlay write marks only that Route stale', async () => {
    const p = t.db.privileged;
    const writes: Array<() => Promise<unknown>> = [
      () =>
        p.namingRule.create({
          data: {
            routeId: 'r1',
            scope: 'repository',
            scopeRef: 'x',
            pipeline: { steps: [], template: 'a' },
          },
        }),
      () => p.webhookAllowlistEntry.create({ data: { routeId: 'r1', pattern: 'https://a/**' } }),
      () =>
        p.overlay.create({ data: { routeId: 'r1', facetKey: 'repository-settings', data: {} } }),
    ];
    for (const write of writes) {
      const one = await analyzedMigration('r1', FUTURE);
      const other = await analyzedMigration('r2', FUTURE);
      await write();
      const at = await staleAt(one);
      expect(at && at < FUTURE).toBe(true);
      expect(await staleAt(other)).toEqual(FUTURE);
    }
  });

  it('[LIF-021] updates and deletes mark stale; an earlier stale instant is kept; never-analyzed rows are left alone', async () => {
    const p = t.db.privileged;
    const rule = await p.webhookAllowlistEntry.create({
      data: { routeId: 'r1', pattern: 'https://b/**' },
    });
    const earlier = new Date('2020-01-01T00:00:00Z');
    const id = await analyzedMigration('r1', earlier);
    await p.webhookAllowlistEntry.update({ where: { id: rule.id }, data: { note: 'n' } });
    expect(await staleAt(id)).toEqual(earlier);
    await p.migration.update({ where: { id }, data: { analysisStaleAt: FUTURE } });
    await p.webhookAllowlistEntry.delete({ where: { id: rule.id } });
    expect((await staleAt(id)) as Date).not.toEqual(FUTURE);
    await p.migration.update({
      where: { id },
      data: { latestAnalysisId: null, analysisStaleAt: null },
    });
    await p.overlay.create({ data: { routeId: 'r1', facetKey: 'merge-settings', data: {} } });
    expect(await staleAt(id)).toBeNull();
  });

  it('[JOB-020] a Route starts with avgCallsPerAnalysis 30', async () => {
    expect(
      (await t.db.privileged.route.findUniqueOrThrow({ where: { id: 'r1' } })).avgCallsPerAnalysis,
    ).toBe(30);
  });

  it('[API-012] a statement that writes many rows marks once and publishes one migration.updated event', async () => {
    const p = t.db.privileged;
    const id = await analyzedMigration('r1', FUTURE);
    const listener = new pg.Client({ connectionString: t.connectionString });
    await listener.connect();
    const payloads: string[] = [];
    listener.on('notification', (m) => m.payload && payloads.push(m.payload));
    await listener.query('LISTEN gm_events');
    try {
      await p.webhookAllowlistEntry.createMany({
        data: ['https://a/**', 'https://b/**', 'https://c/**'].map((pattern) => ({
          routeId: 'r1',
          pattern,
        })),
      });
      await listener.query('SELECT 1');
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      await listener.end();
    }
    expect(((await staleAt(id)) as Date) < FUTURE).toBe(true);
    expect(payloads).toHaveLength(1);
    const event = JSON.parse(payloads[0] as string) as { type: string; ids: object; at: string };
    expect(event).toMatchObject({ type: 'migration.updated', ids: {} });
    expect(new Date(event.at).toISOString()).toBe(event.at);
    // Nothing to mark, nothing published.
    const quiet = new pg.Client({ connectionString: t.connectionString });
    await quiet.connect();
    const later: string[] = [];
    quiet.on('notification', (m) => m.payload && later.push(m.payload));
    await quiet.query('LISTEN gm_events');
    await p.webhookAllowlistEntry.deleteMany({ where: { routeId: 'nothing-here' } });
    await quiet.query('SELECT 1');
    await quiet.end();
    expect(later).toEqual([]);
  });

  it('[API-012] marking a Route lifts the retry time but keeps the failure count', async () => {
    const p = t.db.privileged;
    const id = await analyzedMigration('r2', FUTURE);
    await p.migration.update({
      where: { id },
      data: { analysisFailedAt: new Date(), analysisRetryAt: FUTURE, analysisFailureCount: 3 },
    });
    await p.overlay.create({ data: { routeId: 'r2', facetKey: 'merge-settings', data: {} } });
    expect(await p.migration.findUniqueOrThrow({ where: { id } })).toMatchObject({
      analysisFailedAt: null,
      analysisRetryAt: null,
      analysisFailureCount: 3,
    });
  });

  it('[LIF-021] every marker bumps the generation, also for an already-stale or never-analyzed Migration', async () => {
    const p = t.db.privileged;
    const generation = async (id: string) =>
      (await p.migration.findUniqueOrThrow({ where: { id } })).staleGeneration;
    const analyzed = await analyzedMigration('r1', new Date('2020-01-01T00:00:00Z'));
    const never = (
      await p.migration.findFirstOrThrow({ where: { routeId: 'r3', scope: 'endpoint' } })
    ).id;
    const before: [bigint, bigint] = [await generation(analyzed), await generation(never)];
    // Statement trigger.
    await p.overlay.create({ data: { routeId: 'r1', facetKey: 'merge-settings', data: {} } });
    await p.overlay.create({ data: { routeId: 'r3', facetKey: 'merge-settings', data: {} } });
    // JS marker, with its answer: neither was newly marked.
    expect(await markAnalysesStale(p, { ids: [analyzed, never] })).toEqual([]);
    expect(await generation(analyzed)).toBe(before[0] + 2n);
    expect([await generation(analyzed), await generation(never)]).toEqual([
      before[0] + 2n,
      before[1] + 2n,
    ]);
    expect(((await staleAt(analyzed)) as Date).getFullYear()).toBe(2020);
    expect(await staleAt(never)).toBeNull();
  });

  it('[LIF-021] the JS marker reads the database clock and returns what it newly marked', async () => {
    const p = t.db.privileged;
    const fresh = await analyzedMigration('r2', FUTURE);
    expect(await markAnalysesStale(p, { ids: [fresh] })).toEqual([fresh]);
    expect(((await staleAt(fresh)) as Date) <= new Date()).toBe(true);
    expect(await markAnalysesStale(p, { ids: [] })).toEqual([]);
  });

  it('[API-012] TRUNCATE of a watched table marks every Route', async () => {
    const p = t.db.privileged;
    const id = await analyzedMigration('r1', FUTURE);
    const before = (await p.migration.findUniqueOrThrow({ where: { id } })).staleGeneration;
    await t.db.pool.query('TRUNCATE app.overlay');
    expect(((await staleAt(id)) as Date) < FUTURE).toBe(true);
    expect((await p.migration.findUniqueOrThrow({ where: { id } })).staleGeneration).toBe(
      before + 1n,
    );
  });

  it('[FAC-005] an active lossy_accepted record is unique per route, facet, path and note', async () => {
    const p = t.db.privileged;
    const data = {
      routeId: 'r1',
      facetKey: 'branch-rules',
      path: '/rules[pattern=x]',
      reason: 'lossy_accepted' as const,
      note: 'k',
    };
    await p.expectedDifference.create({ data });
    await expect(p.expectedDifference.create({ data })).rejects.toThrow();
    const row = await p.expectedDifference.findFirstOrThrow({
      where: { routeId: 'r1', path: data.path },
    });
    await p.expectedDifference.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
    await p.expectedDifference.create({ data });
  });

  it('[API-012] the trigger and the JS marker lock Migration rows in the same order and do not deadlock', async () => {
    // Physical order differs from id order: zzz-b was written first, zzz-a sorts first.
    const q = (text: string, values: unknown[] = []) => t.db.pool.query(text, values);
    await q(
      `INSERT INTO app.namespace (id, endpoint_id, provider_id, kind, slug, name, updated_at)
       VALUES ('dl-ns', 'src', 'dl-ns', 'workspace', 'dl-ns', 'dl-ns', now())`,
    );
    for (const r of ['dl-rb', 'dl-ra']) {
      await q(
        `INSERT INTO app.repository (id, endpoint_id, namespace_id, provider_id, slug, name, full_path,
           is_private, last_inventoried_at, updated_at)
         VALUES ($1, 'src', 'dl-ns', $1, $1, $1, $1, false, now(), now())`,
        [r],
      );
    }
    await q(
      `INSERT INTO app.migration (id, scope, route_id, source_repository_id, updated_at)
       VALUES ('zzz-b', 'repository', 'r4', 'dl-ra', now())`,
    );
    await q(
      `INSERT INTO app.migration (id, scope, route_id, source_repository_id, updated_at)
       VALUES ('zzz-a', 'repository', 'r4', 'dl-rb', now())`,
    );
    const holder = await t.db.pool.connect();
    const writer = await t.db.pool.connect();
    try {
      // A transaction holds the row that sorts last; the trigger and the marker both queue behind it.
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM app.migration WHERE id = 'zzz-b' FOR UPDATE`);
      await writer.query('BEGIN');
      const trigger = writer
        .query(
          `INSERT INTO app.naming_rule (id, route_id, scope, scope_ref, pipeline, updated_at)
           VALUES ('dl-nr', 'r4', 'repository', 'x', '{"steps":[],"template":"a"}', now())`,
        )
        .then(
          async () => {
            await writer.query('COMMIT');
            return 'ok';
          },
          (e: { code?: string }) => `error ${e.code}`,
        );
      const waitingOn = async (n: number) => {
        for (let i = 0; i < 20_000; i++) {
          const r = await q(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE wait_event_type = 'Lock' AND datname = current_database()`,
          );
          if ((r.rows[0] as { n: number }).n >= n) return;
          await new Promise((res) => setImmediate(res));
        }
        throw new Error('the writers never queued behind the held row');
      };
      await waitingOn(1);
      const marker = markAnalysesStale(t.db.privileged, { routeId: 'r4' }).then(
        () => 'ok',
        (e: { code?: string }) => `error ${e.code}`,
      );
      await waitingOn(2);
      await holder.query('COMMIT');
      expect(await Promise.all([trigger, marker])).toEqual(['ok', 'ok']);
    } finally {
      holder.release();
      writer.release();
    }
  });
});
