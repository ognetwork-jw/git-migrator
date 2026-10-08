import { parseBucketKey } from './bucket.ts';
import { databaseNow, inTransaction, lockKeys, type PgPool } from './db.ts';

/** Lifetime of one in-flight lease (JOB-045). */
export const LEASE_TTL_SECONDS = 60;

export interface LeaseOptions {
  readonly pool: PgPool;
  /** TEST SEAM ONLY. By default the database clock, read after the lock is held, decides expiry. */
  readonly now?: () => Date;
}

/**
 * Cross-pod concurrency cap (JOB-045): one `quota_lease` row per in-flight request, expiring after
 * 60 s, and the insert is refused when the unexpired count reaches the cap. The check and the
 * insert run under the bucket's advisory lock, so pods cannot jointly exceed the cap.
 */
export class QuotaLeases {
  readonly #pool: PgPool;
  readonly #clock: (() => Date) | undefined;

  constructor(options: LeaseOptions) {
    this.#pool = options.pool;
    this.#clock = options.now;
  }

  /** Returns the lease id, or undefined when `cap` leases are already held. */
  async acquire(bucketKey: string, holder: string, cap: number): Promise<bigint | undefined> {
    if (parseBucketKey(bucketKey) === undefined) {
      throw new Error(`Invalid bucket key: ${bucketKey}`);
    }
    if (!Number.isInteger(cap) || cap < 1) throw new Error(`Invalid cap: ${cap}`);
    return inTransaction(this.#pool, async (client) => {
      await lockKeys(client, [`lease:${bucketKey}`]);
      const now = await databaseNow(client, this.#clock);
      const expiresAt = new Date(now.getTime() + LEASE_TTL_SECONDS * 1000);
      const held = await client.query<{ n: string }>(
        'SELECT count(*) AS n FROM app.quota_lease WHERE bucket_key = $1 AND expires_at > $2',
        [bucketKey, now],
      );
      if (Number(held.rows[0]?.n ?? 0) >= cap) return undefined;
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO app.quota_lease (bucket_key, holder, expires_at, updated_at)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [bucketKey, holder, expiresAt, now],
      );
      const id = inserted.rows[0]?.id;
      return id === undefined ? undefined : BigInt(id);
    });
  }

  /** Releases a lease when its request finishes. Releasing an expired or unknown lease is a no-op. */
  async release(id: bigint): Promise<void> {
    await this.#pool.query('DELETE FROM app.quota_lease WHERE id = $1', [id.toString()]);
  }
}
