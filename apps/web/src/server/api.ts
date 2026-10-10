import { type AppType, createApiApp, createEventHub, safeErrorFields } from '@git-migrator/api';
import { createAuth } from '@git-migrator/auth';
import { type Config, loadConfig } from '@git-migrator/config';
import {
  buildConnectionString,
  createDb,
  createEventListener,
  pgListenClient,
} from '@git-migrator/db';
import { JobRuntime } from '@git-migrator/jobs';
import { createLogger } from '@git-migrator/observability';
import { QuotaService } from '@git-migrator/quota';
import { createBuiltinRegistry } from '@git-migrator/registry';

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
  // One dedicated LISTEN connection for the whole process, fanned out to SSE clients (JOB-060).
  const events = createEventHub({
    listener: createEventListener({
      createClient: pgListenClient(db.pool),
      onProblem: (what) => logger.warn({ what }, 'event listener problem'),
    }),
    onSlowClient: () => logger.warn('dropped a slow event stream client'),
  });
  // Producer side of the job queues (the web process starts no Workers) and the shared services
  // of the batch 1 endpoints (ADR-0330).
  const jobs = new JobRuntime({
    connectionString,
    log: logger,
    workerCount: 0,
    applicationName: 'git-migrator-web',
    // An unreachable queue database fails a request in seconds (503), not at the HTTP timeout.
    connectionTimeoutMillis: 5_000,
  });
  const quota = new QuotaService({
    pool: db.pool,
    tuning: {
      safetyFactor: config.quota.safetyFactor,
      backgroundShare: config.quota.backgroundShare,
    },
  });
  const registry = createBuiltinRegistry();
  const app = createApiApp({
    db,
    auth,
    publicUrl: config.publicUrl,
    logger,
    events,
    services: { jobs, quota, registry },
  });
  return {
    app,
    config,
    close: () =>
      closeAll([() => events.close(), () => jobs.close(), () => auth.close(), () => db.close()]),
  };
}

/**
 * Runs every close step in order, even when one throws (a failed step must not leak the pools after
 * it), then rethrows the first error.
 */
export async function closeAll(steps: readonly (() => unknown)[]): Promise<void> {
  const errors: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw errors[0];
}

/**
 * The process-wide API runtime lives on `globalThis` under a registered symbol, not in a module
 * variable. In the image the `web` entrypoint (`src/web.ts`, run by Node from source) and the
 * Next.js server bundle each load their own copy of this module in the same process; the symbol
 * lets both share one runtime, so there is one database pool and one event hub, and the
 * entrypoint can close it on SIGTERM (DEP-002, ADR-0500).
 */
const RUNTIME_KEY = Symbol.for('git-migrator.web.api-runtime');
/**
 * Whether the runtime was handed in by the entrypoint (`provided`) or closed (`closed`). Only when
 * neither happened (`next dev`, tests) does `getApiRuntime` build one on first use.
 */
const STATE_KEY = Symbol.for('git-migrator.web.api-runtime-state');

type RuntimeHolder = {
  [RUNTIME_KEY]?: ApiRuntime;
  [STATE_KEY]?: 'provided' | 'closed';
};

const holder = globalThis as RuntimeHolder;

/** Thrown by `getApiRuntime` once the runtime is closed (shutdown) or was never provided. */
export class ApiRuntimeUnavailableError extends Error {
  constructor(state: 'provided' | 'closed') {
    super(
      state === 'closed'
        ? 'the API runtime is closed: the process is shutting down'
        : 'the API runtime provided by the entrypoint is gone',
    );
    this.name = 'ApiRuntimeUnavailableError';
  }
}

/**
 * The process-wide API runtime. Built on first use only when the entrypoint never provided one
 * (`next dev`); after `closeApiRuntime` it throws instead of opening new pools during shutdown.
 */
export function getApiRuntime(): ApiRuntime {
  const runtime = holder[RUNTIME_KEY];
  if (runtime) return runtime;
  const state = holder[STATE_KEY];
  if (state) throw new ApiRuntimeUnavailableError(state);
  const built = buildApiRuntime();
  holder[RUNTIME_KEY] = built;
  return built;
}

/** Makes `runtime` the process-wide API runtime that `getApiRuntime` returns. */
export function setApiRuntime(runtime: ApiRuntime): void {
  holder[RUNTIME_KEY] = runtime;
  holder[STATE_KEY] = 'provided';
}

/**
 * Closes the process-wide API runtime, if one was built, and marks it closed: later calls of
 * `getApiRuntime` throw and never build a new one.
 */
export async function closeApiRuntime(): Promise<void> {
  const runtime = holder[RUNTIME_KEY];
  delete holder[RUNTIME_KEY];
  holder[STATE_KEY] = 'closed';
  await runtime?.close();
}
