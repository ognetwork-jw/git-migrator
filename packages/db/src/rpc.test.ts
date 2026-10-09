import { RPCApiHandler } from '@zenstackhq/server/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PolicyActor, PolicyDb } from './client.ts';
import { schema } from './generated/schema.ts';
import { createTestDatabase, type TestDatabase } from './test-support.ts';
import { buildWorld, type World } from './test-world.ts';

let testDb: TestDatabase;
let world: World;
let viewer: PolicyDb;
let operator: PolicyDb;
let anonymous: PolicyDb;
const handler = new RPCApiHandler({ schema });

beforeAll(async () => {
  testDb = await createTestDatabase('gm_t010_');
  world = await buildWorld(testDb.db.privileged);
  viewer = testDb.db.forActor(world.actors.viewer as PolicyActor);
  operator = testDb.db.forActor(world.actors.operator as PolicyActor);
  anonymous = testDb.db.forActor(undefined);
}, 120_000);

afterAll(async () => {
  await testDb?.drop();
});

const call = (
  client: PolicyDb,
  method: string,
  path: string,
  requestBody?: unknown,
  query?: Record<string, string>,
) =>
  handler.handleRequest({
    client: client as never,
    method,
    path,
    ...(requestBody === undefined ? {} : { requestBody }),
    ...(query === undefined ? {} : { query }),
  });

describe('[API-012] the ZenStack RPC handler runs on the policy facade', () => {
  it('[UI-021] a text search with % or _ is literal, not a wildcard (repositories list)', async () => {
    const search = async (text: string) => {
      const q = JSON.stringify({
        where: {
          sourceRepository: {
            OR: [
              { name: { contains: text, mode: 'insensitive' } },
              { fullPath: { contains: text, mode: 'insensitive' } },
            ],
          },
        },
      });
      const res = await call(viewer, 'GET', '/migration/count', undefined, { q });
      return (res.body as { data: number }).data;
    };
    expect(await search('auto')).toBeGreaterThan(0);
    expect(await search('%')).toBe(0);
    expect(await search('_')).toBe(0);
    expect(await search('a_to')).toBe(0);
  });

  it('[API-012] a viewer reads through GET /wave/findMany', async () => {
    const res = await call(viewer, 'GET', '/wave/findMany');
    expect(res.status).toBe(200);
    expect((res.body as { data: unknown[] }).data.length).toBeGreaterThan(0);
  });

  it('[API-012] an unauthenticated caller reads no rows', async () => {
    const res = await call(anonymous, 'GET', '/wave/findMany');
    expect(res.status).toBe(200);
    expect((res.body as { data: unknown[] }).data).toEqual([]);
  });

  it('[API-012] an operator creates a Wave, which the allow-list permits', async () => {
    const res = await call(operator, 'POST', '/wave/create', { data: { name: 'rpc-wave' } });
    expect(res.status).toBe(201);
    expect(
      await testDb.db.privileged.wave.findFirst({ where: { name: 'rpc-wave' } }),
    ).not.toBeNull();
  });

  it('[API-012] a viewer cannot create a Wave', async () => {
    const res = await call(viewer, 'POST', '/wave/create', { data: { name: 'rpc-denied' } });
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toMatch(/sql|rpc-denied|insert/i);
    expect(await testDb.db.privileged.wave.findFirst({ where: { name: 'rpc-denied' } })).toBeNull();
  });

  it('[API-012] an operator cannot write a model outside the allow-list', async () => {
    const res = await call(operator, 'POST', '/actor/update', {
      where: { id: world.actors.operator.id },
      data: { role: 'admin' },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const after = await testDb.db.privileged.actor.findUnique({
      where: { id: world.actors.operator.id },
    });
    expect(after?.role).toBe('operator');
  });

  it('[API-012] the transaction route runs its operations under the policies', async () => {
    const ok = await call(operator, 'POST', '/$transaction/sequential', [
      { model: 'Wave', op: 'create', args: { data: { name: 'rpc-tx' } } },
      { model: 'Wave', op: 'findMany', args: {} },
    ]);
    expect(ok.status).toBe(200);
    expect(await testDb.db.privileged.wave.findFirst({ where: { name: 'rpc-tx' } })).not.toBeNull();

    const denied = await call(viewer, 'POST', '/$transaction/sequential', [
      { model: 'Wave', op: 'create', args: { data: { name: 'rpc-tx-denied' } } },
    ]);
    expect(denied.status).toBe(403);
    expect(
      await testDb.db.privileged.wave.findFirst({ where: { name: 'rpc-tx-denied' } }),
    ).toBeNull();
  });
});
