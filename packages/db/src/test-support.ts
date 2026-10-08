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
  const admin = new pg.Client({ connectionString: adminDatabaseUrl() });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}
