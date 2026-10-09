import type { Config } from '@git-migrator/config';
import type { Logger } from '@git-migrator/observability';
import {
  createPostgresBackend,
  type Job,
  type JobsOptions,
  Queue,
  setDefaultBackendFactory,
  type Telemetry,
  UnrecoverableError,
  WaitingError,
  Worker,
} from 'bullmq';
import type pg from 'pg';
import { assertBullmqSchemaReady, bullmqPoolSize, createBullmqPool } from './connection.ts';
import { InvalidPayloadError, isJobName, type JobPayloads, parsePayload } from './payloads.ts';
import {
  type AnalysisPriority,
  analysisQueue,
  attemptsFor,
  concurrencyFor,
  defaultJobOptions,
  type JobName,
  QUEUE_DEFINITIONS,
  QUEUE_NAMES,
  type QueueName,
  queuesForRole,
  type RunRouting,
  runQueue,
  type WorkerRole,
} from './queues.ts';
import { createBullmqTelemetry } from './telemetry.ts';

const RUN_QUEUES = ['runs-standard', 'runs-large'] as const satisfies readonly QueueName[];

/** Job states in which a job will still run or is running. */
const PENDING_JOB_STATES: ReadonlySet<string> = new Set([
  'waiting',
  'delayed',
  'prioritized',
  'active',
  'waiting-children',
]);

/** What a handler receives besides the validated payload. */
export interface JobContext {
  readonly job: Job;
  readonly queue: QueueName;
  readonly log: Logger;
  /**
   * Aborted when the process starts shutting down (SIGTERM): finish the current step and stop.
   * Check `.aborted` as well as listening for the event: a handler that starts after the abort
   * never sees it (the runtime gives such jobs back before calling a handler, but a long handler
   * may reach its check later).
   */
  readonly shutdown: AbortSignal;
}

export type JobHandler<N extends JobName> = (
  payload: JobPayloads[N],
  context: JobContext,
) => Promise<unknown>;

/** The handlers a process registers. A job without a handler fails without retry. */
export type JobHandlers = { readonly [N in JobName]?: JobHandler<N> };

export interface JobRuntimeOptions {
  readonly connectionString: string;
  readonly log: Logger;
  /** Number of Workers this process starts (see `queuesForRole`); producers such as web pass 0. */
  readonly workerCount: number;
  /** Defaults to `createBullmqTelemetry()`. Pass `false` to turn tracing of jobs off. */
  readonly telemetry?: Telemetry | false;
  readonly applicationName?: string;
  /** Pool checkout timeout in ms; producers pass a short one so an outage fails fast. */
  readonly connectionTimeoutMillis?: number;
}

export interface EnqueueOptions {
  /** BullMQ `deduplication.id` (JOB-011), for example `analysis-<migrationId>`. */
  readonly dedupeId?: string;
  readonly delayMs?: number;
  readonly priority?: number;
}

/**
 * The process-wide job runtime (JOB-010, JOB-014): one `pg.Pool` with `search_path = bullmq` shared
 * by every Queue and Worker, BullMQ's PostgreSQL backend registered as the default, one Queue per
 * queue name, and tracing on every one of them.
 */
export class JobRuntime {
  readonly pool: pg.Pool;
  readonly #queues = new Map<QueueName, Queue>();
  readonly #workers = new Map<QueueName, Worker>();
  readonly #log: Logger;
  readonly #telemetry: Telemetry | undefined;
  readonly #shutdown = new AbortController();
  readonly #workerCount: number;
  #closing: Promise<void> | undefined;

  constructor(options: JobRuntimeOptions) {
    setDefaultBackendFactory(createPostgresBackend);
    this.#log = options.log;
    this.#workerCount = options.workerCount;
    this.#telemetry =
      options.telemetry === false ? undefined : (options.telemetry ?? createBullmqTelemetry());
    this.pool = createBullmqPool({
      connectionString: options.connectionString,
      max: bullmqPoolSize(options.workerCount),
      ...(options.applicationName ? { applicationName: options.applicationName } : {}),
      ...(options.connectionTimeoutMillis === undefined
        ? {}
        : { connectionTimeoutMillis: options.connectionTimeoutMillis }),
    });
    for (const name of QUEUE_NAMES) {
      const queue = new Queue(name, {
        connection: this.pool,
        defaultJobOptions: defaultJobOptions(name),
        ...(this.#telemetry ? { telemetry: this.#telemetry } : {}),
      });
      queue.on('error', (error) => this.#log.error({ err: error, queue: name }, 'queue error'));
      this.#queues.set(name, queue);
    }
  }

  /** Resolves when the `bullmq` schema is migrated and compatible, or rejects. */
  async waitUntilReady(): Promise<void> {
    await assertBullmqSchemaReady(this.pool);
    await Promise.all([...this.#queues.values()].map((queue) => queue.waitUntilReady()));
  }

  queue(name: QueueName): Queue {
    const queue = this.#queues.get(name);
    if (!queue) throw new Error(`Unknown queue ${name}`);
    return queue;
  }

  /** Aborted at the start of shutdown. */
  get shutdownSignal(): AbortSignal {
    return this.#shutdown.signal;
  }

  /**
   * Validates `payload` (JOB-011) and adds the job to `queue`. Throws `InvalidPayloadError` for a
   * bad payload and an `Error` when `queue` does not carry `name`.
   */
  async enqueue<N extends JobName>(
    queue: QueueName,
    name: N,
    payload: JobPayloads[N],
    options: EnqueueOptions = {},
  ): Promise<Job> {
    if (!(QUEUE_DEFINITIONS[queue].jobs as readonly string[]).includes(name)) {
      throw new Error(`Queue ${queue} does not carry ${name}`);
    }
    const data = parsePayload(name, payload);
    const jobOptions: JobsOptions = {
      attempts: attemptsFor(name),
      ...(options.dedupeId ? { deduplication: { id: options.dedupeId } } : {}),
      ...(options.delayMs !== undefined ? { delay: options.delayMs } : {}),
      ...(options.priority !== undefined ? { priority: options.priority } : {}),
    };
    return this.queue(queue).add(name, data, jobOptions);
  }

  /** `analysis.migration` on the interactive or background queue (JOB-020), deduplicated per Migration. */
  enqueueAnalysis(
    migrationId: string,
    priority: AnalysisPriority,
    options: EnqueueOptions = {},
  ): Promise<Job> {
    return this.enqueue(
      analysisQueue(priority),
      'analysis.migration',
      { migrationId },
      { dedupeId: `analysis-${migrationId}`, ...options },
    );
  }

  /** `run.execute` on the queue the Run's size class and kind select (JOB-010). */
  enqueueRun(runId: string, routing: RunRouting, options: EnqueueOptions = {}): Promise<Job> {
    return this.enqueue(
      runQueue(routing),
      'run.execute',
      { runId },
      { dedupeId: `run-${runId}`, ...options },
    );
  }

  /**
   * Whether the `run.execute` job enqueued under `dedupeId` still exists and can still run, on
   * either Run queue (the size class may have changed since). The reaper asks this before it
   * keeps waiting for a pending resume or hand-off (LIF-046, ADR-0212).
   */
  async isRunJobPending(dedupeId: string): Promise<boolean> {
    for (const name of RUN_QUEUES) {
      const queue = this.queue(name);
      const jobId = await queue.getDeduplicationJobId(dedupeId);
      if (!jobId) continue;
      if (PENDING_JOB_STATES.has(await queue.getJobState(jobId))) return true;
    }
    return false;
  }

  /**
   * Starts one Worker per queue the `role` consumes, with the concurrency from config (JOB-012).
   * Resolves when every Worker is ready to take jobs (`/readyz`, DEP-031).
   */
  async startWorkers(role: WorkerRole, config: Config, handlers: JobHandlers): Promise<void> {
    const wanted = queuesForRole(role).filter((name) => !this.#workers.has(name));
    // Every Worker holds one pool client for its blocking LISTEN; a smaller pool would leave
    // the query connections starved and the Workers waiting for ever (JOB-014).
    if (this.#workers.size + wanted.length > this.#workerCount) {
      throw new Error(
        `The BullMQ pool was sized for ${this.#workerCount} Workers, but ${
          this.#workers.size + wanted.length
        } are starting`,
      );
    }
    for (const name of wanted) {
      const worker = new Worker(name, (job, token) => this.processJob(name, job, handlers, token), {
        connection: this.pool,
        concurrency: concurrencyFor(name, config),
        // A stalled Run job is never re-queued by BullMQ: the reaper is the only resume path, so
        // one Run cannot be picked up twice (LIF-046, ADR-0212).
        ...(name === 'runs-standard' || name === 'runs-large' ? { maxStalledCount: 0 } : {}),
        ...(this.#telemetry ? { telemetry: this.#telemetry } : {}),
      });
      worker.on('error', (error) => this.#log.error({ err: error, queue: name }, 'worker error'));
      worker.on('failed', (job, error) =>
        this.#log.warn(
          { err: error, queue: name, job: job?.name, jobId: job?.id, attempt: job?.attemptsMade },
          'job failed',
        ),
      );
      this.#workers.set(name, worker);
    }
    await Promise.all([...this.#workers.values()].map((worker) => worker.waitUntilReady()));
  }

  /** The Worker for `name`, if this process started it. */
  worker(name: QueueName): Worker | undefined {
    return this.#workers.get(name);
  }

  get workerQueues(): readonly QueueName[] {
    return [...this.#workers.keys()];
  }

  /**
   * The processor of every Worker this runtime starts: gives the job back during shutdown, checks
   * the queue and payload, and calls the handler. Public only so tests can drive the shutdown race
   * deterministically; production code never calls it.
   *
   * @internal
   */
  async processJob(
    queue: QueueName,
    job: Job,
    handlers: JobHandlers,
    token?: string,
  ): Promise<unknown> {
    // BullMQ's close() wakes a blocked Worker, which can still activate one waiting job before it
    // notices it is closing. Give such a job back untouched, neither run nor failed (DEP-030).
    if (this.#shutdown.signal.aborted) {
      await job.moveToWait(token);
      throw new WaitingError();
    }
    const name = job.name;
    if (!isJobName(name) || !(QUEUE_DEFINITIONS[queue].jobs as readonly string[]).includes(name)) {
      throw new UnrecoverableError(`Queue ${queue} does not carry ${name}`);
    }
    const handler = handlers[name] as JobHandler<JobName> | undefined;
    if (!handler) throw new UnrecoverableError(`No processor registered for ${name}`);
    let payload: JobPayloads[JobName];
    try {
      payload = parsePayload(name, job.data);
    } catch (error) {
      if (error instanceof InvalidPayloadError) throw new UnrecoverableError(error.message);
      throw error;
    }
    const log = this.#log.child({ component: 'jobs', queue, job: name, jobId: job.id });
    return handler(payload, { job, queue, log, shutdown: this.#shutdown.signal });
  }

  /**
   * Graceful shutdown (DEP-010): stops taking new jobs, lets in-flight jobs finish, then closes
   * the Queues and the pool. Safe to call more than once.
   */
  close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    this.#shutdown.abort();
    await Promise.all([...this.#workers.values()].map((worker) => worker.close()));
    await Promise.all([...this.#queues.values()].map((queue) => queue.close()));
    await this.pool.end();
  }
}
