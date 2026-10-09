import type { RepositoryRecord } from '@git-migrator/adapter-sdk';
import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { seedParityWorld } from '../parity/parity.fixture.ts';
import { repositoryHeldElsewhere } from '../rollback/steps.ts';
import { seedBasics } from '../world.fixture.ts';
import { INTENT_SETTLE_MARGIN_SECONDS, ledgerShowsCreation } from './repository.ts';

vi.setConfig({ testTimeout: 30_000 });

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase('gm_t089c_');
}, 120_000);
afterAll(async () => {
  await t?.drop();
}, 60_000);

const db = () => t.db.privileged;
const T0 = Date.parse('2026-10-09T10:00:00.000Z');
const at = (seconds: number): Date => new Date(T0 + seconds * 1000);

/**
 * A Run that opened a create intent at T0, kept working until `lastStepAt`, and was ended (by the
 * worker or, late, by the reaper) at `finishedAt`.
 */
async function world(lastStepAt: Date, finishedAt: Date | null) {
  const w = await seedBasics(db());
  const run = await db().run.create({
    data: {
      migrationId: w.migrationId,
      kind: 'migrate',
      triggeredById: w.actorId,
      options: {},
      status: finishedAt ? 'failed' : 'running',
      startedAt: at(-30),
    },
  });
  await db().runStep.create({
    data: { runId: run.id, stepKey: 'target.ensure-repository', order: 1, status: 'failed' },
  });
  await db().mutation.create({
    data: {
      migrationId: w.migrationId,
      runId: run.id,
      side: 'target',
      facetKey: 'framework',
      resourceRef: { kind: 'repository', name: 'plat-r' },
      paths: [],
      action: 'create',
      state: 'intended',
    },
  });
  await db().$executeRaw`UPDATE app.mutation SET created_at = ${at(0)} WHERE run_id = ${run.id}`;
  await db()
    .$executeRaw`UPDATE app.run_step SET updated_at = ${lastStepAt} WHERE run_id = ${run.id}`;
  if (finishedAt) {
    await db().$executeRaw`UPDATE app.run SET finished_at = ${finishedAt} WHERE id = ${run.id}`;
  }
  return w;
}

const repo = (createdAt: Date): RepositoryRecord =>
  ({ providerId: 'R_1', name: 'plat-r', slug: 'plat-r', createdAt }) as RepositoryRecord;

describe('[LIF-077] an open create intent vouches for an empty repository only inside the Run’s own window', () => {
  it('[LIF-077] a repository made just after the intent, by the Run, is the framework’s', async () => {
    const w = await world(at(5), at(6));
    expect(await ledgerShowsCreation(db(), w.migrationId, repo(at(2)), true)).toBe(true);
  });

  it('[LIF-077] a repository older than the intent, or not empty, is not', async () => {
    const w = await world(at(5), at(6));
    expect(await ledgerShowsCreation(db(), w.migrationId, repo(at(-60)), true)).toBe(false);
    expect(await ledgerShowsCreation(db(), w.migrationId, repo(at(2)), false)).toBe(false);
  });

  it('[LIF-077] a late reaper does not widen the window: the Run’s last activity bounds it, not the time it was ended', async () => {
    // The worker died at T0+5 s; the reaper ended the Run an hour later.
    const w = await world(at(5), at(3600));
    const inside = at(5 + INTENT_SETTLE_MARGIN_SECONDS - 1);
    const outside = at(5 + INTENT_SETTLE_MARGIN_SECONDS + 5);
    expect(await ledgerShowsCreation(db(), w.migrationId, repo(inside), true)).toBe(true);
    expect(await ledgerShowsCreation(db(), w.migrationId, repo(outside), true)).toBe(false);
    // Nor one made by hand ten minutes after the worker died, well before the reaper acted.
    expect(await ledgerShowsCreation(db(), w.migrationId, repo(at(600)), true)).toBe(false);
  });

  it('[LIF-077] a Run that is still running has no end', async () => {
    const w = await world(at(5), null);
    expect(await ledgerShowsCreation(db(), w.migrationId, repo(at(600)), true)).toBe(true);
  });
});

describe('[LIF-077] a repository another Migration holds is never this Migration’s to delete', () => {
  it('[LIF-077] is held by the Migration that has it as its target, or that recorded creating it', async () => {
    const a = await seedParityWorld(db(), 'migrated');
    const b = await seedBasics(db());
    // As its target.
    expect(await repositoryHeldElsewhere(db(), b.migrationId, a.targetEndpointId, 'tgt-1')).toBe(
      true,
    );
    expect(await repositoryHeldElsewhere(db(), a.migrationId, a.targetEndpointId, 'tgt-1')).toBe(
      false,
    );
    // As the repository its ledger says it created.
    expect(await repositoryHeldElsewhere(db(), b.migrationId, a.targetEndpointId, 'R_9')).toBe(
      false,
    );
    const run = await db().run.create({
      data: {
        migrationId: a.migrationId,
        kind: 'migrate',
        triggeredById: a.actorId,
        options: {},
        status: 'succeeded',
      },
    });
    await db().mutation.create({
      data: {
        migrationId: a.migrationId,
        runId: run.id,
        side: 'target',
        facetKey: 'framework',
        resourceRef: { kind: 'repository', id: 'R_9', name: 'x' },
        paths: [],
        action: 'create',
        state: 'recorded',
      },
    });
    expect(await repositoryHeldElsewhere(db(), b.migrationId, a.targetEndpointId, 'R_9')).toBe(
      true,
    );
    expect(await repositoryHeldElsewhere(db(), a.migrationId, a.targetEndpointId, 'R_9')).toBe(
      false,
    );
  });
});
