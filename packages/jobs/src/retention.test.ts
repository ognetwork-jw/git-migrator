import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyRetention } from './retention.ts';
import { type BasicWorld, seedBasics } from './world.fixture.ts';

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase('gm_t028d_');
}, 120_000);
afterAll(async () => {
  await t?.drop();
}, 60_000);

const DAY = 86_400_000;
const ago = (days: number, extraMs = 0): Date => new Date(Date.now() - days * DAY + extraMs);

async function snapshot(
  world: BasicWorld,
  facetKey: string,
  fetchedAt: Date,
  options: { side?: string; repository?: boolean } = {},
): Promise<string> {
  const row = await t.db.privileged.facetSnapshot.create({
    data: {
      side: options.side ?? 'source',
      endpointId: world.sourceEndpointId,
      ...(options.repository === false ? {} : { repositoryId: world.repositoryId }),
      facetKey,
      schemaVersion: 1,
      data: {},
      unreadable: [],
      hash: 'h',
      fetchedAt,
    },
  });
  return row.id;
}

async function analysis(
  world: BasicWorld,
  createdAt: Date,
  snapshots: { source?: string[]; target?: string[] } = {},
): Promise<string> {
  const row = await t.db.privileged.analysis.create({
    data: {
      migrationId: world.migrationId,
      sourceSnapshotIds: snapshots.source ?? [],
      targetSnapshotIds: snapshots.target ?? [],
      readiness: 'ready',
      translation: {},
      createdAt,
    },
  });
  await t.db.privileged.planItem.create({
    data: {
      analysisId: row.id,
      facetKey: 'git-refs',
      kind: 'step',
      code: 'c',
      fieldPaths: [],
      params: {},
      order: 0,
    },
  });
  return row.id;
}

const ids = async (table: string, where = 'true'): Promise<string[]> =>
  (await t.db.pool.query(`SELECT id FROM app.${table} WHERE ${where}`)).rows.map((r) => r.id);

describe('retention pruning', () => {
  it('[DATA-020] deletes raw responses older than 30 days', async () => {
    const world = await seedBasics(t.db.privileged);
    const make = (fetchedAt: Date) =>
      t.db.privileged.rawResponse.create({
        data: {
          endpointId: world.sourceEndpointId,
          method: 'GET',
          url: 'http://x.test/a',
          status: 200,
          fetchedAt,
        },
      });
    const old = await make(ago(31));
    const edge = await make(ago(29));
    const fresh = await make(new Date());
    const result = await applyRetention(t.db.pool);
    expect(result.rawResponses).toBeGreaterThanOrEqual(1);
    const left = await ids('raw_response');
    expect(left).not.toContain(old.id);
    expect(left).toContain(edge.id);
    expect(left).toContain(fresh.id);
  }, 60_000);

  it('[DATA-020] keeps the latest 10 Analyses per Migration, plus those a Run or the Migration references', async () => {
    const world = await seedBasics(t.db.privileged);
    const all: string[] = [];
    for (let i = 0; i < 13; i += 1) all.push(await analysis(world, ago(20 - i)));
    // all[0] oldest ... all[12] newest. Ranks > 10 are all[0..2].
    await t.db.privileged.run.create({
      data: {
        migrationId: world.migrationId,
        analysisId: all[0] as string,
        kind: 'migrate',
        triggeredById: world.actorId,
        options: {},
        status: 'succeeded',
      },
    });
    await t.db.pool.query('UPDATE app.migration SET latest_analysis_id = $2 WHERE id = $1', [
      world.migrationId,
      all[1],
    ]);
    const other = await seedBasics(t.db.privileged);
    const otherAnalysis = await analysis(other, ago(40)); // alone in its Migration: kept
    const result = await applyRetention(t.db.pool);
    expect(result.analyses).toBe(1);
    const left = await ids('analysis', `migration_id = '${world.migrationId}'`);
    expect(left).toHaveLength(12);
    expect(left).not.toContain(all[2]);
    expect(left).toContain(all[0]); // referenced by a Run
    expect(left).toContain(all[1]); // the Migration's latest
    expect(await ids('analysis', `id = '${otherAnalysis}'`)).toHaveLength(1);
    // Plan items cascade with their Analysis.
    expect(await ids('plan_item', `analysis_id = '${all[2]}'`)).toHaveLength(0);
    expect(await ids('plan_item', `analysis_id = '${all[0]}'`)).toHaveLength(1);
  }, 60_000);

  it('[DATA-020] keeps the latest 5 Snapshots per group, plus those of protected Analyses', async () => {
    const world = await seedBasics(t.db.privileged);
    const snaps: string[] = [];
    for (let i = 0; i < 8; i += 1) snaps.push(await snapshot(world, 'webhooks', ago(10 - i)));
    // snaps[0..2] are beyond the latest 5.
    const target = await snapshot(world, 'webhooks', ago(30), { side: 'target' });
    const otherFacet = await snapshot(world, 'variables', ago(30));
    const endpointLevel: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      endpointLevel.push(await snapshot(world, 'members', ago(10 - i), { repository: false }));
    }
    // An Analysis the Migration points at protects snaps[0]; one nobody references does not
    // protect snaps[1].
    const protectedAnalysis = await analysis(world, ago(5), { source: [snaps[0] as string] });
    await t.db.pool.query('UPDATE app.migration SET latest_analysis_id = $2 WHERE id = $1', [
      world.migrationId,
      protectedAnalysis,
    ]);
    await analysis(world, ago(6), { source: [snaps[1] as string] });
    await analysis(world, ago(7), { target: [snaps[2] as string] });

    const result = await applyRetention(t.db.pool);
    expect(result.snapshots).toBeGreaterThanOrEqual(3);
    const left = await ids('facet_snapshot');
    expect(left).toContain(snaps[0]); // protected
    expect(left).not.toContain(snaps[1]);
    expect(left).not.toContain(snaps[2]);
    for (const kept of snaps.slice(3)) expect(left).toContain(kept);
    expect(left).toContain(target); // its own group
    expect(left).toContain(otherFacet);
    expect(left).not.toContain(endpointLevel[0]);
    expect(left).not.toContain(endpointLevel[1]);
    for (const kept of endpointLevel.slice(2)) expect(left).toContain(kept);
  }, 60_000);

  it('[DATA-020] never deletes Runs, RunSteps, Mutations or ParityResults', async () => {
    const world = await seedBasics(t.db.privileged);
    const run = await t.db.privileged.run.create({
      data: {
        migrationId: world.migrationId,
        kind: 'migrate',
        triggeredById: world.actorId,
        options: {},
        status: 'succeeded',
        createdAt: ago(900),
      },
    });
    await applyRetention(t.db.pool);
    expect(await ids('run', `id = '${run.id}'`)).toHaveLength(1);
  }, 60_000);

  it('[DATA-020] is idempotent', async () => {
    const again = await applyRetention(t.db.pool);
    expect(again).toEqual({ rawResponses: 0, analyses: 0, snapshots: 0 });
  }, 60_000);
});
