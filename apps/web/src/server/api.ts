import { type AppType, createApiApp, safeErrorFields } from '@git-migrator/api';
import { createAuth } from '@git-migrator/auth';
import { type Config, loadConfig } from '@git-migrator/config';
import { buildConnectionString, createDb } from '@git-migrator/db';
import { createLogger } from '@git-migrator/observability';

type Env = Readonly<Record<string, string | undefined>>;

export interface ApiRuntime {
  readonly app: AppType;
  readonly config: Config;
  close(): Promise<void>;
}

/**
 * The composition root of the web process's API (API-001): loads the configuration, opens the
 * database pool and Better Auth, and builds the Hono app. Secrets come from the environment
 * (secretspec injects them), never from the configuration file.
 */
export function buildApiRuntime(env: Env = process.env): ApiRuntime {
  const config = loadConfig({ env });
  const connectionString = buildConnectionString({
    host: config.postgres.host,
    port: config.postgres.port,
    database: config.postgres.database,
    user: config.postgres.user,
    sslmode: config.postgres.sslmode,
    password: env.POSTGRES_PASSWORD ?? '',
  });
  const logger = createLogger({ level: config.observability.logLevel, service: 'web' });
  const db = createDb({
    connectionString,
    poolMax: config.postgres.pool.app,
    // Failed database calls of the RPC mount are logged as class, reason, model and SQLSTATE only.
    onError: (error) => logger.error(safeErrorFields(error), 'database call failed'),
  });
  const auth = createAuth({
    config,
    secrets: {
      authSecret: env.BETTER_AUTH_SECRET ?? '',
      entraClientId: env.ENTRA_CLIENT_ID ?? '',
      entraClientSecret: env.ENTRA_CLIENT_SECRET ?? '',
    },
    connectionString,
    db: db.privileged,
    env,
    logger,
  });
  const app = createApiApp({ db, auth, publicUrl: config.publicUrl, logger });
  return {
    app,
    config,
    close: async () => {
      await auth.close();
      await db.close();
    },
  };
}

let runtime: ApiRuntime | undefined;

/** The process-wide API runtime, built on first use. */
export function getApiRuntime(): ApiRuntime {
  runtime ??= buildApiRuntime();
  return runtime;
}
