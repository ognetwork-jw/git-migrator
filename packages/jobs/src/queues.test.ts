import { resolveConfig } from '@git-migrator/config';
import { describe, expect, it } from 'vitest';
import {
  analysisQueue,
  attemptsFor,
  concurrencyFor,
  defaultJobOptions,
  type JobName,
  MAINTENANCE_CONCURRENCY,
  QUEUE_DEFINITIONS,
  QUEUE_NAMES,
  queuesForRole,
  runQueue,
} from './queues.ts';

const config = resolveConfig({ text: '', env: {} });

describe('queue definitions', () => {
  it('[JOB-010] defines the seven queues of the spec table', () => {
    expect([...QUEUE_NAMES]).toEqual([
      'inventory',
      'analysis-interactive',
      'analysis-background',
      'runs-standard',
      'runs-large',
      'parity',
      'maintenance',
    ]);
  });

  it('[JOB-010] carries each job on the queues the spec table names', () => {
    expect(QUEUE_DEFINITIONS.inventory.jobs).toEqual(['inventory.endpoint', 'inventory.namespace']);
    expect(QUEUE_DEFINITIONS.parity.jobs).toEqual(['parity.migration', 'drift.sweep']);
    expect(QUEUE_DEFINITIONS.maintenance.jobs).toEqual([
      'maintenance.prune',
      'maintenance.scratch-cleanup',
      'maintenance.run-reaper',
      'analysis.feeder',
    ]);
    expect(QUEUE_DEFINITIONS['analysis-interactive'].jobs).toEqual(['analysis.migration']);
    expect(QUEUE_DEFINITIONS['analysis-background'].jobs).toEqual(['analysis.migration']);
  });

  it('[JOB-010] worker-large consumes only runs-large; standard consumes the rest', () => {
    expect(queuesForRole('large')).toEqual(['runs-large']);
    expect(queuesForRole('standard')).not.toContain('runs-large');
    expect(queuesForRole('standard')).toHaveLength(6);
    expect(queuesForRole('all')).toEqual([...QUEUE_NAMES]);
  });

  it('[JOB-010] routes analyses by priority and Runs by size class and kind', () => {
    expect(analysisQueue('interactive')).toBe('analysis-interactive');
    expect(analysisQueue('background')).toBe('analysis-background');
    const big = { scope: 'repository', sizeClass: 'large' } as const;
    expect(runQueue({ ...big, kind: 'migrate' })).toBe('runs-large');
    expect(runQueue({ ...big, kind: 'resync' })).toBe('runs-large');
    expect(runQueue({ ...big, kind: 'verify' })).toBe('runs-standard');
    expect(runQueue({ ...big, kind: 'rollback' })).toBe('runs-standard');
    expect(runQueue({ ...big, kind: 'source_read_only' })).toBe('runs-standard');
    expect(runQueue({ kind: 'migrate', scope: 'endpoint', sizeClass: 'large' })).toBe(
      'runs-standard',
    );
    expect(runQueue({ kind: 'migrate', scope: 'repository', sizeClass: 'standard' })).toBe(
      'runs-standard',
    );
  });

  it('[JOB-011] keeps finished jobs 1 day and failed jobs 7 days on every queue', () => {
    for (const queue of QUEUE_NAMES) {
      const options = defaultJobOptions(queue);
      expect(options.removeOnComplete).toEqual({ age: 86_400 });
      expect(options.removeOnFail).toEqual({ age: 604_800 });
    }
  });

  it('[JOB-013] retries 3 times with exponential backoff, except run.execute', () => {
    expect(defaultJobOptions('inventory')).toMatchObject({
      attempts: 3,
      backoff: { type: 'exponential' },
    });
    expect(defaultJobOptions('runs-standard').attempts).toBe(1);
    expect(defaultJobOptions('runs-large').attempts).toBe(1);
    expect(attemptsFor('run.execute')).toBe(1);
    const all = QUEUE_NAMES.flatMap((q) => QUEUE_DEFINITIONS[q].jobs as readonly JobName[]);
    for (const job of all.filter((j) => j !== 'run.execute')) expect(attemptsFor(job)).toBe(3);
  });

  it('[JOB-012] takes the concurrency of each queue from config, with the spec defaults', () => {
    expect(concurrencyFor('runs-standard', config)).toBe(4);
    expect(concurrencyFor('analysis-interactive', config)).toBe(8);
    expect(concurrencyFor('analysis-background', config)).toBe(8);
    expect(concurrencyFor('inventory', config)).toBe(2);
    expect(concurrencyFor('parity', config)).toBe(4);
    expect(concurrencyFor('runs-large', config)).toBe(1);
    expect(concurrencyFor('maintenance', config)).toBe(MAINTENANCE_CONCURRENCY);
    const tuned = resolveConfig({
      text: 'worker: { standard: { concurrency: { runs: 7 } }, large: { concurrency: { runs: 2 } } }',
      env: {},
    });
    expect(concurrencyFor('runs-standard', tuned)).toBe(7);
    expect(concurrencyFor('runs-large', tuned)).toBe(2);
  });
});
