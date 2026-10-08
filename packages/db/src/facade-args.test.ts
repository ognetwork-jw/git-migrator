import { ORMError, ORMErrorReason, TransactionIsolationLevel } from '@zenstackhq/orm';
import Decimal from 'decimal.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PolicyActor, PolicyDb } from './client.ts';
import { createTestDatabase, type TestDatabase } from './test-support.ts';
import { buildWorld, type World } from './test-world.ts';

/**
 * ADR-0200: the facade passes ZenStack a fresh plain-data clone of the arguments. These tests attack
 * the in-process holes of the former inspect-then-pass walk, on a top-level facade and on the facade
 * handed to a `$transaction` callback.
 */
let testDb: TestDatabase;
let world: World;
let viewer: PolicyDb;

beforeAll(async () => {
  testDb = await createTestDatabase('gm_t021a_');
  world = await buildWorld(testDb.db.privileged);
  viewer = testDb.db.forActor(world.actors.viewer as PolicyActor);
}, 120_000);

afterAll(async () => {
  await testDb?.drop();
});

type Find = (...args: unknown[]) => Promise<unknown[]>;
const find = (db: PolicyDb): Find => db.wave.findMany as unknown as Find;

/** A function that would be raw SQL beneath the policy plugin if ZenStack ever called it. */
const probe = () => {
  const calls = { n: 0 };
  const fn = (_eb: never): never => {
    calls.n++;
    throw new Error('the expression builder must never be reached');
  };
  return { fn, calls };
};

async function expectRefused(attempt: Promise<unknown>, pattern?: RegExp): Promise<void> {
  const error = await attempt.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, 'the call must be refused').toBeInstanceOf(ORMError);
  expect((error as ORMError).reason).toBe(ORMErrorReason.INVALID_INPUT);
  if (pattern) expect((error as ORMError).message).toMatch(pattern);
}

for (const mode of ['a top-level facade', 'a callback facade'] as const) {
  const run = <T>(body: (db: PolicyDb) => Promise<T>): Promise<T> =>
    mode === 'a callback facade' ? viewer.$transaction(body) : body(viewer);

  describe(`[AUTH-021] argument cloning on ${mode}`, () => {
    it('[AUTH-021] a Date, Decimal or Uint8Array carrying an own $expr is refused', async () => {
      const { fn, calls } = probe();
      await run(async (db) => {
        for (const leaf of [
          Object.assign(new Date(), { $expr: fn }),
          Object.assign(new Decimal('1'), { $expr: fn }),
          Object.assign(new Uint8Array([1]), { $expr: fn }),
          Object.assign(new Date(), { toISOString: fn }),
        ]) {
          await expectRefused(find(db)({ where: leaf }));
          await expectRefused(find(db)({ where: { createdAt: { lte: leaf } } }));
          await expectRefused(find(db)({ where: { NOT: [leaf] } }));
        }
      });
      expect(calls.n).toBe(0);
    });

    it('[AUTH-021] a forged prototype is refused', async () => {
      const { fn, calls } = probe();
      await run(async (db) => {
        for (const proto of [Date.prototype, Decimal.prototype, Uint8Array.prototype]) {
          const forged = Object.assign(Object.create(proto), { $expr: fn });
          await expectRefused(find(db)({ where: forged }));
          // Without the key too: the forged object is not a real Date, Decimal or Uint8Array.
          await expectRefused(find(db)({ where: Object.create(proto) }));
        }
        // A real Date whose prototype was swapped for a lookalike.
        const swapped = new Date();
        Object.setPrototypeOf(swapped, Object.create(Date.prototype));
        await expectRefused(find(db)({ where: { createdAt: swapped } }));
        // A class instance whose field carries the function.
        class Sneaky {
          $expr = fn;
        }
        await expectRefused(find(db)({ where: new Sneaky() }));
      });
      expect(calls.n).toBe(0);
    });

    it('[AUTH-021] a Proxy is refused, even one that lies during the walk', async () => {
      const { fn, calls } = probe();
      await run(async (db) => {
        let reads = 0;
        const lying = new Proxy(
          {},
          {
            ownKeys: () => (reads++ < 2 ? [] : ['$expr']),
            getOwnPropertyDescriptor: (_t, key) =>
              key === '$expr'
                ? { value: fn, enumerable: true, configurable: true, writable: true }
                : undefined,
            get: (_t, key) => (key === '$expr' ? fn : undefined),
            has: () => true,
          },
        );
        await expectRefused(find(db)({ where: lying }), /Proxy/);
        await expectRefused(find(db)({ where: { createdAt: new Proxy(new Date(), {}) } }), /Proxy/);
        await expectRefused(find(db)({ where: { AND: new Proxy([], {}) } }), /Proxy/);
        await expectRefused(find(db)(new Proxy({ where: {} }, {})), /Proxy/);
      });
      expect(calls.n).toBe(0);
    });

    it('[AUTH-021] changing the arguments after the call has no effect', async () => {
      const { fn, calls } = probe();
      await run(async (db) => {
        const name = world.createData('Wave').name as string;
        await testDb.db.privileged.wave.create({ data: { name } });
        const args: { where: Record<string, unknown>; take?: number } = { where: { name } };
        const pending = find(db)(args);
        // ZenStack reads its arguments lazily: these edits land between the call and the await.
        const original = args.where;
        args.where = { $expr: fn };
        args.take = 0;
        original.name = 'something else';
        const rows = (await pending) as Array<{ name: string }>;
        expect(rows.map((r) => r.name)).toEqual([name]);

        const when = new Date();
        const dated = find(db)({ where: { createdAt: { lte: when } } });
        when.setTime(0);
        expect(((await dated) as unknown[]).length).toBeGreaterThan(0);
      });
      expect(calls.n).toBe(0);
    });

    it('[AUTH-021] Date, Decimal and bytes still pass, as fresh values', async () => {
      await run(async (db) => {
        expect(
          ((await find(db)({ where: { createdAt: { lte: new Date() } } })) as unknown[]).length,
        ).toBeGreaterThan(0);
        for (const leaf of [new Decimal('1.5'), 10n, new Uint8Array([1, 2]), Buffer.from('ab')]) {
          const error = await find(db)({ where: { name: leaf } }).catch((e: unknown) => e);
          expect((error as Error).message ?? '').not.toMatch(/arguments may only hold/);
        }
      });
    });

    it('[AUTH-021] a __proto__ key is refused', async () => {
      await run(async (db) => {
        const body = JSON.parse('{"where":{"__proto__":{"$expr":1}}}');
        await expectRefused(find(db)(body), /__proto__/);
      });
    });
  });
}

describe('[AUTH-021] $transaction options', () => {
  it('[AUTH-021] only a known isolation level is accepted', async () => {
    const tx = viewer.$transaction as unknown as (a: unknown, o?: unknown) => Promise<unknown>;
    await expectRefused(
      tx(async () => 1, { isolationLevel: 'nonsense' }),
      /isolation level/,
    );
    await expectRefused(
      tx(async () => 1, { extra: true }),
      /unknown transaction option/,
    );
    await expectRefused(
      tx(async () => 1, []),
      /object/,
    );
    await expectRefused(
      tx(async () => 1, new Proxy({}, {})),
      /Proxy/,
    );
    await expect(
      tx(async () => 7, { isolationLevel: TransactionIsolationLevel.ReadCommitted }),
    ).resolves.toBe(7);
  });
});

describe('[AUTH-021] errors that are not ORM errors', () => {
  const dbLike = () =>
    Object.assign(new Error('insert into app.wave values ($1) -- s3cret-value'), {
      sql: 'insert into app.wave (name) values ($1)',
      sqlParams: ['s3cret-value'],
    });
  const thrownBy = (thrown: unknown): Promise<unknown> =>
    viewer
      .$transaction(async () => {
        throw thrown;
      })
      .catch((e: unknown) => e);

  it('[AUTH-021] a callback error carrying sql and parameters becomes a generic database error', async () => {
    const error = (await thrownBy(dbLike())) as ORMError;
    expect(error).toBeInstanceOf(ORMError);
    expect(error.reason).toBe(ORMErrorReason.DB_QUERY_ERROR);
    expect(error.message).toBe('database query failed');
    expect(JSON.stringify(error)).not.toContain('s3cret');
    expect(error.cause).toBeUndefined();
    expect((error as unknown as Record<string, unknown>).sql).toBeUndefined();
  });

  it('[AUTH-021] node-postgres fields and a cause chain are recognized, and only the SQLSTATE is kept', async () => {
    const pgLike = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
      detail: 'Key (name)=(s3cret-value) already exists.',
      constraint: 'wave_name_key',
    });
    const wrapped = new Error('request failed', { cause: new Error('outer', { cause: pgLike }) });
    for (const thrown of [pgLike, wrapped]) {
      const error = (await thrownBy(thrown)) as ORMError;
      expect(error).toBeInstanceOf(ORMError);
      expect(JSON.stringify(error)).not.toContain('s3cret');
      expect(error.message).toBe('database query failed');
    }
    expect(((await thrownBy(pgLike)) as ORMError).dbErrorCode).toBe('23505');
  });

  it('[AUTH-021] an ordinary error from a callback passes through unchanged', async () => {
    const own = new RangeError('plain failure');
    expect(await thrownBy(own)).toBe(own);
  });
});
