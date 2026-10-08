import type { Config } from '@git-migrator/config';

/** The process roles that consume queues (ARC-020, DEP-002). */
export const WORKER_ROLES = ['standard', 'large', 'all'] as const;
export type WorkerRole = (typeof WORKER_ROLES)[number];

/** The consumer groups. `all` consumes both (dev and small installs). */
export type ConsumerGroup = 'standard' | 'large';

export const QUEUE_NAMES = [
  'inventory',
  'analysis-interactive',
  'analysis-background',
  'runs-standard',
  'runs-large',
  'parity',
  'maintenance',
] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

/** Which jobs each queue carries and which worker role consumes it (JOB-010). */
export const QUEUE_DEFINITIONS = {
  inventory: { jobs: ['inventory.endpoint', 'inventory.namespace'], consumer: 'standard' },
  'analysis-interactive': { jobs: ['analysis.migration'], consumer: 'standard' },
  'analysis-background': { jobs: ['analysis.migration'], consumer: 'standard' },
  'runs-standard': { jobs: ['run.execute'], consumer: 'standard' },
  'runs-large': { jobs: ['run.execute'], consumer: 'large' },
  parity: { jobs: ['parity.migration', 'drift.sweep'], consumer: 'standard' },
  maintenance: {
    jobs: [
      'maintenance.prune',
      'maintenance.scratch-cleanup',
      'maintenance.run-reaper',
      'analysis.feeder',
    ],
    consumer: 'standard',
  },
} as const satisfies Record<
  QueueName,
  { readonly jobs: readonly string[]; readonly consumer: ConsumerGroup }
>;

export type JobName = (typeof QUEUE_DEFINITIONS)[QueueName]['jobs'][number];

/** The queues a process with `role` consumes (DEP-002: `worker --role <standard|large|all>`). */
export function queuesForRole(role: WorkerRole): readonly QueueName[] {
  return QUEUE_NAMES.filter(
    (queue) => role === 'all' || QUEUE_DEFINITIONS[queue].consumer === role,
  );
}

/** Retention of finished jobs (JOB-011). */
export const REMOVE_ON_COMPLETE = { age: 86_400 } as const;
export const REMOVE_ON_FAIL = { age: 604_800 } as const;

/** First retry delay of the exponential backoff (JOB-013). */
export const BACKOFF_DELAY_MS = 5_000;

/** `run.execute` manages its own step retries (LIF-042); every other job retries 3 times (JOB-013). */
export function attemptsFor(job: JobName): number {
  return job === 'run.execute' ? 1 : 3;
}

/** Default options for every job added to `queue` (JOB-011, JOB-013). */
export function defaultJobOptions(queue: QueueName) {
  const runs = queue === 'runs-standard' || queue === 'runs-large';
  return {
    attempts: runs ? 1 : 3,
    backoff: { type: 'exponential', delay: BACKOFF_DELAY_MS },
    removeOnComplete: REMOVE_ON_COMPLETE,
    removeOnFail: REMOVE_ON_FAIL,
  } as const;
}

/** What decides the queue of an `analysis.migration` job. */
export type AnalysisPriority = 'interactive' | 'background';

export function analysisQueue(priority: AnalysisPriority): QueueName {
  return priority === 'interactive' ? 'analysis-interactive' : 'analysis-background';
}

export interface RunRouting {
  readonly kind: string;
  readonly scope: 'repository' | 'endpoint';
  readonly sizeClass: 'standard' | 'large';
}

/** Run kinds that push git data, and so may need the large pool (JOB-010). */
const GIT_RUN_KINDS: readonly string[] = ['migrate', 'run_anyway', 'resync'];

/**
 * `runs-large` carries `run.execute` for `sizeClass = large` with git steps. Endpoint Runs and
 * all non-git Runs (verify, rollback, source read-only) go to `runs-standard` (JOB-010).
 */
export function runQueue(run: RunRouting): QueueName {
  return run.scope === 'repository' && run.sizeClass === 'large' && GIT_RUN_KINDS.includes(run.kind)
    ? 'runs-large'
    : 'runs-standard';
}

/** Concurrency of the worker for `queue` in a pod of `group` (JOB-012). */
export function concurrencyFor(queue: QueueName, config: Config): number {
  const { standard, large } = config.worker;
  switch (queue) {
    case 'inventory':
      return standard.concurrency.inventory;
    case 'analysis-interactive':
    case 'analysis-background':
      return standard.concurrency.analysis;
    case 'runs-standard':
      return standard.concurrency.runs;
    case 'runs-large':
      return large.concurrency.runs;
    case 'parity':
      return standard.concurrency.parity;
    case 'maintenance':
      return MAINTENANCE_CONCURRENCY;
  }
}

/** Maintenance jobs are short; two slots keep the feeder from waiting behind a prune. */
export const MAINTENANCE_CONCURRENCY = 2;
