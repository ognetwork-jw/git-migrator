import type { DbHandle } from '@git-migrator/db';
import type { PoolClient } from 'pg';

/** The pool that `createDb` documents for advisory locks and the quota ledger (DATA-010). */
export type PgPool = DbHandle['pool'];
export type PgClient = PoolClient;

/** How long a transaction waits for a bucket's advisory lock before giving up. */
export const LOCK_TIMEOUT_MS = 10_000;

/** A bucket lock could not be taken in time. Retry later. */
export class QuotaLockTimeoutError extends Error {
  readonly retryable = true;
  constructor() {
    super('Timed out waiting for a quota bucket lock; retry later.');
    this.name = 'QuotaLockTimeoutError';
  }
}

/**
 * Runs `fn` in one transaction on its own connection; rolls back when `fn` throws. A lock wait
 * longer than `LOCK_TIMEOUT_MS` surfaces as `QuotaLockTimeoutError`. A connection whose rollback
 * failed is destroyed rather than returned to the pool.
 */
export async function inTransaction<T>(
  pool: PgPool,
  fn: (client: PgClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {
      broken = true;
    });
    if ((error as { code?: string }).code === '55P03') throw new QuotaLockTimeoutError();
    throw error;
  } finally {
    client.release(broken ? true : undefined);
  }
}

/**
 * Takes `pg_advisory_xact_lock(hash(key))` for each key, in ascending key order, so concurrent
 * transactions that need overlapping sets never deadlock (JOB-041). The locks are held until the
 * transaction ends. The hash is namespaced so other users of advisory locks cannot collide.
 */
export async function lockKeys(client: PgClient, keys: readonly string[]): Promise<void> {
  const sorted = [...new Set(keys)].sort();
  for (const key of sorted) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `gm-quota:${key}`,
    ]);
  }
}

/**
 * The time every window and event stamp is computed from. It is the database clock, read after
 * the lock is held, so pods with skewed clocks agree. `override` is a test seam only: production
 * code never passes it.
 */
export async function databaseNow(client: PgClient, override?: () => Date): Promise<Date> {
  if (override) return override();
  const result = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now');
  const now = result.rows[0]?.now;
  if (!now) throw new Error('Database clock unavailable');
  return now;
}
