/**
 * Test harness for the Run executor: a throw-away database, a recording enqueuer, and helpers to
 * create Runs and read their state. Not part of the package API.
 */
import { AdapterError } from '@git-migrator/adapter-sdk';
import type { RunKind } from '@git-migrator/core';
import type { TestDatabase } from '@git-migrator/db/testing';
import { createLogger, type Logger } from '@git-migrator/observability';
import type { RunRouting } from '../queues.ts';
import type { RunEnqueuerLike } from '../run-leases.ts';
import { type BasicWorld, seedBasics } from '../world.fixture.ts';
import {
  type ExecuteOptions,
  type ExecuteResult,
  executeRun,
  type RunAnalysisPort,
  type RunExecutorDeps,
} from './executor.ts';
import { createRun } from './guard.ts';
import { RunStepRegistry, type StepDefinition } from './types.ts';

export const silentLog: Logger = createLogger({ level: 'silent' });

export interface Services {
  /** Names of Steps in the order they started. */
  readonly calls: string[];
}

export interface EnqueueCall {
  readonly runId: string;
  readonly routing: RunRouting;
  readonly dedupeId: string | undefined;
  readonly delayMs: number | undefined;
}

export function recordingEnqueuer(): {
  calls: EnqueueCall[];
  runs: RunEnqueuerLike & { isRunJobPending(dedupeId: string): Promise<boolean> };
} {
  const calls: EnqueueCall[] = [];
  return {
    calls,
    runs: {
      async enqueueRun(runId, routing, options) {
        calls.push({ runId, routing, dedupeId: options?.dedupeId, delayMs: options?.delayMs });
      },
      async isRunJobPending(dedupeId) {
        return calls.some((c) => c.dedupeId === dedupeId);
      },
    },
  };
}

export const transient = (message = 'upstream 503'): AdapterError =>
  new AdapterError({ code: 'transient', provider: 'type-a', message });

export const rateLimited = (retryAt?: Date): AdapterError =>
  new AdapterError({
    code: 'rate_limited',
    provider: 'type-a',
    message: 'slow down',
    ...(retryAt ? { retryAt } : { retryAfterMs: 30_000 }),
  });

export type StepBody = NonNullable<StepDefinition<Services>['run']>;

export const step = (
  key: string,
  run: StepBody = async () => ({ status: 'succeeded' }),
  extra: Partial<Omit<StepDefinition<Services>, 'key' | 'run'>> = {},
): StepDefinition<Services> => ({ key, severity: 'independent', run, ...extra });

/** A Step that notes its start in `services.calls` under `label` and succeeds. */
export const tracked = (key: string, label: string = key): StepDefinition<Services> =>
  step(key, async (ctx) => {
    ctx.services.calls.push(label);
    return { status: 'succeeded' };
  });

export const FIXED_NOW = new Date('2026-10-09T10:00:00.000Z');

export class Harness {
  readonly services: Services = { calls: [] };
  readonly registry = new RunStepRegistry<Services>();
  readonly enqueuer = recordingEnqueuer();
  readonly sleeps: number[] = [];
  /** By default the Analysis is fresh enough: nothing to re-analyze. */
  analysis: RunAnalysisPort | undefined = {
    run: async () => ({ reanalyzed: false, before: 'ready', after: 'ready', worsened: false }),
    recordFailure: async () => undefined,
  };
  /** Fixed randomness for retry backoff. */
  random = () => 0.5;

  readonly t: TestDatabase;

  constructor(t: TestDatabase) {
    this.t = t;
  }

  get db() {
    return this.t.db.privileged;
  }

  deps(overrides: Partial<RunExecutorDeps<Services>> = {}): RunExecutorDeps<Services> {
    return {
      db: this.db,
      pool: this.t.db.pool,
      log: silentLog,
      registry: this.registry,
      runs: this.enqueuer.runs,
      services: this.services,
      workerId: 'worker-a',
      ...(this.analysis ? { analysis: this.analysis } : {}),
      now: () => FIXED_NOW,
      random: this.random,
      sleep: async (ms) => {
        this.sleeps.push(ms);
      },
      cancelPollMs: 15,
      // No renewal during a test: the lease is moved by the test itself.
      lease: { renewMs: 600_000 },
      ...overrides,
    };
  }

  /** A Migration that is ready to migrate, and a queued Run of `kind` on it. */
  async queuedRun(
    kind: RunKind = 'migrate',
    options: { readiness?: 'ready' | 'needs_attention' | 'blocked' | null } = {},
  ): Promise<{ world: BasicWorld; runId: string }> {
    const world = await seedBasics(this.db);
    await this.db.migration.update({
      where: { id: world.migrationId },
      data: {
        status: 'analyzed',
        readiness: options.readiness === undefined ? 'ready' : options.readiness,
      },
    });
    const created = await createRun(this.db, {
      migrationId: world.migrationId,
      kind,
      triggeredById: world.actorId,
      now: () => FIXED_NOW,
    });
    return { world, runId: created.runId };
  }

  execute(
    runId: string,
    options: Partial<ExecuteOptions> = {},
    overrides: Partial<RunExecutorDeps<Services>> = {},
  ): Promise<ExecuteResult> {
    return executeRun(this.deps(overrides), runId, {
      shutdown: new AbortController().signal,
      ...options,
    });
  }

  run(runId: string) {
    return this.db.run.findUniqueOrThrow({ where: { id: runId } });
  }

  steps(runId: string) {
    return this.db.runStep.findMany({ where: { runId }, orderBy: { order: 'asc' } });
  }

  async stepStatuses(runId: string): Promise<Record<string, string>> {
    return Object.fromEntries((await this.steps(runId)).map((s) => [s.stepKey, s.status]));
  }

  migration(id: string) {
    return this.db.migration.findUniqueOrThrow({ where: { id } });
  }

  /** Makes the lease of a running Run expire, as if its worker died. */
  async expireLease(runId: string): Promise<void> {
    await this.t.db.pool.query(
      "UPDATE app.run SET lease_expires_at = clock_timestamp() - interval '5 seconds' WHERE id = $1",
      [runId],
    );
  }
}

export async function until(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

export function deferred<T = void>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
