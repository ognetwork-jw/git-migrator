import { ORMError, ORMErrorReason } from '@zenstackhq/orm';
import Decimal from 'decimal.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db, PolicyActor, PolicyDb } from './client.ts';
import { schema } from './generated/schema.ts';
import { createTestDatabase, type TestDatabase } from './test-support.ts';
import { type AnyDelegate, buildWorld, delegateOf, type World } from './test-world.ts';

type Role = 'viewer' | 'operator' | 'admin';
const ROLES: readonly Role[] = ['viewer', 'operator', 'admin'];
const MODELS = Object.keys(schema.models);

/**
 * API-012 / AUTH-020: the RPC writes that exist, per model, and the lowest role that may make them.
 * Every other write, on every other model, must be denied for every role including admin (DOM-005).
 */
// Overlay is absent on purpose: its writes go through /api/v1/overlays only (ADR-0362).
const RPC_WRITABLE: Record<string, Role> = {
  Wave: 'operator',
  NamingRule: 'admin',
  WebhookAllowlistEntry: 'admin',
};
const RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };
const mayWrite = (model: string, role: Role): boolean => {
  const needed = RPC_WRITABLE[model];
  return needed !== undefined && RANK[role] >= RANK[needed];
};

let testDb: TestDatabase;
let world: World;
let privileged: Db;
const clients = {} as Record<Role, PolicyDb>;
let anonymous: PolicyDb;

beforeAll(async () => {
  testDb = await createTestDatabase('gm_t010_');
  privileged = testDb.db.privileged;
  world = await buildWorld(privileged);
  for (const role of ROLES) {
    clients[role] = testDb.db.forActor(world.actors[role] as PolicyActor);
  }
  anonymous = testDb.db.forActor(undefined);
}, 120_000);

afterAll(async () => {
  await testDb?.drop();
});

/** The write was refused by a policy (or filtered out by one), not by a database constraint. */
async function expectDenied(attempt: Promise<unknown>): Promise<void> {
  const error = await attempt.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, 'the write must be refused').toBeInstanceOf(ORMError);
  expect([ORMErrorReason.REJECTED_BY_POLICY, ORMErrorReason.NOT_FOUND]).toContain(
    (error as ORMError).reason,
  );
}

const row = async (model: string, where: Record<string, unknown>) =>
  (await delegateOf(privileged, model).findFirst({ where })) as Record<string, unknown> | null;

describe('policy test world', () => {
  it('[DOM-001] has a row in every model, so the matrix covers the whole schema', async () => {
    expect(Object.keys(world.where).sort()).toEqual([...MODELS].sort());
    for (const model of MODELS) {
      expect(await row(model, world.where[model] as Record<string, unknown>), model).not.toBeNull();
    }
  });
});

describe('[AUTH-020] read access', () => {
  for (const role of ROLES) {
    it(`[AUTH-020] ${role} reads every model`, async () => {
      for (const model of MODELS) {
        const rows = await delegateOf(clients[role], model).findMany({});
        expect(rows.length, `${role} reading ${model}`).toBeGreaterThan(0);
      }
    });
  }

  it('[AUTH-021] an unauthenticated caller reads nothing from any model', async () => {
    for (const model of MODELS) {
      expect(await delegateOf(anonymous, model).findMany({}), model).toEqual([]);
    }
  });

  it('[AUTH-021] an unauthenticated caller cannot write', async () => {
    await expectDenied(anonymous.wave.create({ data: world.createData('Wave') as never }));
  });
});

describe('[DOM-005] default-deny writes; [API-012] only the allow-listed RPC writes', () => {
  // AuditEvent has no write operations on the facade at all (ADR-0201); audit.test.ts covers it.
  for (const model of MODELS.filter((m) => m !== 'AuditEvent')) {
    for (const role of ROLES) {
      it(`[DOM-005] ${role} create ${model}: ${mayWrite(model, role) ? 'allowed' : 'denied'}`, async () => {
        const attempt = delegateOf(clients[role], model).create({ data: world.createData(model) });
        if (mayWrite(model, role)) {
          await expect(attempt).resolves.toBeDefined();
        } else {
          const before = await delegateOf(privileged, model).findMany({});
          await expectDenied(attempt);
          expect((await delegateOf(privileged, model).findMany({})).length).toBe(before.length);
        }
      });

      it(`[DOM-005] ${role} update ${model}: ${mayWrite(model, role) ? 'allowed' : 'denied'}`, async () => {
        const where = world.where[model] as Record<string, unknown>;
        const data = world.patch(model);
        const key = Object.keys(data)[0] as string;
        const before = (await row(model, where)) as Record<string, unknown>;
        const attempt = (delegateOf(clients[role], model) as AnyDelegate).update({ where, data });
        if (mayWrite(model, role)) {
          await expect(attempt).resolves.toBeDefined();
          expect((await row(model, where))?.[key]).not.toEqual(before[key]);
        } else {
          await expectDenied(attempt);
          expect((await row(model, where))?.[key]).toEqual(before[key]);
        }
      });

      it(`[DOM-005] ${role} delete ${model}: ${mayWrite(model, role) ? 'allowed' : 'denied'}`, async () => {
        if (mayWrite(model, role)) {
          const fresh = (await delegateOf(privileged, model).create({
            data: world.createData(model),
          })) as { id: string };
          await expect(
            delegateOf(clients[role], model).delete({ where: { id: fresh.id } }),
          ).resolves.toBeDefined();
          expect(await row(model, { id: fresh.id })).toBeNull();
        } else {
          const where = world.where[model] as Record<string, unknown>;
          await expectDenied(delegateOf(clients[role], model).delete({ where }));
          expect(await row(model, where), 'the row survives').not.toBeNull();
        }
      });
    }
  }
});

describe('[API-012] Migration.waveId is the only RPC-writable Migration field', () => {
  const migrationId = () => (world.where.Migration as { id: string }).id;

  for (const role of ROLES) {
    it(`[AUTH-020] ${role} sets Migration.waveId: ${role === 'viewer' ? 'denied' : 'allowed'}`, async () => {
      const wave = (await privileged.wave.create({ data: world.createData('Wave') as never })) as {
        id: string;
      };
      await privileged.migration.update({ where: { id: migrationId() }, data: { waveId: null } });
      const attempt = clients[role].migration.update({
        where: { id: migrationId() },
        data: { waveId: wave.id },
      });
      if (role === 'viewer') {
        await expectDenied(attempt);
        expect((await row('Migration', { id: migrationId() }))?.waveId).toBeNull();
      } else {
        await expect(attempt).resolves.toBeDefined();
        expect((await row('Migration', { id: migrationId() }))?.waveId).toBe(wave.id);
      }
    });
  }

  it('[API-012] an operator can also assign through the wave relation and unassign', async () => {
    const wave = (await privileged.wave.create({ data: world.createData('Wave') as never })) as {
      id: string;
    };
    await clients.operator.migration.update({
      where: { id: migrationId() },
      data: { wave: { connect: { id: wave.id } } },
    });
    expect((await row('Migration', { id: migrationId() }))?.waveId).toBe(wave.id);
    await clients.operator.migration.update({
      where: { id: migrationId() },
      data: { waveId: null },
    });
    expect((await row('Migration', { id: migrationId() }))?.waveId).toBeNull();
  });

  it('[DOM-013] deleting a Wave unsets waveId on its Migrations', async () => {
    const wave = (await privileged.wave.create({ data: world.createData('Wave') as never })) as {
      id: string;
    };
    await privileged.migration.update({ where: { id: migrationId() }, data: { waveId: wave.id } });
    await clients.operator.wave.delete({ where: { id: wave.id } });
    expect((await row('Migration', { id: migrationId() }))?.waveId).toBeNull();
  });

  it('[DOM-005] nested writes cannot reach other models through an allowed one', async () => {
    const waveId = (world.where.Wave as { id: string }).id;
    await expectDenied(
      clients.admin.wave.update({
        where: { id: waveId },
        data: { migrations: { create: { scope: 'repository', routeId: 'route-1' } } },
      }),
    );
    await expectDenied(
      clients.admin.migration.update({
        where: { id: migrationId() },
        data: {
          runs: {
            create: { kind: 'migrate', triggeredById: world.actors.admin.id, options: {} },
          },
        },
      }),
    );
  });
});

describe('[DOM-011] lifecycle fields are written only by the privileged client', () => {
  const anyDate = new Date('2031-01-01T00:00:00.000Z');
  // One valid payload per protected Migration field. The structural test below fails when a field
  // is added to the model without being added here, so the list cannot rot.
  const payloads: Record<string, () => unknown> = {
    id: () => '01990000-0000-7000-8000-000000000000',
    scope: () => 'endpoint',
    routeId: () => 'route-1',
    sourceRepositoryId: () => null,
    targetRepositoryId: () => null,
    targetPlacedEndpointId: () => null,
    targetPlacedNamespaceId: () => null,
    targetPlacementUnknown: () => true,
    plannedTargetName: () => 'renamed',
    status: () => 'verified',
    statusBeforeRun: () => 'running',
    statusBeforeDrift: () => 'running',
    statusBeforeManual: () => 'running',
    statusBeforeMissing: () => 'running',
    runBlockers: () => [{ code: 'x' }],
    readiness: () => 'blocked',
    readinessCounts: () => ({ blockers: 9 }),
    blockerCodes: () => ['x.y'],
    latestAnalysisId: () => null,
    analysisStaleAt: () => anyDate,
    analysisFailedAt: () => anyDate,
    analysisFailureCount: () => 9,
    analysisRetryAt: () => anyDate,
    staleGeneration: () => 9n,
    parityGeneration: () => 9n,
    targetCreatedByFramework: () => true,
    sourceReadOnlyApplied: () => true,
    verifiedAt: () => anyDate,
    manualCompletion: () => ({ reason: 'x' }),
    lastParityAt: () => anyDate,
    lastDriftCheckAt: () => anyDate,
    createdAt: () => anyDate,
    updatedAt: () => anyDate,
  };
  const SCALARS = Object.entries(schema.models.Migration.fields).filter(
    ([, f]) => !(f as { relation?: unknown }).relation,
  );
  const PROTECTED = SCALARS.map(([name]) => name).filter((name) => name !== 'waveId');

  it('[DOM-011] every Migration scalar field except waveId carries a field-level @deny(update)', () => {
    for (const name of PROTECTED) {
      const attrs = (
        schema.models.Migration.fields as unknown as Record<
          string,
          { attributes?: { name: string }[] }
        >
      )[name]?.attributes;
      expect(
        attrs?.some((a) => a.name === '@deny'),
        `Migration.${name} needs @deny('update', true)`,
      ).toBe(true);
    }
    expect(Object.keys(payloads).sort()).toEqual([...PROTECTED].sort());
  });

  for (const role of ['operator', 'admin'] as const) {
    for (const field of Object.keys(payloads)) {
      it(`[DOM-011] ${role} cannot update Migration.${field}`, async () => {
        const where = world.where.Migration as { id: string };
        const before = (await row('Migration', where)) as Record<string, unknown>;
        await expectDenied(
          clients[role].migration.update({
            where,
            data: { [field]: (payloads[field] as () => unknown)() } as never,
          }),
        );
        expect(await row('Migration', where)).toEqual(before);
      });
    }

    it(`[DOM-011] ${role} cannot rewrite lifecycle fields in bulk or by upsert`, async () => {
      const where = world.where.Migration as { id: string };
      const before = await row('Migration', where);
      await expectDenied(clients[role].migration.updateMany({ data: { status: 'verified' } }));
      await expectDenied(
        clients[role].migration.upsert({
          where,
          create: { scope: 'endpoint', routeId: 'route-1' },
          update: { readiness: 'ready' },
        }),
      );
      expect(await row('Migration', where)).toEqual(before);
    });

    it(`[DOM-011] ${role} cannot repoint a Migration through a relation field`, async () => {
      const where = world.where.Migration as { id: string };
      await expectDenied(
        clients[role].migration.update({ where, data: { route: { connect: { id: 'route-1' } } } }),
      );
      await expectDenied(
        clients[role].migration.update({
          where,
          data: {
            latestAnalysis: { connect: { id: (world.where.Analysis as { id: string }).id } },
          },
        }),
      );
    });
  }

  it('[DOM-011] the privileged client writes the same fields', async () => {
    const where = world.where.Migration as { id: string };
    const updated = await privileged.migration.update({
      where,
      data: { status: 'analyzed', readiness: 'ready', blockerCodes: ['a.b'], verifiedAt: anyDate },
    });
    expect(updated.status).toBe('analyzed');
    expect(updated.blockerCodes).toEqual(['a.b']);
  });
});

describe('[API-012] ManualTask.note is the only RPC-writable ManualTask field', () => {
  const where = () => world.where.ManualTask as { id: string };

  it('[AUTH-020] an operator edits the note', async () => {
    await clients.operator.manualTask.update({ where: where(), data: { note: 'operator note' } });
    expect((await row('ManualTask', where()))?.note).toBe('operator note');
  });

  it('[AUTH-020] a viewer cannot edit the note', async () => {
    await expectDenied(
      clients.viewer.manualTask.update({ where: where(), data: { note: 'nope' } }),
    );
    expect((await row('ManualTask', where()))?.note).not.toBe('nope');
  });

  for (const role of ['operator', 'admin'] as const) {
    it(`[API-012] ${role} cannot change task status, completion or any other field`, async () => {
      const before = await row('ManualTask', where());
      const denied: Record<string, unknown>[] = [
        { status: 'done' },
        { status: 'dismissed' },
        { completedAt: new Date() },
        { completedById: world.actors[role].id },
        { code: 'other' },
        { params: { a: 1 } },
        { verifiable: true },
        { phase: 'pre' },
        { paramsHash: 'zzz' },
        { createdAt: new Date('2031-01-01T00:00:00.000Z') },
        { updatedAt: new Date('2031-01-01T00:00:00.000Z') },
      ];
      for (const data of denied) {
        await expectDenied(
          clients[role].manualTask.update({ where: where(), data: data as never }),
        );
      }
      await expectDenied(
        clients[role].manualTask.update({
          where: where(),
          data: { completedBy: { connect: { id: world.actors[role].id } } },
        }),
      );
      expect(await row('ManualTask', where())).toEqual(before);
    });
  }
});

describe('[API-012] ManualTask fields are all protected except note', () => {
  it('[API-012] every ManualTask scalar field except note carries a field-level @deny(update)', () => {
    const fields = schema.models.ManualTask.fields as unknown as Record<
      string,
      { relation?: unknown; attributes?: { name: string }[] }
    >;
    for (const [name, f] of Object.entries(fields)) {
      if (f.relation || name === 'note') continue;
      expect(
        f.attributes?.some((a) => a.name === '@deny'),
        `ManualTask.${name}`,
      ).toBe(true);
    }
  });
});

describe('[DOM-011] timestamps and the automatic updatedAt', () => {
  it('[DOM-011] an operator cannot rewrite timestamps through a nested Wave update', async () => {
    const waveId = (world.where.Wave as { id: string }).id;
    const migrationId = (world.where.Migration as { id: string }).id;
    await privileged.migration.update({ where: { id: migrationId }, data: { waveId } });
    const before = await row('Migration', { id: migrationId });
    for (const field of ['createdAt', 'updatedAt', 'verifiedAt', 'status']) {
      const value = field === 'status' ? 'verified' : new Date('2031-01-01T00:00:00.000Z');
      await expectDenied(
        clients.operator.wave.update({
          where: { id: waveId },
          data: { migrations: { updateMany: { where: {}, data: { [field]: value } } } } as never,
        }),
      );
    }
    expect(await row('Migration', { id: migrationId })).toEqual(before);
    await privileged.migration.update({ where: { id: migrationId }, data: { waveId: null } });
  });

  it('[DOM-011] updated_at is still set (by the database) on an allowed waveId or note update', async () => {
    const migrationId = (world.where.Migration as { id: string }).id;
    const taskId = (world.where.ManualTask as { id: string }).id;
    const stamp = async (model: string, id: string): Promise<number> =>
      ((await row(model, { id })) as { updatedAt: Date }).updatedAt.getTime();
    const m0 = await stamp('Migration', migrationId);
    await clients.operator.migration.update({ where: { id: migrationId }, data: { waveId: null } });
    expect(await stamp('Migration', migrationId)).toBeGreaterThan(m0);
    const t0 = await stamp('ManualTask', taskId);
    await clients.operator.manualTask.update({ where: { id: taskId }, data: { note: 'again' } });
    expect(await stamp('ManualTask', taskId)).toBeGreaterThan(t0);
  });
});

describe('[AUTH-005] a disabled Actor holds no rights', () => {
  it('[AUTH-021] a disabled admin reads nothing and writes nothing', async () => {
    const disabled = await privileged.actor.create({
      data: { kind: 'human', displayName: 'off', role: 'admin', disabled: true },
    });
    const client = testDb.db.forActor(disabled as PolicyActor);
    expect(await client.wave.findMany({})).toEqual([]);
    await expectDenied(client.namingRule.create({ data: world.createData('NamingRule') as never }));
    await expectDenied(client.wave.create({ data: world.createData('Wave') as never }));
  });
});

describe('[AUTH-021] a policy client is an allow-list facade', () => {
  const MODEL_KEYS = Object.keys(schema.models).map((m) => m.charAt(0).toLowerCase() + m.slice(1));
  const ALLOWED = [...MODEL_KEYS, '$schema', '$transaction'].sort();
  const ESCAPES = [
    '$qb',
    '$qbRaw',
    '$zod',
    '$procs',
    '$diagnostics',
    '$contract',
    '$auth',
    '$options',
    '$use',
    '$unuse',
    '$unuseAll',
    '$setAuth',
    '$setOptions',
    '$setInputValidation',
    '$pushSchema',
    '$connect',
    '$disconnect',
    '$executeRaw',
    '$executeRawUnsafe',
    '$queryRaw',
    '$queryRawUnsafe',
    'kysely',
    'kyselyRaw',
    'kyselyProps',
    'options',
    'schema',
    'auth',
    'inputValidator',
    'withExecutor',
    'isTransaction',
    'forceTransaction',
    'interactiveTransaction',
    'sequentialTransaction',
    'createRawCompiledQuery',
    'constructor',
    '__proto__',
  ];

  const inspect = (get: () => object, label: string) => {
    it(`[AUTH-021] ${label}: only model delegates and $transaction exist`, () => {
      const client = get();
      expect(Object.getOwnPropertyNames(client).sort()).toEqual(ALLOWED);
      expect(Reflect.ownKeys(client).filter((k) => typeof k === 'symbol')).toEqual([]);
      expect(Object.getPrototypeOf(client)).toBeNull();
      expect(Object.isFrozen(client)).toBe(true);
      for (const name of ESCAPES) {
        const record = client as Record<string, unknown>;
        expect(record[name], name).toBeUndefined();
        expect(name in client, name).toBe(false);
        expect(Object.getOwnPropertyDescriptor(client, name), name).toBeUndefined();
      }
    });
    it(`[AUTH-021] ${label}: delegates are frozen copies exposing only CRUD methods`, () => {
      const client = get();
      const wave = (client as unknown as Record<string, Record<string, unknown>>).wave as Record<
        string,
        unknown
      >;
      expect(Object.isFrozen(wave)).toBe(true);
      expect(Object.getPrototypeOf(wave)).toBeNull();
      expect(Object.keys(wave).sort()).toEqual(
        [
          'aggregate',
          'count',
          'create',
          'createMany',
          'createManyAndReturn',
          'delete',
          'deleteMany',
          'exists',
          'findFirst',
          'findFirstOrThrow',
          'findMany',
          'findUnique',
          'findUniqueOrThrow',
          'groupBy',
          'update',
          'updateMany',
          'updateManyAndReturn',
          'upsert',
        ].sort(),
      );
    });
  };

  inspect(() => clients.viewer, 'a viewer client');
  inspect(() => clients.admin, 'an admin client');
  inspect(() => anonymous, 'an unauthenticated client');

  it('[AUTH-021] the client given to a $transaction callback is the same facade and still enforces policies', async () => {
    await clients.viewer.$transaction(async (tx) => {
      expect(Object.getOwnPropertyNames(tx).sort()).toEqual(ALLOWED);
      expect(Object.getPrototypeOf(tx)).toBeNull();
      for (const name of ESCAPES)
        expect((tx as Record<string, unknown>)[name], name).toBeUndefined();
      await expectDenied(tx.wave.create({ data: world.createData('Wave') as never }));
    });
    const [rows] = await clients.viewer.$transaction([clients.viewer.wave.findMany({})]);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('[AUTH-021] a viewer cannot reach a query builder to rewrite a lifecycle field', async () => {
    const viewer = clients.viewer as unknown as Record<
      string,
      { updateTable?: unknown } | undefined
    >;
    expect(viewer.$qbRaw).toBeUndefined();
    expect(viewer.$qb).toBeUndefined();
    expect(viewer.kyselyRaw).toBeUndefined();
    const where = world.where.Migration as { id: string };
    const before = await row('Migration', where);
    await clients.viewer.$transaction(async (tx) => {
      const t = tx as unknown as Record<string, unknown>;
      expect(t.$qbRaw).toBeUndefined();
      expect(t.withExecutor).toBeUndefined();
    });
    expect(await row('Migration', where)).toEqual(before);
  });

  it('[AUTH-021] $schema is exposed read-only and deep-frozen, and shared by every facade', () => {
    const s = clients.viewer.$schema as unknown as { models: Record<string, { fields: object }> };
    expect(Object.keys(s.models)).toEqual(Object.keys(schema.models));
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.isFrozen(s.models)).toBe(true);
    expect(Object.isFrozen(s.models.Wave)).toBe(true);
    expect(Object.isFrozen(s.models.Wave?.fields)).toBe(true);
    expect(() => {
      delete (s.models as Record<string, unknown>).Wave;
    }).toThrow();
    expect(clients.admin.$schema).toBe(s);
    expect(s).not.toBe(schema);
  });

  // biome-ignore lint/suspicious/noThenProperty: a forged thenable is what these tests attack with
  const forgedCb = (cb: (tx: never) => Promise<unknown>) => ({ then: () => undefined, cb });
  const asOps = (...ops: unknown[]) => ops as unknown as Promise<unknown>[];

  for (const mode of ['a top-level facade', 'a callback facade'] as const) {
    const run = <T>(client: PolicyDb, body: (db: PolicyDb) => Promise<T>): Promise<T> =>
      mode === 'a callback facade' ? client.$transaction(body) : body(client);

    describe(`the array form of $transaction on ${mode} takes only operations it issued`, () => {
      it('[AUTH-021] a forged { then, cb } is rejected and its cb never runs', async () => {
        let ran = false;
        const forged = forgedCb(async () => {
          ran = true;
        });
        await run(clients.viewer, async (db) => {
          await expect(db.$transaction(asOps(forged))).rejects.toThrow(/issued by this client/);
        });
        expect(ran).toBe(false);
      });

      it('[AUTH-021] a mixed array runs nothing when one element is forged', async () => {
        let ran = false;
        const forged = forgedCb(async () => {
          ran = true;
        });
        const marker = world.createData('Wave');
        await run(clients.admin, async (db) => {
          await expect(
            db.$transaction(asOps(db.wave.create({ data: marker as never }), forged)),
          ).rejects.toThrow(/issued by this client/);
        });
        expect(ran).toBe(false);
        expect(await row('Wave', { name: marker.name as string })).toBeNull();
      });

      it('[AUTH-021] a viewer cannot reach $qbRaw to set a Migration to verified', async () => {
        const where = world.where.Migration as { id: string };
        const before = await row('Migration', where);
        let reached = false;
        const forged = forgedCb(async (tx) => {
          reached = true;
          return (tx as { $qbRaw: unknown }).$qbRaw;
        });
        await run(clients.viewer, async (db) => {
          await expect(db.$transaction(asOps(forged))).rejects.toThrow();
        });
        expect(reached).toBe(false);
        expect(await row('Migration', where)).toEqual(before);
      });

      it('[API-012] an anonymous caller cannot read ApiKey.hash through a forged operation', async () => {
        let leaked: unknown;
        const forged = forgedCb(async (tx) => {
          leaked = tx;
        });
        await run(anonymous, async (db) => {
          await expect(db.$transaction(asOps(forged))).rejects.toThrow();
        });
        expect(leaked).toBeUndefined();
      });

      const expr =
        (sql: string) =>
        (eb: {
          fn: (n: string, a: unknown[]) => unknown;
          val: (v: unknown) => unknown;
          cast: (e: unknown, t: string) => unknown;
          // biome-ignore lint/suspicious/noExplicitAny: a stand-in for the Kysely expression builder
          (...a: any[]): unknown;
        }) =>
          eb(eb.cast(eb.cast(eb.fn('query_to_xml', [eb.val(sql)]), 'text'), 'integer'), '=', 1);

      it('[AUTH-021] a where.$expr callback is refused before any SQL runs', async () => {
        let calls = 0;
        const probe = (eb: never) => {
          calls++;
          return expr('select hash from app.api_key')(eb);
        };
        await run(clients.viewer, async (db) => {
          const attempt = (db.wave.findMany as (a: unknown) => Promise<unknown>)({
            where: { $expr: probe },
          });
          await expect(attempt).rejects.toThrow(/\$expr is not allowed/);
          await expect(
            (db.apiKey.findMany as (a: unknown) => Promise<unknown>)({
              where: { NOT: [{ $expr: probe }] },
            }),
          ).rejects.toBeInstanceOf(ORMError);
        });
        expect(calls).toBe(0);
      });

      it('[AUTH-021] a nested $expr in include, select or a relation filter is refused', async () => {
        const fn = (eb: never) => expr('select 1')(eb);
        await run(clients.viewer, async (db) => {
          const wave = db.wave.findMany as (a: unknown) => Promise<unknown>;
          for (const args of [
            { include: { migrations: { where: { $expr: fn } } } },
            { where: { migrations: { some: { $expr: 'not a function' } } } },
            { where: { migrations: { some: { id: { in: [fn] } } } } },
            { select: { migrations: { where: { id: { equals: fn } } } } },
          ]) {
            await expect(wave(args)).rejects.toBeInstanceOf(ORMError);
          }
        });
      });

      it('[AUTH-021] class instances, Maps, accessors, symbols, cycles and deep nesting are refused', async () => {
        await run(clients.viewer, async (db) => {
          const wave = db.wave.findMany as (a: unknown) => Promise<unknown>;
          const cyclic: Record<string, unknown> = {};
          cyclic.self = cyclic;
          let deep: Record<string, unknown> = {};
          for (let i = 0; i < 100; i++) deep = { a: deep };
          const accessor = {};
          Object.defineProperty(accessor, 'name', { get: () => 'x', enumerable: true });
          class Odd {}
          const refused = [
            { where: { name: new Odd() } },
            { where: { name: new Map() } },
            { where: { name: new Set() } },
            { where: { name: Symbol('s') } },
            { where: accessor },
            { where: { [Symbol('k')]: 1 } },
            { where: cyclic },
            { where: deep },
          ];
          for (const args of refused) await expect(wave(args)).rejects.toBeInstanceOf(ORMError);
        });
      });

      it('[AUTH-021] ordinary arguments with Date, Decimal, bigint and bytes still work', async () => {
        await run(clients.viewer, async (db) => {
          const wave = db.wave.findMany as (a: unknown) => Promise<unknown[]>;
          expect(
            (await wave({ where: { createdAt: { lte: new Date() } } })).length,
          ).toBeGreaterThan(0);
          expect(
            (await wave({ include: { migrations: true }, orderBy: { name: 'asc' }, take: 5 }))
              .length,
          ).toBeGreaterThan(0);
          for (const odd of [new Decimal('1.5'), 10n, new Uint8Array([1, 2])]) {
            // Refused by ZenStack's own validation for this field, never by the data walk.
            const error = await wave({ where: { name: odd } }).catch((e: unknown) => e);
            expect((error as Error).message ?? '').not.toMatch(/arguments may only hold/);
          }
        });
      });

      it('[AUTH-021] a denied write throws an error without sql, sqlParams, dbErrorMessage or cause', async () => {
        await run(clients.viewer, async (db) => {
          const error = (await db.wave
            .update({
              where: { id: world.where.Wave?.id as string },
              data: { name: 'secret-value' },
            })
            .catch((e: unknown) => e)) as ORMError;
          expect(error).toBeInstanceOf(ORMError);
          expect([ORMErrorReason.REJECTED_BY_POLICY, ORMErrorReason.NOT_FOUND]).toContain(
            error.reason,
          );
          expect(error.model).toBe('Wave');
          for (const prop of ['sql', 'sqlParams', 'dbErrorMessage']) {
            expect((error as unknown as Record<string, unknown>)[prop], prop).toBeUndefined();
          }
          expect(error.cause).toBeUndefined();
          expect(JSON.stringify(error)).not.toContain('secret-value');
          expect(error.message).not.toMatch(/select|insert|update|secret-value/i);
        });
      });

      it('[AUTH-021] a database error is sanitized too, keeping only its code', async () => {
        await run(clients.admin, async (db) => {
          const error = (await db.wave
            .create({
              data: {
                name: world.createData('Wave').name as string,
                id: world.where.Wave?.id as string,
              } as never,
            })
            .catch((e: unknown) => e)) as ORMError;
          expect(error).toBeInstanceOf(ORMError);
          for (const prop of ['sql', 'sqlParams', 'dbErrorMessage']) {
            expect((error as unknown as Record<string, unknown>)[prop], prop).toBeUndefined();
          }
          expect(error.cause).toBeUndefined();
        });
      });

      it('[AUTH-021] a delegate call exposes no cb, only then, catch and finally', async () => {
        await run(clients.viewer, async (db) => {
          const op = db.wave.findMany({}) as unknown as Record<string, unknown>;
          expect(Reflect.ownKeys(op).sort()).toEqual(['catch', 'finally', 'then']);
          expect(op.cb).toBeUndefined();
          expect(Object.getPrototypeOf(op)).toBeNull();
          expect(Object.isFrozen(op)).toBe(true);
          expect((await (op as unknown as Promise<unknown[]>)).length).toBeGreaterThan(0);
        });
      });
    });
  }

  it('[AUTH-021] an operation issued by another facade is rejected', async () => {
    const foreign = clients.admin.wave.findMany({});
    await expect(clients.viewer.$transaction(asOps(foreign))).rejects.toThrow(
      /issued by this client/,
    );
    await foreign;
  });

  it('[AUTH-021] anything other than a function or an array is rejected', async () => {
    await expect(
      (clients.viewer.$transaction as (a: unknown) => Promise<unknown>)({}),
    ).rejects.toThrow(/callback or an array/);
  });

  it('[AUTH-021] a holder cannot patch the delegates other holders get', async () => {
    const mutate = () => {
      (clients.viewer as unknown as Record<string, unknown>).wave = {};
    };
    expect(mutate).toThrow();
    expect(() => {
      (clients.viewer.wave as unknown as Record<string, unknown>).findMany = () => [];
    }).toThrow();
    expect((await clients.viewer.wave.findMany({})).length).toBeGreaterThan(0);
  });
});

describe('[AUTH-020] admin-only models', () => {
  for (const model of ['NamingRule', 'WebhookAllowlistEntry', 'Overlay']) {
    it(`[AUTH-020] an operator cannot create, update or delete ${model}`, async () => {
      await expectDenied(
        delegateOf(clients.operator, model).create({ data: world.createData(model) }),
      );
      const where = world.where[model] as Record<string, unknown>;
      await expectDenied(
        delegateOf(clients.operator, model).update({ where, data: world.patch(model) }),
      );
      await expectDenied(delegateOf(clients.operator, model).delete({ where }));
    });
  }

  it('[API-012] [DOM-003] [UI-032] no role writes an Overlay over RPC, the validated endpoint is the only writer', async () => {
    const where = world.where.Overlay as Record<string, unknown>;
    for (const role of ROLES) {
      const client = delegateOf(clients[role], 'Overlay');
      await expectDenied(client.create({ data: world.createData('Overlay') }));
      await expectDenied(client.update({ where, data: world.patch('Overlay') }));
      await expectDenied(client.delete({ where }));
    }
    expect(await row('Overlay', where)).not.toBeNull();
    const read = await clients.viewer.overlay.findMany({});
    expect(read.length).toBeGreaterThan(0);
  });

  it('[AUTH-020] Actors and API keys are changed only by server code, even by an admin', async () => {
    const actorWhere = { id: world.actors.operator.id };
    await expectDenied(clients.admin.actor.update({ where: actorWhere, data: { role: 'admin' } }));
    await expectDenied(clients.admin.actor.update({ where: actorWhere, data: { disabled: true } }));
    expect((await row('Actor', actorWhere))?.role).toBe('operator');
    await expectDenied(
      clients.admin.apiKey.update({
        where: world.where.ApiKey as { id: string },
        data: { revokedAt: new Date() },
      }),
    );
  });
});

describe('[API-012] secrets are denied for read', () => {
  const keyWhere = () => world.where.ApiKey as { id: string };

  for (const role of ROLES) {
    it(`[API-012] ${role} never reads ApiKey.hash, by select, default read or filter`, async () => {
      const hash = (await row('ApiKey', keyWhere()))?.hash as string;
      expect(hash).toMatch(/^f{64}$/);
      const read = await clients[role].apiKey.findUnique({ where: keyWhere() });
      expect(read?.prefix).toBe('abcd1234');
      expect(read?.hash ?? null).toBeNull();
      const selected = await clients[role].apiKey.findMany({ select: { hash: true } });
      expect(selected.every((k) => (k.hash ?? null) === null)).toBe(true);
      const probed = await clients[role].apiKey.findMany({ where: { hash } });
      expect(probed, 'filtering on the hash must not confirm it').toEqual([]);
    });
  }

  it('[API-012] the privileged client reads the hash for key verification (AUTH-040)', async () => {
    expect((await privileged.apiKey.findUnique({ where: keyWhere() }))?.hash).toMatch(/^f{64}$/);
  });

  it('[AUTH-020] a viewer does not read RawResponse bodies; operators and admins do', async () => {
    const where = world.where.RawResponse as { id: string };
    const viewer = await clients.viewer.rawResponse.findUnique({ where });
    expect(viewer?.status).toBe(200);
    expect(viewer?.body ?? null).toBeNull();
    expect(
      await clients.viewer.rawResponse.findMany({
        where: { body: { equals: { secret: 'body' } } },
      }),
    ).toEqual([]);
    for (const role of ['operator', 'admin'] as const) {
      expect((await clients[role].rawResponse.findUnique({ where }))?.body).toEqual({
        secret: 'body',
      });
    }
  });

  describe('[FAC-WEB-002] webhook URLs that carry credentials (ADR-0503)', () => {
    // Assembled at run time so no credential-shaped literal is committed.
    const CREDENTIAL = ['hook', 'pass', '-', 'LEAK'].join('');
    const url = `https://ci.example.test/notify?token=${CREDENTIAL}`;
    const ids = { snapshot: '', analysis: '', planItem: '', task: '' };
    const TRANSLATED_URL = '$.facets.webhooks.desired.hooks[0].url';

    beforeAll(async () => {
      const where = world.where.FacetSnapshot as { id: string };
      const base = await privileged.facetSnapshot.findUniqueOrThrow({ where });
      const snapshot = await privileged.facetSnapshot.create({
        data: {
          side: 'source',
          endpointId: base.endpointId,
          repositoryId: base.repositoryId,
          facetKey: 'webhooks',
          schemaVersion: 1,
          data: { hooks: [{ key: 'k', url, events: ['push'] }] },
          unreadable: [],
          hash: 'h-webhooks',
          fetchedAt: new Date(),
          rawResponseIds: [],
        },
      });
      const migrationId = (world.where.Migration as { id: string }).id;
      const analysis = await privileged.analysis.create({
        data: {
          migrationId,
          sourceSnapshotIds: [snapshot.id],
          targetSnapshotIds: [],
          readiness: 'ready',
          translation: { facets: { webhooks: { desired: { hooks: [{ key: 'k', url }] } } } },
        },
      });
      ids.snapshot = snapshot.id;
      ids.analysis = analysis.id;
      const display = 'https://ci.example.test/…';
      const planItem = await privileged.planItem.create({
        data: {
          analysisId: analysis.id,
          facetKey: 'webhooks',
          kind: 'post_task',
          code: 'webhooks.recreate-manually',
          fieldPaths: [],
          params: { key: 'k', targetUrlDisplay: display },
          secretParams: { targetUrl: url },
          order: 1,
        },
      });
      const task = await privileged.manualTask.create({
        data: {
          migrationId,
          facetKey: 'webhooks',
          code: 'webhooks.recreate-manually',
          phase: 'post',
          origin: 'analysis',
          params: { key: 'k', targetUrlDisplay: display },
          secretParams: { targetUrl: url },
          verifiable: true,
          paramsHash: 'h-webhook-task',
          sourcePlanItemId: planItem.id,
        },
      });
      ids.planItem = planItem.id;
      ids.task = task.id;
    });

    it('[FAC-WEB-002] a viewer reads neither Snapshot data nor an Analysis translation', async () => {
      const snapshot = await clients.viewer.facetSnapshot.findUnique({
        where: { id: ids.snapshot },
      });
      expect(snapshot?.facetKey).toBe('webhooks');
      expect(snapshot?.data ?? null).toBeNull();
      const selected = await clients.viewer.facetSnapshot.findMany({
        where: { id: ids.snapshot },
        select: { data: true },
      });
      expect(selected.map((s) => s.data ?? null)).toEqual([null]);
      const analysis = await clients.viewer.analysis.findUnique({ where: { id: ids.analysis } });
      expect(analysis?.readiness).toBe('ready');
      expect(analysis?.translation ?? null).toBeNull();
      const nested = await clients.viewer.migration.findMany({
        select: { analyses: { where: { id: ids.analysis }, select: { translation: true } } },
      });
      expect(JSON.stringify(nested)).not.toContain(CREDENTIAL);
    });

    it('[FAC-WEB-002] a viewer cannot confirm the credential by filtering', async () => {
      expect(
        await clients.viewer.facetSnapshot.findMany({
          where: { data: { path: '$.hooks[0].url', equals: url } },
        }),
      ).toEqual([]);
      expect(
        await clients.viewer.facetSnapshot.findMany({
          where: {
            id: ids.snapshot,
            data: { path: '$.hooks[0].url', string_starts_with: url.slice(0, -2) },
          },
        }),
      ).toEqual([]);
      expect(
        await clients.viewer.analysis.findMany({
          where: {
            id: ids.analysis,
            translation: { path: TRANSLATED_URL, string_starts_with: url.slice(0, -2) },
          },
        }),
      ).toEqual([]);
    });

    it('[FAC-WEB-002] a viewer cannot order, group or aggregate by the denied JSON fields', async () => {
      const attempts: (() => Promise<unknown>)[] = [
        () => clients.viewer.facetSnapshot.findMany({ orderBy: { data: 'asc' } as never }),
        () => clients.viewer.facetSnapshot.groupBy({ by: ['data'] } as never),
        () => clients.viewer.analysis.groupBy({ by: ['translation'] } as never),
        () => clients.viewer.facetSnapshot.aggregate({ _max: { data: true } } as never),
      ];
      for (const attempt of attempts) {
        const outcome = await attempt().then(
          (value) => JSON.stringify(value),
          (error: unknown) => error,
        );
        if (typeof outcome === 'string') expect(outcome).not.toContain(CREDENTIAL);
        else expect(outcome).toBeInstanceOf(Error);
      }
    });

    it('[FAC-WEB-002] a viewer reads the guidance params of a webhook task but not its secret params', async () => {
      const task = await clients.viewer.manualTask.findUnique({ where: { id: ids.task } });
      expect(task?.params).toEqual({ key: 'k', targetUrlDisplay: 'https://ci.example.test/…' });
      expect(task?.secretParams ?? null).toBeNull();
      const item = await clients.viewer.planItem.findUnique({ where: { id: ids.planItem } });
      expect(item?.params).toMatchObject({ key: 'k' });
      expect(item?.secretParams ?? null).toBeNull();
      const nested = await clients.viewer.migration.findMany({
        select: {
          manualTasks: { select: { params: true, secretParams: true } },
          analyses: { select: { items: { select: { params: true, secretParams: true } } } },
        },
      });
      expect(JSON.stringify(nested)).not.toContain(CREDENTIAL);
      for (const model of ['manualTask', 'planItem'] as const) {
        const probe = await (clients.viewer[model] as unknown as AnyDelegate).findMany({
          where: { secretParams: { path: '$.targetUrl', string_starts_with: url.slice(0, -2) } },
        });
        expect(probe, model).toEqual([]);
      }
      for (const role of ['operator', 'admin'] as const) {
        const read = await clients[role].manualTask.findUnique({ where: { id: ids.task } });
        expect(read?.secretParams).toEqual({ targetUrl: url });
        const probe = await clients[role].planItem.findMany({
          where: { secretParams: { path: '$.targetUrl', string_starts_with: url.slice(0, -2) } },
        });
        expect(probe.map((p) => p.id)).toEqual([ids.planItem]);
      }
    });

    it('[FAC-WEB-002] operators and admins read the data the worker needs', async () => {
      for (const role of ['operator', 'admin'] as const) {
        const snapshot = await clients[role].facetSnapshot.findUnique({
          where: { id: ids.snapshot },
        });
        expect(JSON.stringify(snapshot?.data)).toContain(CREDENTIAL);
        const analysis = await clients[role].analysis.findUnique({ where: { id: ids.analysis } });
        expect(JSON.stringify(analysis?.translation)).toContain(CREDENTIAL);
        // The same filters a viewer is refused do match for these roles, so the viewer's empty
        // answers above come from the policy, not from a filter that never matches.
        const filtered = await clients[role].facetSnapshot.findMany({
          where: { data: { path: '$.hooks[0].url', equals: url } },
        });
        expect(filtered.map((s) => s.id)).toEqual([ids.snapshot]);
        const contains = await clients[role].analysis.findMany({
          where: {
            id: ids.analysis,
            translation: { path: TRANSLATED_URL, string_starts_with: url.slice(0, -2) },
          },
        });
        expect(contains.map((a) => a.id)).toEqual([ids.analysis]);
      }
    });
  });
});

describe('[DOM-012] Snapshots and Analyses are immutable once written', () => {
  for (const model of ['FacetSnapshot', 'Analysis', 'PlanItem']) {
    for (const role of ROLES) {
      it(`[DOM-012] ${role} cannot update or delete a ${model}`, async () => {
        const where = world.where[model] as Record<string, unknown>;
        await expectDenied(
          delegateOf(clients[role], model).update({ where, data: world.patch(model) }),
        );
        await expectDenied(delegateOf(clients[role], model).delete({ where }));
      });
    }
  }
});

describe('[AUTH-050] the link of an exclusion is written only by the privileged client', () => {
  for (const role of ['operator', 'admin'] as const) {
    it(`[AUTH-050] ${role} cannot update ExpectedDifference.identityMappingId`, async () => {
      const where = world.where.ExpectedDifference as { id: string };
      const before = (await row('ExpectedDifference', where)) as Record<string, unknown>;
      await expectDenied(
        clients[role].expectedDifference.update({
          where,
          data: { identityMappingId: (world.where.IdentityMapping as { id: string }).id } as never,
        }),
      );
      expect(await row('ExpectedDifference', where)).toEqual(before);
    });
  }
});
