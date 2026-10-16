import { describe, expect, it } from 'vitest';
import { type DropClient, dropDatabaseWith } from './test-support.ts';

function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** Answers each statement with the next scripted outcome and records what was sent. */
function scripted(outcomes: (Error | undefined)[]): DropClient & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    async query(sql: string) {
      sent.push(sql);
      const next = outcomes.shift();
      if (next) throw next;
      return {};
    },
  };
}

const denied = () => pgError('42501', 'permission denied to terminate process');
const inUse = () => pgError('55006', 'database "x" is being accessed by other users');
const noPause = async () => {};

describe('throw-away database teardown', () => {
  it('[TST-001] drops with FORCE when the role may terminate every session', async () => {
    const admin = scripted([undefined]);
    await dropDatabaseWith(admin, 'gm_test_a', noPause);
    expect(admin.sent).toEqual(['DROP DATABASE IF EXISTS "gm_test_a" WITH (FORCE)']);
  });

  it('[TST-001] falls back to a plain DROP when FORCE may not terminate a superuser session (autovacuum)', async () => {
    const admin = scripted([denied(), undefined]);
    await dropDatabaseWith(admin, 'gm_test_b', noPause);
    expect(admin.sent).toEqual([
      'DROP DATABASE IF EXISTS "gm_test_b" WITH (FORCE)',
      'DROP DATABASE IF EXISTS "gm_test_b"',
    ]);
  });

  it('[TST-001] retries while the database is still in use, then gives up with the error', async () => {
    const pauses: number[] = [];
    const recover = scripted([denied(), inUse(), denied(), inUse(), undefined]);
    await dropDatabaseWith(recover, 'gm_test_c', async (ms) => {
      pauses.push(ms);
    });
    expect(recover.sent).toHaveLength(5);
    expect(pauses).toEqual([500, 1000]);

    const stuck = scripted(Array.from({ length: 10 }, (_, i) => (i % 2 ? inUse() : denied())));
    await expect(dropDatabaseWith(stuck, 'gm_test_d', noPause)).rejects.toMatchObject({
      code: '55006',
    });
    expect(stuck.sent).toHaveLength(10);
  });

  it('[TST-001] rethrows any other error unchanged', async () => {
    const admin = scripted([pgError('3D000', 'other failure')]);
    await expect(dropDatabaseWith(admin, 'gm_test_e', noPause)).rejects.toThrow('other failure');
    const plain = scripted([denied(), pgError('42501', 'must be owner of database')]);
    await expect(dropDatabaseWith(plain, 'gm_test_f', noPause)).rejects.toThrow('must be owner');
  });

  it('[TST-001] quotes the database name', async () => {
    const admin = scripted([undefined]);
    await dropDatabaseWith(admin, 'odd"name', noPause);
    expect(admin.sent).toEqual(['DROP DATABASE IF EXISTS "odd""name" WITH (FORCE)']);
  });
});
