import type { Config } from '@git-migrator/config';
import type { Logger } from '@git-migrator/observability';
import type pg from 'pg';
import type { JobPayloads } from './payloads.ts';
import type { JobName, QueueName } from './queues.ts';
import type { JobRuntime } from './runtime.ts';

/** One BullMQ job scheduler the leader keeps registered (JOB-050). */
export interface SchedulerSpec {
  readonly id: string;
  readonly queue: QueueName;
  readonly job: JobName;
  readonly data: JobPayloads[JobName];
  /** A five-field cron expression from `schedules.*`. */
  readonly pattern: string;
}

/**
 * The job schedulers the leader registers from config (JOB-050). `scratchCleanup` is not here: it
 * runs in every worker pod, not only the leader, because the scratch directory is pod-local
 * (ADR-0211). `analysisStaleAfter` and `runRequiresAnalysisWithin` are thresholds, not jobs.
 * Endpoint Migrations are created by inventory, so their parity schedulers come from
 * `endpointMigrationIds`, which the manager reads from the database on every reconcile.
 */
export function desiredSchedulers(
  config: Config,
  endpointMigrationIds: readonly string[],
): SchedulerSpec[] {
  const { schedules } = config;
  const specs: SchedulerSpec[] = [];
  for (const endpoint of config.endpoints) {
    specs.push({
      id: `inventory:${endpoint.id}`,
      queue: 'inventory',
      job: 'inventory.endpoint',
      data: { endpointId: endpoint.id },
      pattern: schedules.inventory,
    });
  }
  specs.push(
    {
      id: 'analysis-feeder',
      queue: 'maintenance',
      job: 'analysis.feeder',
      data: {},
      pattern: schedules.analysisFeeder,
    },
    {
      id: 'drift-sweep',
      queue: 'parity',
      job: 'drift.sweep',
      data: {},
      pattern: schedules.drift,
    },
    {
      id: 'prune',
      queue: 'maintenance',
      job: 'maintenance.prune',
      data: {},
      pattern: schedules.prune,
    },
    {
      id: 'run-reaper',
      queue: 'maintenance',
      job: 'maintenance.run-reaper',
      data: {},
      pattern: schedules.runReaper,
    },
  );
  for (const migrationId of endpointMigrationIds) {
    specs.push({
      id: `endpoint-parity:${migrationId}`,
      queue: 'parity',
      job: 'parity.migration',
      data: { migrationId },
      pattern: schedules.endpointParity,
    });
  }
  return specs;
}

/** The queues that carry scheduler-driven jobs. Every scheduler on them is owned by the leader. */
export const SCHEDULED_QUEUES: readonly QueueName[] = ['inventory', 'maintenance', 'parity'];

export interface ReconcileResult {
  readonly upserted: number;
  readonly removed: number;
}

/**
 * Registers every spec (an upsert, so it is idempotent) and removes schedulers on the scheduled
 * queues that no spec names any more (a retired Endpoint, a changed Route).
 */
export async function reconcileSchedulers(
  runtime: JobRuntime,
  specs: readonly SchedulerSpec[],
): Promise<ReconcileResult> {
  for (const spec of specs) {
    await runtime
      .queue(spec.queue)
      .upsertJobScheduler(
        spec.id,
        { pattern: spec.pattern },
        { name: spec.job, data: spec.data, opts: {} },
      );
  }
  let removed = 0;
  for (const queueName of SCHEDULED_QUEUES) {
    const queue = runtime.queue(queueName);
    const wanted = new Set(specs.filter((s) => s.queue === queueName).map((s) => s.id));
    for (const scheduler of await queue.getJobSchedulers(0, -1)) {
      const key = scheduler.key ?? scheduler.id;
      if (key && !wanted.has(key)) {
        await queue.removeJobScheduler(key);
        removed += 1;
      }
    }
  }
  return { upserted: specs.length, removed };
}

/** Ids of the endpoint-scope Migrations of Routes still in config (DOM-014, JOB-050). */
export async function endpointMigrationIds(pool: pg.Pool): Promise<string[]> {
  const result = await pool.query<{ id: string }>(
    `SELECT m.id FROM app.migration m JOIN app.route r ON r.id = m.route_id
     WHERE m.scope = 'endpoint' AND r.retired_at IS NULL ORDER BY m.id`,
  );
  return result.rows.map((row) => row.id);
}

export interface SchedulerManagerOptions {
  readonly runtime: JobRuntime;
  readonly appPool: pg.Pool;
  readonly config: Config;
  readonly log: Logger;
  /** How often the leader re-reads endpoint Migrations. Default 5 minutes. */
  readonly refreshMs?: number;
}

/**
 * Runs while this process is the scheduler leader (ARC-023): registers the schedulers on election
 * and re-reconciles periodically, because inventory creates endpoint Migrations after start-up.
 */
export class SchedulerManager {
  readonly #options: SchedulerManagerOptions;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: SchedulerManagerOptions) {
    this.#options = options;
  }

  async start(): Promise<ReconcileResult> {
    const result = await this.reconcile();
    this.#timer = setInterval(() => {
      this.reconcile().catch((error: unknown) =>
        this.#options.log.error({ err: error }, 'scheduler reconcile failed'),
      );
    }, this.#options.refreshMs ?? 300_000);
    this.#timer.unref();
    return result;
  }

  async reconcile(): Promise<ReconcileResult> {
    const ids = await endpointMigrationIds(this.#options.appPool);
    const result = await reconcileSchedulers(
      this.#options.runtime,
      desiredSchedulers(this.#options.config, ids),
    );
    this.#options.log.info(result, 'job schedulers reconciled');
    return result;
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
