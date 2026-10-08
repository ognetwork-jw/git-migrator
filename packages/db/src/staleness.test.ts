import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashConfig, syncConfig } from './migrate.ts';
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
    routes: [route('r1'), route('r2')],
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
});
