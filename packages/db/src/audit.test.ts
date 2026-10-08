import { ZenStackClient } from '@zenstackhq/orm';
import { PolicyPlugin } from '@zenstackhq/plugin-policy';
import { RPCApiHandler } from '@zenstackhq/server/api';
import { PostgresDialect } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AUDIT_MAX_VALUE_LENGTH,
  AUDIT_REDACTED,
  auditActorId,
  auditChanges,
  auditValue,
  rpcAuditAction,
} from './audit.ts';
import type { PolicyActor, PolicyDb } from './client.ts';
import { schema } from './generated/schema.ts';
import { createTestDatabase, type TestDatabase } from './test-support.ts';
import { buildWorld, type World } from './test-world.ts';

let testDb: TestDatabase;
let world: World;
let operator: PolicyDb;
let admin: PolicyDb;
let viewer: PolicyDb;

beforeAll(async () => {
  testDb = await createTestDatabase('gm_t021b_');
  world = await buildWorld(testDb.db.privileged);
  operator = testDb.db.forActor(world.actors.operator as PolicyActor);
  admin = testDb.db.forActor(world.actors.admin as PolicyActor);
  viewer = testDb.db.forActor(world.actors.viewer as PolicyActor);
}, 120_000);

afterAll(async () => {
  await testDb?.drop();
});

const events = (where: Record<string, unknown> = {}) =>
  testDb.db.privileged.auditEvent.findMany({ where, orderBy: { id: 'asc' } });
const total = () => testDb.db.privileged.auditEvent.count();
const dataOf = (event: { data: unknown } | undefined): Data => {
  expect(event).toBeDefined();
  return (event as { data: Data }).data;
};
type Data = { via: string; changes: Record<string, { from?: unknown; to?: unknown }> };

describe('[AUTH-022] RPC mutations are audited by a ZenStack plugin', () => {
  it('[AUTH-022] a create records the Actor, action, subject and the new values', async () => {
    const wave = await operator.wave.create({ data: { name: 'audited-wave' } });
    const [event, ...rest] = await events({ subjectId: wave.id });
    expect(rest).toEqual([]);
    expect(event).toMatchObject({
      actorId: world.actors.operator.id,
      action: 'rpc.wave.create',
      subjectType: 'wave',
      subjectId: wave.id,
    });
    const data = dataOf(event);
    expect(data.via).toBe('rpc');
    expect(data.changes.name).toEqual({ to: 'audited-wave' });
    expect(data.changes.updatedAt).toBeUndefined();
    expect(data.changes.createdAt).toBeUndefined();
  });

  it('[AUTH-022] an update records only the fields that changed', async () => {
    const wave = await operator.wave.create({ data: { name: 'audit-update' } });
    await operator.wave.update({ where: { id: wave.id }, data: { description: 'hello' } });
    await operator.wave.update({ where: { id: wave.id }, data: { description: 'hello' } });
    const updates = await events({ subjectId: wave.id, action: 'rpc.wave.update' });
    expect(updates).toHaveLength(2);
    expect(dataOf(updates[0]).changes).toEqual({
      description: { from: null, to: 'hello' },
    });
    // An update that changes nothing is still a mutation by an Actor, with an empty diff.
    expect(dataOf(updates[1]).changes).toEqual({});
  });

  it('[AUTH-022] Migration.waveId and ManualTask.note updates are audited with their column names mapped', async () => {
    const wave = await operator.wave.create({ data: { name: 'audit-move' } });
    const migrationId = (world.where.Migration as { id: string }).id;
    await operator.migration.update({ where: { id: migrationId }, data: { waveId: wave.id } });
    const [moved] = await events({ subjectId: migrationId, action: 'rpc.migration.update' });
    expect(moved?.action).toBe('rpc.migration.update');
    expect(dataOf(moved).changes).toEqual({ waveId: { from: null, to: wave.id } });

    const taskId = (world.where.ManualTask as { id: string }).id;
    await operator.manualTask.update({ where: { id: taskId }, data: { note: 'checked' } });
    const [noted] = await events({ subjectId: taskId, action: 'rpc.manual_task.update' });
    expect(noted?.action).toBe('rpc.manual_task.update');
    expect(dataOf(noted).changes).toEqual({ note: { from: null, to: 'checked' } });
  });

  it('[AUTH-022] a delete records the removed values, and a bulk mutation one event per row', async () => {
    const a = await operator.wave.create({ data: { name: 'bulk-a', description: 'bulk' } });
    const b = await operator.wave.create({ data: { name: 'bulk-b', description: 'bulk' } });
    await operator.wave.updateMany({
      where: { description: 'bulk' },
      data: { description: 'done' },
    });
    const updates = await events({ action: 'rpc.wave.update', subjectId: { in: [a.id, b.id] } });
    expect(updates.map((e) => e.subjectId).sort()).toEqual([a.id, b.id].sort());

    await operator.wave.delete({ where: { id: a.id } });
    const [removed] = await events({ subjectId: a.id, action: 'rpc.wave.delete' });
    expect(dataOf(removed).changes.name).toEqual({ from: 'bulk-a' });
  });

  it('[AUTH-022] an admin-only model is audited with the admin as the Actor', async () => {
    const created = await admin.webhookAllowlistEntry.create({
      data: { ...world.createData('WebhookAllowlistEntry') } as never,
    });
    const [event] = await events({ subjectId: (created as { id: string }).id });
    expect(event?.actorId).toBe(world.actors.admin.id);
    expect(event?.action).toBe('rpc.webhook_allowlist_entry.create');
  });

  it('[AUTH-022] a denied mutation and a read leave no event', async () => {
    const before = await total();
    await expect(viewer.wave.create({ data: { name: 'denied' } })).rejects.toThrow();
    await viewer.wave.findMany({});
    await operator.wave.findMany({});
    expect(await total()).toBe(before);
  });

  it('[AUTH-022] the audit event commits and rolls back together with the mutation', async () => {
    const before = await total();
    await expect(
      operator.$transaction(async (tx) => {
        await tx.wave.create({ data: { name: 'rolled-back' } });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect(
      await testDb.db.privileged.wave.findFirst({ where: { name: 'rolled-back' } }),
    ).toBeNull();
    expect(await total()).toBe(before);

    await operator.$transaction(async (tx) => {
      await tx.wave.create({ data: { name: 'committed-a' } });
      await tx.wave.create({ data: { name: 'committed-b' } });
    });
    expect(await total()).toBe(before + 2);

    await operator.$transaction([
      operator.wave.create({ data: { name: 'committed-c' } }),
      operator.wave.create({ data: { name: 'committed-d' } }),
    ]);
    expect(await total()).toBe(before + 4);
  });

  it('[AUTH-022] the privileged client is not audited by the plugin (custom endpoints write their own events)', async () => {
    const before = await total();
    await testDb.db.privileged.wave.create({ data: { name: 'privileged-wave' } });
    expect(await total()).toBe(before);
  });

  it('[AUTH-022] no RPC caller can write AuditEvent: the facade exposes only its read operations', async () => {
    const delegate = admin.auditEvent as unknown as Record<string, unknown>;
    for (const name of [
      'create',
      'createMany',
      'update',
      'updateMany',
      'upsert',
      'delete',
      'deleteMany',
    ]) {
      expect(delegate[name], name).toBeUndefined();
    }
    expect(typeof delegate.findMany).toBe('function');
    const handler = new RPCApiHandler({ schema });
    const before = await total();
    const res = await handler.handleRequest({
      client: admin as never,
      method: 'POST',
      path: '/auditEvent/create',
      requestBody: {
        data: {
          action: 'forged',
          subjectType: 'x',
          subjectId: 'y',
          actorId: world.actors.admin.id,
        },
      },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await total()).toBe(before);
  });

  it('[AUTH-022] the audit write is not itself audited', async () => {
    expect(await events({ subjectType: 'audit_event' })).toEqual([]);
  });
});

describe('[AUTH-022] the diff is redacted and bounded', () => {
  it('[AUTH-022] secret-looking fields and nested keys are replaced', () => {
    expect(auditValue('apiKey', 'gm_abc')).toBe(AUDIT_REDACTED);
    expect(auditValue('hash', 'deadbeef')).toBe(AUDIT_REDACTED);
    expect(auditValue('clientSecret', 'x')).toBe(AUDIT_REDACTED);
    expect(
      auditValue('data', { facet: 'a', nested: { password: 'p', list: [{ token: 't' }] } }),
    ).toEqual({
      facet: 'a',
      nested: { password: AUDIT_REDACTED, list: [{ token: AUDIT_REDACTED }] },
    });
    expect(auditValue('facetKey', 'branch-rules')).toBe('branch-rules');
  });

  it('[AUTH-022] values are JSON-safe and long values are omitted', () => {
    expect(auditValue('d', new Date('2026-01-02T03:04:05.000Z'))).toBe('2026-01-02T03:04:05.000Z');
    expect(auditValue('d', new Date(Number.NaN))).toBeNull();
    expect(auditValue('n', 5n)).toBe('5');
    expect(auditValue('b', new Uint8Array(3))).toBe('[3 bytes]');
    expect(auditValue('u', undefined)).toBeNull();
    expect(auditValue('s', 'x'.repeat(AUDIT_MAX_VALUE_LENGTH + 1))).toMatch(/^\[omitted: 2001/);
    expect(auditValue('j', { a: 'x'.repeat(AUDIT_MAX_VALUE_LENGTH) })).toMatch(/^\[omitted/);
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 30; i++) {
      const next: Record<string, unknown> = {};
      cursor.n = next;
      cursor = next;
    }
    expect(JSON.stringify(auditValue('deep', deep))).toContain('[too deep]');
  });

  it('[AUTH-022] a diff compares dates and JSON by value', () => {
    const t = new Date('2026-01-01T00:00:00Z');
    expect(
      auditChanges('update', { at: t, j: { a: 1 }, x: 1 }, { at: new Date(t), j: { a: 1 }, x: 2 }),
    ).toEqual({ x: { from: 1, to: 2 } });
    expect(rpcAuditAction('WebhookAllowlistEntry', 'create')).toBe(
      'rpc.webhook_allowlist_entry.create',
    );
  });

  it('[AUTH-022] a secret-looking field in a real mutation is not stored', async () => {
    const overlay = await admin.overlay.create({
      data: {
        ...world.createData('Overlay'),
        data: { token: 'tok-123', keep: 'visible' },
      } as never,
    });
    const [event] = await events({ subjectId: (overlay as { id: string }).id });
    const text = JSON.stringify(event?.data);
    expect(text).not.toContain('tok-123');
    expect(text).toContain('visible');
  });
});

describe('[AUTH-022] details of the audit trail', () => {
  it('[AUTH-022] deleting a Wave records the Migrations whose waveId it clears', async () => {
    const wave = await operator.wave.create({ data: { name: 'cleared-by-delete' } });
    const migrationId = (world.where.Migration as { id: string }).id;
    await operator.migration.update({ where: { id: migrationId }, data: { waveId: wave.id } });
    await operator.wave.delete({ where: { id: wave.id } });
    const [event] = await events({ subjectId: wave.id, action: 'rpc.wave.delete' });
    const data = (event as unknown as { data: { clearedMigrationIds: string[] } }).data;
    expect(data.clearedMigrationIds).toEqual([migrationId]);
    const empty = await operator.wave.create({ data: { name: 'cleared-none' } });
    await operator.wave.delete({ where: { id: empty.id } });
    const [none] = await events({ subjectId: empty.id, action: 'rpc.wave.delete' });
    expect(
      (none as unknown as { data: { clearedMigrationIds: string[] } }).data.clearedMigrationIds,
    ).toEqual([]);
  });

  it('[AUTH-022] a mutation without an Actor id cannot be audited, so the audit step throws (fail closed)', () => {
    expect(() => auditActorId({})).toThrow(/without an Actor/);
    expect(() => auditActorId({ $auth: { id: '' } })).toThrow(/without an Actor/);
    expect(() => auditActorId({ $auth: {} })).toThrow(/without an Actor/);
    expect(auditActorId({ $auth: { id: 'abc' } })).toBe('abc');
  });

  it('[AUTH-022] primary keys cannot be changed through RPC, so a subject id never moves', async () => {
    const rows: Array<[string, string, Record<string, unknown>, PolicyDb]> = [
      ['wave', 'Wave', world.where.Wave as Record<string, unknown>, operator],
      ['namingRule', 'NamingRule', world.where.NamingRule as Record<string, unknown>, admin],
      [
        'webhookAllowlistEntry',
        'WebhookAllowlistEntry',
        world.where.WebhookAllowlistEntry as Record<string, unknown>,
        admin,
      ],
      ['overlay', 'Overlay', world.where.Overlay as Record<string, unknown>, admin],
      ['migration', 'Migration', world.where.Migration as Record<string, unknown>, operator],
      ['manualTask', 'ManualTask', world.where.ManualTask as Record<string, unknown>, operator],
    ];
    for (const [key, , where, client] of rows) {
      const before = await total();
      const delegate = (
        client as unknown as Record<string, { update(a: unknown): Promise<unknown> }>
      )[key];
      await expect(
        delegate?.update({ where, data: { id: '00000000-0000-7000-8000-0000000000aa' } }),
        key,
      ).rejects.toThrow();
      expect(await total(), key).toBe(before);
    }
  });
});

describe('[AUTH-022] the AuditEvent create rule, at policy level', () => {
  const policed = (actor: object) =>
    new ZenStackClient(schema, {
      dialect: new PostgresDialect({ pool: testDb.db.pool }),
    } as never)
      .$use(new PolicyPlugin())
      .$setAuth(actor as never) as unknown as {
      auditEvent: { create(a: unknown): Promise<unknown>; update(a: unknown): Promise<unknown> };
    };
  const data = (actorId: string | null) => ({
    data: { actorId, action: 'probe', subjectType: 'x', subjectId: 'y' },
  });

  it('[AUTH-022] an Actor may create an event about itself, and about nobody else', async () => {
    const me = world.actors.operator;
    const client = policed(me);
    await expect(client.auditEvent.create(data(me.id))).resolves.toBeDefined();
    await expect(client.auditEvent.create(data(world.actors.admin.id))).rejects.toThrow();
    await expect(client.auditEvent.create(data(null))).rejects.toThrow();
  });

  it('[AUTH-022] a disabled Actor and an anonymous caller cannot create events, and events are never updated', async () => {
    const off = await testDb.db.privileged.actor.create({
      data: { kind: 'human', displayName: 'off', role: 'admin', disabled: true },
    });
    await expect(policed(off).auditEvent.create(data(off.id))).rejects.toThrow();
    await expect(policed(undefined as never).auditEvent.create(data(null))).rejects.toThrow();
    const mine = await policed(world.actors.admin).auditEvent.create(data(world.actors.admin.id));
    await expect(
      policed(world.actors.admin).auditEvent.update({
        where: { id: (mine as { id: string }).id },
        data: { action: 'edited' },
      }),
    ).rejects.toThrow();
  });
});
