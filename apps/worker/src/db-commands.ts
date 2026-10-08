import { readFileSync } from 'node:fs';
import {
  createAuth,
  migrateAuthSchema,
  seedTestSignInUsers,
  type TestUserSeedResult,
} from '@git-migrator/auth';
import type { Config } from '@git-migrator/config';
import {
  applyAppMigrations,
  buildConnectionString,
  type ConfigSnapshot,
  createDb,
  ensureSchemas,
  hashConfig,
  type SeedResult,
  type SyncResult,
  seedDev,
  syncConfig,
} from '@git-migrator/db';
import { createLogger } from '@git-migrator/observability';
import pg from 'pg';

type Env = Readonly<Record<string, string | undefined>>;

/** Environments in which the destructive and seeding commands may run. */
const DEV_ENVIRONMENTS: readonly string[] = ['development', 'test', 'e2e'];

/**
 * True when `environment` was set by the operator (GM_ENVIRONMENT, or a top-level key in the config
 * file) rather than defaulted. A production file that lost its `environment` key would otherwise
 * read as 'development' (ADR-0051) and pass the guard.
 */
export function environmentIsExplicit(
  env: Env,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): boolean {
  if (env.GM_ENVIRONMENT !== undefined && env.GM_ENVIRONMENT !== '') return true;
  const file = env.GM_CONFIG_FILE;
  if (!file) return false;
  try {
    return /^environment\s*:/m.test(readFile(file));
  } catch {
    return false;
  }
}

function assertDevEnvironment(command: string, config: Config, env: Env): void {
  if (!DEV_ENVIRONMENTS.includes(config.environment) || !environmentIsExplicit(env)) {
    throw new Error(
      `${command} is for development, test and e2e only and needs the environment set explicitly ` +
        `(GM_ENVIRONMENT or \`environment:\` in the config file); it is "${config.environment}"`,
    );
  }
}

/** Connection string from config `postgres.*` and the `POSTGRES_PASSWORD` secret (DATA-010). */
export function connectionStringFor(config: Config, env: Env): string {
  return buildConnectionString({
    host: config.postgres.host,
    port: config.postgres.port,
    database: config.postgres.database,
    user: config.postgres.user,
    sslmode: config.postgres.sslmode,
    password: env.POSTGRES_PASSWORD ?? '',
  });
}

/**
 * Maps the configured Endpoints and Routes to what config sync stores (DATA-030 step 5). The
 * `configHash` covers the whole configured entry, so any change to it counts as a Route change
 * (LIF-021). Entries hold secret *names*, never secret values.
 */
export function toConfigSnapshot(config: Config): ConfigSnapshot {
  return {
    endpoints: config.endpoints.map((endpoint) => ({
      id: endpoint.id,
      providerType: endpoint.provider,
      displayName: endpoint.id,
      baseUrl: endpoint.baseUrl,
      configHash: hashConfig(endpoint),
    })),
    routes: config.routes.map((route) => ({
      id: route.id,
      sourceEndpointId: route.source,
      targetEndpointId: route.target,
      targetNamespacePath: route.targetNamespace,
      policies: route.policies,
      defaults: route.defaults,
      sourcePostAction: route.sourcePostAction,
      configHash: hashConfig(route),
    })),
  };
}

/**
 * The `migrate` entrypoint (DATA-030), in order. Each step is idempotent and the first failure
 * throws. Step 3 (Better Auth, AUTH-001) runs between steps 2 and 5. Step 4 (BullMQ) is added at
 * the same place by the task that owns that schema.
 */
export async function runMigrate(config: Config, env: Env): Promise<SyncResult> {
  const connectionString = connectionStringFor(config, env);
  const handle = createDb({ connectionString, poolMax: 2 });
  try {
    await ensureSchemas(handle.pool); // step 1
    await applyAppMigrations({ connectionString }); // step 2
    await migrateAuthSchema(
      connectionString,
      createLogger({ level: config.observability.logLevel }),
    ); // step 3
    return await syncConfig(handle.privileged, toConfigSnapshot(config)); // step 5
  } finally {
    await handle.close();
  }
}

/** The result of `pnpm db:seed`: the dev data, and the test sign-in users when AUTH-012 is on. */
export type SeedCommandResult = SeedResult & { readonly testSignInUsers?: TestUserSeedResult };

/**
 * `pnpm db:seed` (DATA-040). Refuses to run in production. When `auth.testSignIn.enabled` is true
 * it also creates the Better Auth users for the seeded test Actors, with the password from
 * `GM_TEST_USER_PASSWORD` (AUTH-012).
 */
export async function runSeed(config: Config, env: Env): Promise<SeedCommandResult> {
  assertDevEnvironment('db:seed', config, env);
  const connectionString = connectionStringFor(config, env);
  const handle = createDb({ connectionString, poolMax: 2 });
  try {
    const seeded = await seedDev(handle.privileged);
    if (!config.auth.testSignIn.enabled) return seeded;
    const service = createAuth({
      config,
      secrets: {
        authSecret: env.BETTER_AUTH_SECRET ?? '',
        entraClientId: env.ENTRA_CLIENT_ID ?? '',
        entraClientSecret: env.ENTRA_CLIENT_SECRET ?? '',
      },
      connectionString,
      db: handle.privileged,
      env,
    });
    try {
      const testSignInUsers = await seedTestSignInUsers(service, {
        config,
        env,
        password: env.GM_TEST_USER_PASSWORD ?? '',
      });
      return { ...seeded, testSignInUsers };
    } finally {
      await service.close();
    }
  } finally {
    await handle.close();
  }
}

/** `pnpm db:reset`: drops and recreates the configured database, then migrates. Not in production. */
export async function runReset(config: Config, env: Env): Promise<SyncResult> {
  assertDevEnvironment('db:reset', config, env);
  const name = config.postgres.database;
  const maintenance = new pg.Client({
    connectionString: connectionStringFor(
      { ...config, postgres: { ...config.postgres, database: 'postgres' } },
      env,
    ),
  });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${name.replaceAll('"', '""')}" WITH (FORCE)`);
    await maintenance.query(`CREATE DATABASE "${name.replaceAll('"', '""')}"`);
  } finally {
    await maintenance.end();
  }
  return runMigrate(config, env);
}
