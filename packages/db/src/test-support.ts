import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createDb, type DbHandle } from './client.ts';
import { applyAppMigrations, ensureSchemas } from './migrate.ts';

/**
 * Connection used to create and drop throw-away databases. Override with `GM_TEST_DATABASE_URL`.
 * The default matches the role that devenv and Compose create (DEV-010, DEV-020).
 */
export function adminDatabaseUrl(): string {
  return (
    process.env.GM_TEST_DATABASE_URL ??
    'postgresql://git_migrator:git_migrator@127.0.0.1:5432/postgres'
  );
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

export interface TestDatabase {
  readonly name: string;
  readonly connectionString: string;
  readonly db: DbHandle;
  /** Closes the pool and drops the database. */
  drop(): Promise<void>;
}

/**
 * Creates a uniquely named database, runs DATA-030 steps 1 and 2 against it, and returns a client.
 * Always call `drop()` (for example in `afterAll`). Never point it at a shared database.
 */
export async function createTestDatabase(prefix = 'gm_test_'): Promise<TestDatabase> {
  const name = `${prefix}${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminDatabaseUrl() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  const connectionString = withDatabase(adminDatabaseUrl(), name);
  const db = createDb({ connectionString, poolMax: 4 });
  try {
    await ensureSchemas(db.pool);
    await applyAppMigrations({ connectionString, output: 'pipe' });
  } catch (error) {
    await dropDatabase(db, name);
    throw error;
  }
  return { name, connectionString, db, drop: () => dropDatabase(db, name) };
}

async function dropDatabase(db: DbHandle, name: string): Promise<void> {
  await db.close();
  await dropDatabaseNamed(name);
}

/** Drops a throw-away database by name over a fresh admin connection (see {@link dropDatabaseWith}). */
export async function dropDatabaseNamed(name: string): Promise<void> {
  const admin = new pg.Client({ connectionString: adminDatabaseUrl() });
  await admin.connect();
  try {
    await dropDatabaseWith(admin, name);
  } finally {
    await admin.end();
  }
}

/** The part of a `pg` client that {@link dropDatabaseWith} needs. */
export interface DropClient {
  query(sql: string): Promise<unknown>;
}

const INSUFFICIENT_PRIVILEGE = '42501';
const OBJECT_IN_USE = '55006';
const DROP_ATTEMPTS = 5;

function sqlState(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Drops `name`, tolerating sessions the test role may not terminate.
 *
 * `WITH (FORCE)` terminates every other session on the database first, and fails with
 * "permission denied to terminate process" (42501) when one of them belongs to a superuser. An
 * autovacuum worker runs as the bootstrap superuser, so a non-superuser test role hits this whenever
 * autovacuum happens to visit the fresh database, which is likely under load. A plain `DROP DATABASE`
 * cancels autovacuum workers itself and waits a few seconds for other sessions, so it is the fallback;
 * a database still in use (55006) is retried after a pause.
 */
export async function dropDatabaseWith(
  admin: DropClient,
  name: string,
  pause: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
  const quoted = `"${name.replaceAll('"', '""')}"`;
  for (let attempt = 1; ; attempt++) {
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${quoted} WITH (FORCE)`);
      return;
    } catch (error) {
      if (sqlState(error) !== INSUFFICIENT_PRIVILEGE) throw error;
    }
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${quoted}`);
      return;
    } catch (error) {
      if (sqlState(error) !== OBJECT_IN_USE || attempt >= DROP_ATTEMPTS) throw error;
    }
    await pause(attempt * 500);
  }
}
