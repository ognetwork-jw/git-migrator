import { assertSchemaCompatibility, DEFAULT_SCHEMA, runMigrations } from 'bullmq';
import pg from 'pg';

/** The PostgreSQL schema BullMQ lives in (JOB-010, ADR-0008). */
export const BULLMQ_SCHEMA = DEFAULT_SCHEMA;

/** Connections a process keeps for BullMQ queries beyond the one each Worker holds for `LISTEN`. */
export const QUERY_CONNECTIONS = 4;

/**
 * Size of the process-wide BullMQ pool (JOB-014). Every Worker checks one client out of the shared
 * pool for its blocking `LISTEN`, so the pool needs `workers` clients for those plus
 * `QUERY_CONNECTIONS` for the queries of Queues, Workers and the scheduler. The formula is recorded
 * in `docs/deployment.md`.
 */
export function bullmqPoolSize(workers: number): number {
  return workers + QUERY_CONNECTIONS;
}

export interface BullmqPoolOptions {
  readonly connectionString: string;
  readonly max: number;
  /** Shown in `pg_stat_activity`. */
  readonly applicationName?: string;
  /** Fail a checkout that waits longer than this (ms); producers such as web use it to fail fast. */
  readonly connectionTimeoutMillis?: number;
}

/**
 * The one `pg.Pool` of a process, shared by every Queue and Worker it creates (JOB-010, JOB-014).
 * Its connections run with `search_path = bullmq`, because BullMQ's SQL uses unqualified names and
 * a pre-built pool cannot carry a schema option.
 */
export function createBullmqPool(options: BullmqPoolOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max,
    application_name: options.applicationName ?? 'git-migrator-bullmq',
    ...(options.connectionTimeoutMillis === undefined
      ? {}
      : { connectionTimeoutMillis: options.connectionTimeoutMillis }),
    options: `-c search_path=${BULLMQ_SCHEMA}`,
  });
  // An idle client the server closed emits 'error'; without a listener that would crash the process.
  pool.on('error', () => undefined);
  // Every Queue and Worker adds an 'error' listener to the shared pool.
  pool.setMaxListeners(0);
  return pool;
}

/**
 * DATA-030 step 4: brings the `bullmq` schema to the version bundled with the installed BullMQ.
 * Idempotent, and serialized across processes by BullMQ's own advisory lock. Returns the schema
 * version after the call.
 */
export async function migrateBullmqSchema(connectionString: string): Promise<number> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${BULLMQ_SCHEMA}`);
    return await runMigrations(client, BULLMQ_SCHEMA);
  } finally {
    await client.end();
  }
}

/** Throws unless the schema is migrated and compatible. Workers call it before consuming. */
export async function assertBullmqSchemaReady(pool: pg.Pool): Promise<number> {
  return assertSchemaCompatibility(pool, BULLMQ_SCHEMA);
}
