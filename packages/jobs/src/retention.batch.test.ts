import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyRetention, RETENTION_BATCH } from './retention.ts';
import { seedBasics } from './world.fixture.ts';

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase('gm_t028b_');
}, 120_000);
afterAll(async () => {
  await t?.drop();
}, 60_000);

describe('retention batching', () => {
  it('[DATA-020] deletes a backlog larger than one batch, batch by batch', async () => {
    expect(RETENTION_BATCH).toBe(1_000);
    const world = await seedBasics(t.db.privileged);
    const total = 2 * RETENTION_BATCH + 250;
    await t.db.pool.query(
      `INSERT INTO app.raw_response (id, endpoint_id, method, url, status, fetched_at, updated_at)
       SELECT gen_random_uuid()::text, $1, 'GET', 'http://x.test/' || n, 200,
              now() - interval '40 days', now()
       FROM generate_series(1, $2) AS n`,
      [world.sourceEndpointId, total],
    );
    await t.db.pool.query(
      `INSERT INTO app.facet_snapshot
         (id, side, endpoint_id, repository_id, facet_key, schema_version, data, unreadable, hash,
          fetched_at, raw_response_ids, updated_at)
       SELECT gen_random_uuid()::text, 'source', $1, $2, 'webhooks', 1, '{}', '{}', 'h',
              now() - n * interval '1 minute', '{}', now()
       FROM generate_series(1, $3) AS n`,
      [world.sourceEndpointId, world.repositoryId, total],
    );
    const statements: string[] = [];
    const spy = {
      query: (...args: unknown[]) => {
        statements.push(String(args[0]));
        return (t.db.pool.query as (...a: unknown[]) => Promise<unknown>).apply(t.db.pool, args);
      },
    } as unknown as typeof t.db.pool;
    const result = await applyRetention(spy);
    expect(result.rawResponses).toBe(total);
    // Raw responses are deleted 1,000 at a time by the database alone, never read into memory.
    const raw = statements.filter((sql) => sql.includes('app.raw_response'));
    expect(raw).toHaveLength(4); // 1,000 + 1,000 + 250 + the empty pass
    for (const sql of raw) expect(sql).toMatch(/^DELETE FROM app\.raw_response WHERE id IN/);
    expect(result.snapshots).toBe(total - 5);
    const left = await t.db.pool.query('SELECT count(*)::int AS n FROM app.facet_snapshot');
    expect(left.rows[0].n).toBe(5);
    // The five that stay are the newest.
    const newest = await t.db.pool.query(
      'SELECT max(fetched_at) - min(fetched_at) AS span FROM app.facet_snapshot',
    );
    expect(newest.rows[0].span.minutes).toBe(4);
  }, 120_000);

  it('[DATA-020] keeps an Analysis or Snapshot that became protected after the ranking', async () => {
    const world = await seedBasics(t.db.privileged);
    const snapshots: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const row = await t.db.privileged.facetSnapshot.create({
        data: {
          side: 'source',
          endpointId: world.sourceEndpointId,
          repositoryId: world.repositoryId,
          facetKey: 'variables',
          schemaVersion: 1,
          data: {},
          unreadable: [],
          hash: 'h',
          fetchedAt: new Date(Date.now() - (10 - i) * 60_000),
        },
      });
      snapshots.push(row.id);
    }
    const analyses: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const row = await t.db.privileged.analysis.create({
        data: {
          migrationId: world.migrationId,
          sourceSnapshotIds: [],
          targetSnapshotIds: [],
          readiness: 'ready',
          translation: {},
          createdAt: new Date(Date.now() - (20 - i) * 60_000),
        },
      });
      analyses.push(row.id);
    }
    // analyses[0..1] and snapshots[0] are the victims of the ranking.
    const result = await applyRetention(t.db.pool, {
      afterRanking: async (table) => {
        if (table === 'analysis') {
          // A Run starts on the oldest Analysis between the ranking and the delete.
          await t.db.privileged.run.create({
            data: {
              migrationId: world.migrationId,
              analysisId: analyses[0] as string,
              kind: 'migrate',
              triggeredById: world.actorId,
              options: {},
              status: 'queued',
            },
          });
        } else {
          // The protected Analysis now also uses the oldest Snapshot.
          await t.db.pool.query(
            'UPDATE app.analysis SET source_snapshot_ids = ARRAY[$2::text] WHERE id = $1',
            [analyses[0], snapshots[0]],
          );
        }
      },
    });
    expect(result.analyses).toBe(1);
    expect(result.snapshots).toBe(0);
    const left = await t.db.pool.query<{ id: string }>(
      'SELECT id FROM app.analysis WHERE migration_id = $1',
      [world.migrationId],
    );
    expect(left.rows.map((r) => r.id)).toContain(analyses[0]);
    expect(left.rows.map((r) => r.id)).not.toContain(analyses[1]);
    const snap = await t.db.pool.query('SELECT 1 FROM app.facet_snapshot WHERE id = $1', [
      snapshots[0],
    ]);
    expect(snap.rowCount).toBe(1);
  }, 120_000);
});
