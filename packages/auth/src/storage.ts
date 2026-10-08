import type { Logger } from '@git-migrator/observability';
import { getMigrations } from 'better-auth/db/migration';
import pg from 'pg';
import { betterAuthLogger } from './logger.ts';

/**
 * Better Auth's own pool (AUTH-001): every connection has `search_path=auth`, so the library's
 * unqualified table names resolve to schema `auth` and never touch `app`. ZenStack never models
 * these tables (DATA-002).
 */
export function createAuthPool(connectionString: string, max = 4): pg.Pool {
  const pool = new pg.Pool({ connectionString, max, options: '-c search_path=auth' });
  pool.on('error', () => undefined);
  return pool;
}

/**
 * DATA-030 step 3: creates or extends the Better Auth tables in schema `auth` (the programmatic
 * form of the Better Auth CLI `migrate`). Idempotent, and refuses (rejects) when the library
 * would have to add a required column to a populated table. Needs step 1 to have created the
 * schema. Better Auth's own output goes through `logger` (JSON, `component: auth`). Returns the names
 * of the tables it created.
 */
export async function migrateAuthSchema(
  connectionString: string,
  logger?: Logger,
): Promise<readonly string[]> {
  const pool = createAuthPool(connectionString, 1);
  try {
    const plan = await getMigrations({ database: pool, logger: betterAuthLogger(logger) });
    if (plan.schemaProblems.length > 0) {
      throw new Error(`Better Auth schema problems: ${plan.schemaProblems.join('; ')}`);
    }
    await plan.runMigrations();
    return plan.toBeCreated.map((t) => t.table);
  } finally {
    await pool.end();
  }
}
