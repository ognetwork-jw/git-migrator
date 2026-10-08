import { type Config, loadConfigOrExit } from '@git-migrator/config';
import { createDb } from '@git-migrator/db';
import {
  createEndpointConnector,
  createProviderEnvironment,
  HEALTH_PORT,
  type HealthServer,
  inventoryHandlers,
  type JobHandlers,
  JobRuntime,
  LeaderElection,
  maintenanceHandlers,
  noGitClient,
  type QueueName,
  queuesForRole,
  resetQueueCounts,
  SchedulerManager,
  ScratchCleaner,
  scratchRoot,
  startHealthServer,
  startQueueMetrics,
  WORKER_ROLES,
  type WorkerRole,
} from '@git-migrator/jobs';
import {
  createLogger,
  createMetrics,
  type Logger,
  type MetricsServer,
  startMetricsServer,
  startTracing,
  type TracingHandle,
} from '@git-migrator/observability';
import { QuotaLeases, QuotaService } from '@git-migrator/quota';
import { createBuiltinRegistry } from '@git-migrator/registry';
import { connectionStringFor } from './db-commands.ts';
import { type WaitForDatabaseOptions, waitForDatabase } from './wait-for-database.ts';

type Env = Readonly<Record<string, string | undefined>>;

export interface StartWorkerOptions {
  readonly config: Config;
  readonly env: Env;
  readonly role: WorkerRole;
  readonly log?: Logger;
  /** Port of the health server. Default 8081 (DEP-031); 0 picks a free one. */
  readonly healthPort?: number;
  /** Port of the metrics server. Default `config.metrics.port`; `false` starts none. */
  readonly metricsPort?: number | false;
  /** How often followers retry the leader lock. Default 5 s. */
  readonly leaderIntervalMs?: number;
  /** Lock name override for tests that run several elections side by side. */
  readonly leaderLockName?: string;
  readonly tracing?: TracingHandle;
  /** Aborts start-up (SIGTERM): what has started is closed and `startWorker` rejects. */
  readonly signal?: AbortSignal;
  /** Extra or replacement job handlers, merged over the maintenance handlers (tests, later tasks). */
  readonly handlers?: JobHandlers;
  /** Bounds of the wait for the database and its schemas (cold start). */
  readonly databaseWait?: Partial<Omit<WaitForDatabaseOptions, 'connectionString' | 'log'>>;
}

export interface WorkerHandle {
  readonly role: WorkerRole;
  readonly queues: readonly QueueName[];
  readonly runtime: JobRuntime;
  /** What adapters receive from the host: quota and lease gates, raw capture, telemetry (ADP-060). */
  readonly providerEnvironment: ReturnType<typeof createProviderEnvironment>;
  readonly healthPort: number;
  readonly leader: LeaderElection | undefined;
  /** Graceful stop (DEP-010): stop taking jobs, finish in-flight jobs, release the lease and locks. */
  stop(): Promise<void>;
}

/** Reads `--role <value>` from argv; defaults to `all`, as the devenv and Compose commands pass it. */
export function parseRole(argv: readonly string[]): WorkerRole {
  const index = argv.indexOf('--role');
  const value = index === -1 ? 'all' : argv[index + 1];
  if (!WORKER_ROLES.includes(value as WorkerRole)) {
    throw new Error(`--role must be one of ${WORKER_ROLES.join(', ')}`);
  }
  return value as WorkerRole;
}

/**
 * Starts a worker process's runtime (ARC-020, DEP-002): the queue workers of its role, the health
 * server, the pod-local scratch cleaner, the metrics server, and, for roles that consume the
 * standard queues, the scheduler leader election (ARC-023). Resolves once the workers are ready.
 */
export async function startWorker(options: StartWorkerOptions): Promise<WorkerHandle> {
  const { config, env, role } = options;
  const log =
    options.log ?? createLogger({ level: config.observability.logLevel, service: 'worker' });
  const connectionString = connectionStringFor(config, env);
  const queues = queuesForRole(role);

  // Everything started so far, closed in a fixed order by `stop` (DEP-030): readiness goes down
  // first, the health server answers until the very end, and the pools close last.
  let ready = false;
  let leader: LeaderElection | undefined;
  let cleaner: ScratchCleaner | undefined;
  let runtime: JobRuntime | undefined;
  let health: HealthServer | undefined;
  let metricsServer: MetricsServer | undefined;
  let db: ReturnType<typeof createDb> | undefined;
  // `stop` closes whatever has started so far and forgets it, so it can run again if start-up
  // continues for a moment after an abort. Calls are chained, never concurrent.
  let stopping: Promise<void> = Promise.resolve();
  const takeAndClose = async <T>(
    take: () => T | undefined,
    clear: () => void,
    close: (value: T) => Promise<unknown> | unknown,
  ): Promise<void> => {
    const value = take();
    clear();
    if (value === undefined) return;
    try {
      await close(value);
    } catch (error) {
      log.error({ err: error }, 'worker shutdown step failed');
    }
  };
  const stop = (): Promise<void> => {
    stopping = stopping.then(async () => {
      ready = false;
      await takeAndClose(
        () => leader,
        () => {
          leader = undefined;
        },
        (value) => value.stop(),
      );
      await takeAndClose(
        () => cleaner,
        () => {
          cleaner = undefined;
        },
        (value) => value.stop(),
      );
      await takeAndClose(
        () => runtime,
        () => {
          runtime = undefined;
        },
        (value) => value.close(),
      );
      await takeAndClose(
        () => health,
        () => {
          health = undefined;
        },
        (value) => value.close(),
      );
      await takeAndClose(
        () => metricsServer,
        () => {
          metricsServer = undefined;
        },
        (value) => value.close(),
      );
      await takeAndClose(
        () => db,
        () => {
          db = undefined;
        },
        (value) => value.close(),
      );
      await options.tracing?.shutdown().catch(() => undefined);
    });
    return stopping;
  };
  // Start-up is abortable: SIGTERM before the workers run still closes what has started.
  const checkpoint = (): void => options.signal?.throwIfAborted();
  options.signal?.addEventListener('abort', () => void stop(), { once: true });

  try {
    // Liveness and readiness answer from the start: /readyz is 503 while the database is not
    // ready (cold start) and 200 once the queue Workers run.
    health = await startHealthServer({
      port: options.healthPort ?? HEALTH_PORT,
      ready: () => ready,
    });
    await waitForDatabase({
      connectionString,
      log,
      // A development loop waits for ever (logging every 30 s); elsewhere the wait is bounded.
      indefinite: env.NODE_ENV === 'development',
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.databaseWait ?? {}),
    });
    checkpoint();

    db = createDb({ connectionString, poolMax: config.postgres.pool.app });
    const { registry: metricsRegistry, recorders } = createMetrics();
    const metricsPort = options.metricsPort ?? config.metrics.port;
    if (metricsPort !== false) {
      metricsServer = await startMetricsServer({ registry: metricsRegistry, port: metricsPort });
    }
    // `maintenance.prune` calls QuotaService.prune(); MetricRecorders is the metrics sink (JOB-046).
    const quota = new QuotaService({
      pool: db.pool,
      tuning: {
        safetyFactor: config.quota.safetyFactor,
        backgroundShare: config.quota.backgroundShare,
      },
      metrics: recorders,
    });
    const providerEnvironment = createProviderEnvironment({
      quota,
      leases: new QuotaLeases({ pool: db.pool }),
      db: db.privileged,
      recorders,
      logger: log,
      environment: config.environment,
    });
    const jobs = new JobRuntime({
      connectionString,
      log,
      workerCount: queues.length,
      applicationName: `git-migrator-${role}`,
    });
    runtime = jobs;
    await jobs.waitUntilReady();
    checkpoint();

    const registry = createBuiltinRegistry();
    const handlers = {
      ...maintenanceHandlers({
        appPool: db.pool,
        quota,
        runtime: jobs,
        log,
        scratchRoot: scratchRoot(env),
        metrics: recorders,
      }),
      // Adapters are reached only through the registry (ARC-012); inventory uses no git transport.
      ...inventoryHandlers({
        db: db.privileged,
        appPool: db.pool,
        connector: createEndpointConnector({
          config,
          registry,
          env,
          environment: providerEnvironment,
          git: noGitClient,
        }),
        registry,
        config,
        log,
      }),
      ...(options.handlers ?? {}),
    };
    await jobs.startWorkers(role, config, handlers);
    checkpoint();
    ready = true;

    // Scratch is pod-local, so every pod cleans its own (JOB-015, JOB-050).
    cleaner = new ScratchCleaner({
      root: scratchRoot(env),
      cron: config.schedules.scratchCleanup,
      log,
    });
    await cleaner.start();

    if (role !== 'large') {
      const appPool = db.pool;
      const scheduler = new SchedulerManager({ runtime: jobs, appPool, config, log });
      let queueMetrics: { stop(): void } | undefined;
      leader = new LeaderElection({
        connectionString,
        log,
        ...(options.leaderIntervalMs ? { intervalMs: options.leaderIntervalMs } : {}),
        ...(options.leaderLockName ? { lockName: options.leaderLockName } : {}),
        onElected: async () => {
          await scheduler.start();
          queueMetrics = startQueueMetrics({ runtime: jobs, sink: recorders, log });
        },
        onLost: () => {
          scheduler.stop();
          queueMetrics?.stop();
          // Only the leader refreshes the gauges; a former leader must not leave stale values.
          resetQueueCounts(recorders);
        },
      });
      await leader.start();
    }

    checkpoint();
    log.info({ role, queues }, 'worker started');
    return {
      role,
      queues,
      runtime: jobs,
      providerEnvironment,
      healthPort: health.port,
      leader,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

export interface WorkerProcessOptions {
  /** Starts the worker; the signal aborts start-up on SIGTERM. */
  start(signal: AbortSignal): Promise<Pick<WorkerHandle, 'stop'>>;
  /** Registers the shutdown listener for SIGTERM and SIGINT. */
  onShutdownSignal(listener: () => void): void;
  exit(code: number): void;
  log: Logger;
  /** Flushes telemetry before an exit that `stop()` did not cover. */
  flush?(): Promise<void>;
  /**
   * How long a SIGTERM during start-up may take before the process exits with 1, for a stage that
   * cannot be interrupted. Default 30 s. It applies only until start-up settles (ADR-0213).
   */
  readonly startupExitMs?: number;
}

/** A SIGTERM during start-up exits after this long at most (ADR-0213). */
export const STARTUP_EXIT_MS = 30_000;

/**
 * The process life cycle around `startWorker` (DEP-030). SIGTERM during start-up aborts it and,
 * if a stage cannot be interrupted, exits after `startupExitMs`. SIGTERM after start-up drains:
 * in-flight jobs finish their current step however long it takes, and the process exits 0 when the
 * drain ends. There is no timer then: the pod's `terminationGracePeriodSeconds` (120 s standard,
 * 600 s large) is the only bound, so a long step is never cut short by the process itself.
 */
export async function runWorkerProcess(options: WorkerProcessOptions): Promise<void> {
  const starting = new AbortController();
  let handle: Pick<WorkerHandle, 'stop'> | undefined;
  let startupExit: NodeJS.Timeout | undefined;
  let shuttingDown = false;
  const drain = (worker: Pick<WorkerHandle, 'stop'>): void => {
    worker.stop().then(
      () => options.exit(0),
      (error: unknown) => {
        options.log.error({ err: error }, 'worker shutdown failed');
        options.exit(1);
      },
    );
  };
  options.onShutdownSignal(() => {
    if (shuttingDown) return; // a second signal changes nothing
    shuttingDown = true;
    starting.abort();
    if (handle) {
      drain(handle);
      return;
    }
    startupExit = setTimeout(() => options.exit(1), options.startupExitMs ?? STARTUP_EXIT_MS);
    startupExit.unref();
  });
  try {
    handle = await options.start(starting.signal);
  } catch (error) {
    clearTimeout(startupExit);
    if (!starting.signal.aborted) {
      // One structured line, no stack: a cold or unmigrated database is an operator problem.
      options.log.error({ err: error }, 'worker failed to start');
    }
    await options.flush?.().catch(() => undefined);
    options.exit(starting.signal.aborted ? 0 : 1);
    return;
  }
  // Start-up settled: from now on only the drain decides when the process ends.
  clearTimeout(startupExit);
  if (starting.signal.aborted) drain(handle);
}

/** Process entry: `worker --role <standard|large|all>` (DEP-002). */
export async function main(): Promise<void> {
  const role = parseRole(process.argv.slice(2));
  const config = loadConfigOrExit();
  const log = createLogger({ level: config.observability.logLevel, service: 'worker' });
  const tracing = startTracing({
    serviceName: config.observability.serviceName,
    otlpEndpoint: config.observability.otlpEndpoint,
  });
  await runWorkerProcess({
    start: (signal) => startWorker({ config, env: process.env, role, log, tracing, signal }),
    onShutdownSignal: (listener) => {
      process.on('SIGTERM', listener);
      process.on('SIGINT', listener);
    },
    exit: (code) => process.exit(code),
    log,
    flush: () => tracing.shutdown(),
  });
}

if (import.meta.main) await main();
