/**
 * The Run executor (LIF-040, LIF-042, LIF-046): claims a Run's lease, runs its Steps in order, and
 * ends it. This file is the framework; the Steps of each Run kind arrive through `RunStepRegistry`
 * (T-071 and later). Decisions: docs/adr/0340-run-executor-framework.md and
 * docs/adr/0341-run-step-state-machine.md.
 */
import { AdapterError, stripBody, stripText } from '@git-migrator/adapter-sdk';
import type { RunKind } from '@git-migrator/core';
import type { Db } from '@git-migrator/db';
import type { Logger } from '@git-migrator/observability';
import type pg from 'pg';
import { recordAnalysisFailure } from '../analysis/analysis.ts';
import type { RunAnalysisOutcome } from '../analysis/fresh.ts';
import type { RunRouting } from '../queues.ts';
import type { ReaperMetrics } from '../reaper.ts';
import {
  handOffRun,
  keepRunLease,
  type RunEnqueuerLike,
  type RunLeaseHandle,
} from '../run-leases.ts';
import type { JobHandlers } from '../runtime.ts';
import {
  isRateLimited,
  isRetryable,
  isSerializationConflict,
  rateLimitDelayMs,
  retryDelayMs,
  serializeStepError,
} from './errors.ts';
import { addRunBlocker, addRunTask, clearRunBlockers } from './findings.ts';
import { type FinalRunStatus, finishRun } from './finish.ts';
import { allowedReadiness } from './guard.ts';
import { confirmLedger, openIntentsOf, writeLedger } from './ledger.ts';
import { fenced, ledgerTransaction, publish, publishMigration, publishRun } from './store.ts';
import {
  DEFAULT_MAX_ATTEMPTS,
  type MigrationSnapshot,
  RunCancelledError,
  RunLeaseLostError,
  type RunSnapshot,
  type RunStepRegistry,
  type StepContext,
  type StepDefinition,
  type StepResult,
  type Tx,
} from './types.ts';

/** Run kinds that re-analyze inline first when the Analysis is stale or old (LIF-021, LIF-022). */
export const ANALYSIS_GATED_KINDS: readonly RunKind[] = ['migrate', 'run_anyway', 'resync'];

/** The inline Analysis of LIF-021/LIF-022 and its failure marker (ADR-0343). */
export interface RunAnalysisPort {
  run(migrationId: string, options: { signal: AbortSignal }): Promise<RunAnalysisOutcome>;
  /** Writes the failure marker the feeder backs off on (ADR-0312). */
  recordFailure(migrationId: string): Promise<void>;
}

export interface RunExecutorDeps<S = unknown> {
  /** The privileged client. */
  readonly db: Db;
  /** The application pool: the lease queries. */
  readonly pool: pg.Pool;
  readonly log: Logger;
  readonly registry: RunStepRegistry<S>;
  /** Re-enqueues `run.execute` for a delay or a SIGTERM hand-off. */
  readonly runs: RunEnqueuerLike;
  /** Handed to every Step as `ctx.services`. */
  readonly services: S;
  readonly workerId: string;
  readonly analysis?: RunAnalysisPort;
  readonly metrics?: ReaperMetrics;
  /** Test seams. */
  readonly now?: () => Date;
  readonly random?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** How often a running Step polls for a cancel request (default 2 s). */
  readonly cancelPollMs?: number;
  readonly lease?: { renewMs?: number; localLimitMs?: number; now?: () => number };
}

export interface ExecuteOptions {
  readonly jobId?: string | number | undefined;
  /** The process is shutting down: finish the current Step, then hand the Run off (LIF-046). */
  readonly shutdown: AbortSignal;
  readonly log?: Logger;
}

export type ExecuteResult =
  /** Another job holds the lease, or the Run is not runnable (finished, missing). Nothing done. */
  | { readonly outcome: 'not_claimed' }
  | { readonly outcome: 'finished'; readonly status: FinalRunStatus }
  /** Released and re-enqueued after `delayMs` (rate limit, scratch space). */
  | { readonly outcome: 'delayed'; readonly delayMs: number; readonly reason: string }
  /** SIGTERM: the current Step finished and the Run was re-enqueued (delay 0). */
  | { readonly outcome: 'handed_off' }
  /** The lease was lost: stopped without writing. The new holder continues. */
  | { readonly outcome: 'lost' };

export const DEFAULT_CANCEL_POLL_MS = 2_000;
const MAX_LOG_CHARS = 2_000;
/** Structured data of a Run log entry beyond this size is replaced by a marker. */
const MAX_LOG_DATA_CHARS = 16_000;
const LEDGER_CONFLICT_RETRIES = 5;

/** Waits `ms`, or until `signal` aborts. */
export const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

const stepId = (key: string, facetKey: string | null | undefined): string =>
  `${key}\u0000${facetKey ?? ''}`;

interface StepRow {
  id: string;
  stepKey: string;
  facetKey: string | null;
  order: number;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
  attempts: number;
  delays: number;
  failures: number;
  severity: string | null;
}

/** Why `drive` stops before the last Step. */
type StepEnd =
  | { kind: 'done' }
  | { kind: 'delay'; delayMs: number; reason: string }
  | { kind: 'cancelled' }
  | { kind: 'handoff' };

/**
 * Executes (or resumes) one Run. Safe to call from any number of workers for the same Run: only the
 * one that wins the lease does anything (LIF-046), and every write is fenced on that lease.
 */
export async function executeRun<S>(
  deps: RunExecutorDeps<S>,
  runId: string,
  options: ExecuteOptions,
): Promise<ExecuteResult> {
  const log = (options.log ?? deps.log).child?.({ runId }) ?? deps.log;
  const lease = await keepRunLease({
    pool: deps.pool,
    runId,
    workerId: deps.workerId,
    jobId: options.jobId,
    startQueued: true,
    log,
    ...(deps.lease?.renewMs !== undefined ? { renewMs: deps.lease.renewMs } : {}),
    ...(deps.lease?.localLimitMs !== undefined ? { localLimitMs: deps.lease.localLimitMs } : {}),
    ...(deps.lease?.now ? { now: deps.lease.now } : {}),
  });
  if (!lease) {
    log.info('Run not claimed: another worker holds it, or it is not runnable');
    return { outcome: 'not_claimed' };
  }
  try {
    const result = await new Driver(deps, runId, lease, options, log).drive();
    if (result.outcome === 'finished') await lease.release();
    else lease.stop();
    return result;
  } catch (error) {
    // Leave the lease to expire: the reaper resumes the Run and counts it, so a Step bug that
    // crashes the executor cannot loop for ever (LIF-046).
    lease.stop();
    if (error instanceof RunLeaseLostError) {
      log.warn('Run lease lost; stopped without writing');
      return { outcome: 'lost' };
    }
    throw error;
  }
}

class Driver<S> {
  readonly #deps: RunExecutorDeps<S>;
  readonly #runId: string;
  readonly #lease: RunLeaseHandle;
  readonly #options: ExecuteOptions;
  readonly #log: Logger;
  readonly #cancel = new AbortController();
  readonly #signal: AbortSignal;
  readonly #now: () => Date;
  #run!: RunSnapshot;
  #migrationId = '';
  #routing!: RunRouting;
  #startedAt: Date | null = null;

  constructor(
    deps: RunExecutorDeps<S>,
    runId: string,
    lease: RunLeaseHandle,
    options: ExecuteOptions,
    log: Logger,
  ) {
    this.#deps = deps;
    this.#runId = runId;
    this.#lease = lease;
    this.#options = options;
    this.#log = log;
    this.#signal = AbortSignal.any([this.#cancel.signal, lease.lost]);
    this.#now = deps.now ?? (() => new Date());
  }

  #fence<T>(fn: (tx: Tx) => Promise<T>, withMigration = false): Promise<T> {
    return fenced(
      this.#deps.db,
      {
        runId: this.#runId,
        token: this.#lease.token,
        ...(withMigration ? { migrationId: this.#migrationId } : {}),
      },
      fn,
    );
  }

  #assertHeld(): void {
    if (this.#lease.lost.aborted) throw new RunLeaseLostError();
  }

  async drive(): Promise<ExecuteResult> {
    const { db, registry } = this.#deps;
    const row = await db.run.findUniqueOrThrow({
      where: { id: this.#runId },
      include: { migration: { include: { sourceRepository: { select: { sizeClass: true } } } } },
    });
    this.#migrationId = row.migrationId;
    this.#startedAt = row.startedAt;
    this.#routing = {
      kind: row.kind,
      scope: row.migration.scope,
      sizeClass: (row.migration.sourceRepository?.sizeClass ?? 'standard') as 'standard' | 'large',
    };
    this.#run = {
      id: row.id,
      kind: row.kind,
      migrationId: row.migrationId,
      analysisId: row.analysisId,
      triggeredById: row.triggeredById,
      options: (row.options ?? {}) as Record<string, unknown>,
    };
    const poll = this.#startCancelPoll();
    try {
      return await this.#drive(registry);
    } finally {
      clearInterval(poll);
    }
  }

  #startCancelPoll(): NodeJS.Timeout {
    const timer = setInterval(() => {
      void this.#pollCancel().catch((error: unknown) =>
        this.#log.warn({ err: error }, 'could not poll for a cancel request'),
      );
    }, this.#deps.cancelPollMs ?? DEFAULT_CANCEL_POLL_MS);
    timer.unref();
    return timer;
  }

  /** True when a cancel was requested; aborts the Step signal when so. */
  async #pollCancel(): Promise<boolean> {
    if (this.#cancel.signal.aborted) return true;
    const result = await this.#deps.pool.query<{ requested: boolean }>(
      'SELECT cancel_requested_at IS NOT NULL AS requested FROM app.run WHERE id = $1',
      [this.#runId],
    );
    if (result.rows[0]?.requested) this.#cancel.abort();
    return this.#cancel.signal.aborted;
  }

  async #drive(registry: RunStepRegistry<S>): Promise<ExecuteResult> {
    const planner = registry.planner(this.#run.kind);
    if (!planner) {
      return this.#finish('failed', {
        code: 'run.kind_unsupported',
        message: `No Steps are registered for ${this.#run.kind} Runs`,
      });
    }
    if (await this.#pollCancel()) return this.#finish('cancelled', { code: 'run.cancelled' });

    const early = await this.#preRunAnalysis();
    if (early) return early;

    const migration = await this.#loadMigration();
    const defs = new Map<string, StepDefinition<S>>();
    const ordered = await planner.steps({ run: this.#run, migration });
    for (const def of ordered) {
      const id = stepId(def.key, def.facetKey);
      if (defs.has(id)) throw new Error(`Run kind ${this.#run.kind} plans ${def.key} twice`);
      defs.set(id, def);
    }
    await this.#ensureSteps(ordered);

    for (;;) {
      this.#assertHeld();
      const rows = await this.#loadSteps();
      const byId = new Map(rows.map((r) => [stepId(r.stepKey, r.facetKey), r]));
      const failedFatal = rows.some(
        (r) => r.status === 'failed' && this.#severityOf(r, defs) === 'fatal',
      );
      if (failedFatal) return this.#finish('failed', await this.#firstFailure(rows));
      // The current plan decides the order; the rows decide what is left to do.
      const next = ordered
        .map((d) => byId.get(stepId(d.key, d.facetKey)))
        .find((r) => r !== undefined && (r.status === 'pending' || r.status === 'running'));
      if (!next) return this.#finish(this.#outcomeOf(rows, defs), undefined);

      if (await this.#pollCancel()) return this.#finish('cancelled', { code: 'run.cancelled' });
      if (this.#options.shutdown.aborted) return this.#handOff(0);

      const def = defs.get(stepId(next.stepKey, next.facetKey)) as StepDefinition<S>;
      const end = await this.#runStep(def, next);
      if (end.kind === 'cancelled') return this.#finish('cancelled', { code: 'run.cancelled' });
      if (end.kind === 'handoff') return this.#handOff(0);
      if (end.kind === 'delay') return this.#delay(end.delayMs, end.reason);
    }
  }

  /** LIF-021, LIF-022 and the known gap: a failing inline Analysis fails the Run (ADR-0343). */
  async #preRunAnalysis(): Promise<ExecuteResult | undefined> {
    const analysis = this.#deps.analysis;
    if (!ANALYSIS_GATED_KINDS.includes(this.#run.kind) || this.#run.analysisId !== null) {
      return undefined;
    }
    if (!analysis) {
      return this.#finish('failed', {
        code: 'run.analysis_unavailable',
        message: 'The Run executor has no inline Analysis wired',
      });
    }
    let outcome: RunAnalysisOutcome;
    try {
      outcome = await analysis.run(this.#migrationId, { signal: this.#signal });
    } catch (error) {
      this.#assertHeld();
      if (this.#cancel.signal.aborted) return this.#finish('cancelled', { code: 'run.cancelled' });
      if (this.#options.shutdown.aborted) return this.#handOff(0);
      if (isRateLimited(error)) {
        return this.#delay(rateLimitDelayMs(error, this.#now()), 'analysis rate limited');
      }
      this.#log.error({ err: error }, 'the inline Analysis of a Run failed');
      await analysis
        .recordFailure(this.#migrationId)
        .catch((e: unknown) => this.#log.warn({ err: e }, 'could not record the Analysis failure'));
      return this.#finish('failed', { ...serializeStepError(error), code: 'run.analysis_failed' });
    }
    if (outcome.result?.skipped) {
      return this.#finish('failed', {
        code: 'run.analysis_skipped',
        reason: outcome.result.skipped,
      });
    }
    if (outcome.worsened) {
      // Nothing ran: the Run is cancelled, so the Migration returns to its saved status and the
      // UI shows the new findings (LIF-022, ADR-0343).
      return this.#finish('cancelled', {
        code: 'readiness_changed',
        before: outcome.before,
        after: outcome.after,
      });
    }
    // LIF-005 again, now that the Run starts: the Migration may have changed while it was queued.
    const allowed = allowedReadiness(this.#run.kind);
    if (allowed) {
      const current = await this.#deps.db.migration.findUniqueOrThrow({
        where: { id: this.#migrationId },
        select: { readiness: true },
      });
      if (!allowed.includes(current.readiness ?? null)) {
        return this.#finish('cancelled', {
          code: 'readiness_changed',
          before: outcome.before,
          after: current.readiness ?? null,
        });
      }
    }
    await this.#fence(async (tx) => {
      await tx.$executeRaw`
        UPDATE app.run SET analysis_id = m.latest_analysis_id, updated_at = clock_timestamp()
        FROM app.migration m
        WHERE app.run.id = ${this.#runId} AND m.id = app.run.migration_id`;
      const run = await tx.run.findUniqueOrThrow({
        where: { id: this.#runId },
        select: { analysisId: true },
      });
      this.#run = { ...this.#run, analysisId: run.analysisId };
    });
    return undefined;
  }

  async #loadMigration(): Promise<MigrationSnapshot> {
    const m = await this.#deps.db.migration.findUniqueOrThrow({
      where: { id: this.#migrationId },
      select: {
        id: true,
        routeId: true,
        scope: true,
        sourceRepositoryId: true,
        targetRepositoryId: true,
        plannedTargetName: true,
        targetCreatedByFramework: true,
        sourceReadOnlyApplied: true,
      },
    });
    return m;
  }

  /**
   * Creates the Step rows of the plan by identity (key and Facet), appending new ones after the
   * highest existing order, and skips unfinished rows the plan no longer contains. A resume under a
   * changed plan therefore never shifts, repeats or loses a Step (ADR-0340).
   */
  async #ensureSteps(defs: readonly StepDefinition<S>[]): Promise<void> {
    await this.#fence(async (tx) => {
      for (const def of defs) {
        await tx.$executeRaw`
          INSERT INTO app.run_step (id, run_id, step_key, facet_key, severity, "order", updated_at)
          SELECT ${crypto.randomUUID()}::text, ${this.#runId}::text, ${def.key}::text,
                 ${def.facetKey ?? null}::text, ${def.severity}::text,
                 COALESCE(MAX("order"), -1) + 1, clock_timestamp()
          FROM app.run_step WHERE run_id = ${this.#runId}
          ON CONFLICT (run_id, step_key, (COALESCE(facet_key, ''))) DO NOTHING`;
      }
      const planned = new Set(defs.map((d) => stepId(d.key, d.facetKey)));
      const rows = await tx.runStep.findMany({ where: { runId: this.#runId } });
      for (const row of rows) {
        if (planned.has(stepId(row.stepKey, row.facetKey))) continue;
        if (row.status !== 'pending' && row.status !== 'running') continue;
        // A fatal Step that left the plan after it started (running, or attempted before, however
        // that attempt ended: a failure, a rate limit or a delay) is a failure of the Run, because it
        // may have changed a provider; one that never ran is only skipped (ADR-0341).
        const status =
          row.severity === 'fatal' &&
          (row.status === 'running' || row.attempts > 0 || row.failures > 0)
            ? 'failed'
            : 'skipped';
        this.#log.warn({ step: row.stepKey, status }, 'a stored Step is no longer planned');
        await tx.$executeRaw`
          UPDATE app.run_step
          SET status = ${status}::app.step_status, finished_at = clock_timestamp(),
              updated_at = clock_timestamp(), error = '{"code":"run.plan_changed"}'::jsonb
          WHERE id = ${row.id}`;
      }
      await publishRun(tx, { run: this.#runId, migration: this.#migrationId }, this.#now);
    });
  }

  async #loadSteps(): Promise<StepRow[]> {
    return (await this.#deps.db.runStep.findMany({
      where: { runId: this.#runId },
      orderBy: { order: 'asc' },
    })) as StepRow[];
  }

  /** The severity a row was planned with; a row from before it was stored uses the current plan. */
  #severityOf(row: StepRow, defs: ReadonlyMap<string, StepDefinition<S>>): string | undefined {
    return row.severity ?? defs.get(stepId(row.stepKey, row.facetKey))?.severity;
  }

  #outcomeOf(
    rows: readonly StepRow[],
    defs: ReadonlyMap<string, StepDefinition<S>>,
  ): FinalRunStatus {
    const failed = rows.filter((r) => r.status === 'failed');
    const severities = failed.map((r) => this.#severityOf(r, defs));
    if (severities.includes('fatal')) return 'failed';
    return severities.includes('independent') || severities.includes(undefined)
      ? 'partial'
      : 'succeeded';
  }

  async #firstFailure(rows: readonly StepRow[]): Promise<Record<string, unknown>> {
    const failed = rows.find((r) => r.status === 'failed');
    if (!failed) return { code: 'run.failed' };
    const stored = await this.#deps.db.runStep.findUnique({
      where: { id: failed.id },
      select: { error: true },
    });
    return { code: 'run.step_failed', step: failed.stepKey, cause: stored?.error ?? null };
  }

  async #runStep(def: StepDefinition<S>, row: StepRow): Promise<StepEnd> {
    const maxAttempts = def.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    let attempts = row.attempts;
    // The budget counts attempts that ended in a retryable failure or a crash, over every resume.
    // A rate limit or a delay is not an attempt (ADR-0341).
    let failures = row.failures;
    const random = this.#deps.random ?? Math.random;
    const sleep = this.#deps.sleep ?? defaultSleep;
    if (row.status === 'running') {
      // A previous worker died in this Step: that attempt failed.
      failures += 1;
      await this.#markStep(row.id, 'running', { failures });
    }
    if (failures >= maxAttempts) {
      await this.#failStep(row, {
        code: 'step.attempts_exhausted',
        message: `Step failed ${failures} times (limit ${maxAttempts})`,
        retryable: false,
      });
      return { kind: 'done' };
    }
    for (;;) {
      attempts += 1;
      await this.#markStep(row.id, 'running', { attempts });
      const migration = await this.#loadMigration();
      const ctx = this.#context(def, row, attempts, migration);
      try {
        const result: StepResult = (await def.run(ctx)) ?? { status: 'succeeded' };
        this.#assertHeld();
        return await this.#recordResult(def, row, result);
      } catch (error) {
        if (this.#lease.lost.aborted || error instanceof RunLeaseLostError) {
          throw new RunLeaseLostError();
        }
        if (this.#cancel.signal.aborted || error instanceof RunCancelledError) {
          await this.#failStep(row, {
            code: 'run.cancelled',
            message: 'Cancelled',
            retryable: false,
          });
          return { kind: 'cancelled' };
        }
        if (isRateLimited(error)) {
          const delayMs = rateLimitDelayMs(error, this.#now());
          await this.#markStep(row.id, 'pending', { delay: true });
          return { kind: 'delay', delayMs, reason: 'rate limited' };
        }
        const stored = serializeStepError(error);
        if (isRetryable(error)) failures += 1;
        if (isRetryable(error) && failures < maxAttempts) {
          this.#log.warn(
            { step: def.key, attempt: attempts, code: stored.code },
            'Step failed; retrying',
          );
          // `pending` while waiting: a worker that dies in the wait has already had this failure
          // counted, and the resume must not count it again as a crash.
          await this.#markStep(row.id, 'pending', { error: stored, failures });
          // A cancel and a SIGTERM both wake the wait.
          await sleep(
            retryDelayMs(failures, random),
            AbortSignal.any([this.#signal, this.#options.shutdown]),
          );
          this.#assertHeld();
          if (this.#cancel.signal.aborted || (await this.#pollCancel())) {
            await this.#failStep(row, {
              code: 'run.cancelled',
              message: 'Cancelled',
              retryable: false,
            });
            return { kind: 'cancelled' };
          }
          if (this.#options.shutdown.aborted) return { kind: 'handoff' };
          continue;
        }
        this.#log.error({ step: def.key, attempt: attempts, code: stored.code }, 'Step failed');
        await this.#failStep(row, stored);
        return { kind: 'done' };
      }
    }
  }

  async #recordResult(def: StepDefinition<S>, row: StepRow, result: StepResult): Promise<StepEnd> {
    if (result.status === 'delay') {
      await this.#markStep(row.id, 'pending', { delay: true });
      return { kind: 'delay', delayMs: result.delayMs, reason: result.reason };
    }
    if (result.status === 'skipped') {
      await this.#markStep(row.id, 'skipped', {});
      await this.#appendLog('info', `${def.key} skipped: ${result.reason}`, row.id);
      return { kind: 'done' };
    }
    if (def.clearsBlockers && def.clearsBlockers.length > 0) {
      // LIF-049: this Step passed, so the run-origin blockers it guards are gone. Done before the
      // Step is marked succeeded, so a crash in between repeats it (it is idempotent).
      await this.#fence(async (tx) => {
        await clearRunBlockers(tx, this.#migrationId, def.clearsBlockers ?? []);
        await publishMigration(tx, this.#migrationId, this.#now);
      }, true);
    }
    await this.#markStep(row.id, 'succeeded', {});
    return { kind: 'done' };
  }

  /** One state change of a Step row, with its event, under the fence. */
  async #markStep(
    id: string,
    status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped',
    change: {
      attempts?: number;
      failures?: number;
      error?: Record<string, unknown> | null;
      delay?: boolean;
    },
  ): Promise<void> {
    const isRunning = status === 'running';
    const isFinished = status === 'succeeded' || status === 'failed' || status === 'skipped';
    const errorJson = change.error ? JSON.stringify(change.error) : null;
    await this.#fence(async (tx) => {
      await tx.$executeRaw`
        UPDATE app.run_step
        SET status = ${status}::app.step_status,
            attempts = COALESCE(${change.attempts ?? null}::int, attempts),
            failures = COALESCE(${change.failures ?? null}::int, failures),
            delays = delays + ${change.delay ? 1 : 0}::int,
            started_at = CASE WHEN ${isRunning} THEN COALESCE(started_at, clock_timestamp())
                              ELSE started_at END,
            finished_at = CASE WHEN ${isFinished} THEN clock_timestamp() ELSE NULL END,
            error = ${errorJson}::jsonb,
            updated_at = clock_timestamp()
        WHERE id = ${id} AND run_id = ${this.#runId}`;
      await publishRun(tx, { run: this.#runId, migration: this.#migrationId }, this.#now);
    });
  }

  async #failStep(row: StepRow, error: Record<string, unknown>): Promise<void> {
    await this.#markStep(row.id, 'failed', { error });
  }

  #context(
    def: StepDefinition<S>,
    row: StepRow,
    attempt: number,
    migration: MigrationSnapshot,
  ): StepContext<S> {
    const target = {
      migrationId: this.#migrationId,
      routeId: migration.routeId,
      runId: this.#runId,
      stepId: row.id,
    };
    const log = this.#log.child?.({ step: def.key, facetKey: def.facetKey ?? null }) ?? this.#log;
    // A lock cycle or serialization failure aborts the ledger transaction; the record describes a
    // change that already happened, so it is retried. After 5 conflicts the attempt fails with a
    // retryable error and the Step retries within its failure budget.
    const ledgerWrite = async <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await ledgerTransaction(this.#deps.db, this.#runId, fn, {
            now: this.#now,
            log: this.#log,
          });
        } catch (error) {
          if (!isSerializationConflict(error)) throw error;
          if (attempt >= LEDGER_CONFLICT_RETRIES) {
            // Out of retries: fail the attempt with a retryable error. `apply` is idempotent, so the
            // Step retries within its failure budget and records the change again.
            throw new AdapterError({
              code: 'transient',
              provider: 'framework',
              message: 'The ledger write kept conflicting with other transactions',
              retryable: true,
              cause: error,
            });
          }
          const wait = Math.floor((this.#deps.random ?? Math.random)() * 50 * attempt);
          await defaultSleep(wait, new AbortController().signal);
        }
      }
    };
    const record: StepContext<S>['ledger']['record'] = async (write, records) => {
      await ledgerWrite(async (tx) => {
        await writeLedger(tx, target, write, records, this.#now());
        await publishRun(tx, { run: this.#runId, migration: this.#migrationId }, this.#now);
      });
    };
    return {
      run: this.#run,
      migration,
      step: {
        id: row.id,
        key: def.key,
        facetKey: def.facetKey ?? null,
        attempt,
        delays: row.delays,
      },
      signal: this.#signal,
      log,
      services: this.#deps.services,
      ledger: {
        record,
        recordAll: async (write, records) => {
          let count = 0;
          // Each record is persisted as it is yielded: when the iteration throws, the changes made
          // before the failure are already in the ledger (ADP-011).
          for await (const record_ of records) {
            await record(write, [record_]);
            count += 1;
          }
          return count;
        },
        intend: async (write, intent) => {
          const ids = await ledgerWrite((tx) =>
            writeLedger(tx, target, write, [intent], this.#now(), 'intended'),
          );
          return ids[0] as string;
        },
        openIntents: () =>
          ledgerTransaction(this.#deps.db, this.#runId, (tx) =>
            openIntentsOf(tx, this.#runId, row.id),
          ),
        confirm: async (id, outcome, actual) => {
          await ledgerWrite(async (tx) => {
            await confirmLedger(tx, target, id, outcome, actual, this.#now());
          });
        },
      },
      findings: {
        addBlocker: (finding) =>
          this.#fence(async (tx) => {
            await addRunBlocker(tx, this.#migrationId, finding, this.#now());
            await publishMigration(tx, this.#migrationId, this.#now);
          }, true),
        clearBlockers: (codes) =>
          this.#fence(async (tx) => {
            await clearRunBlockers(tx, this.#migrationId, codes);
            await publishMigration(tx, this.#migrationId, this.#now);
          }, true),
        addTask: (finding) =>
          this.#fence(async (tx) => {
            await addRunTask(tx, this.#migrationId, finding);
            await publishMigration(tx, this.#migrationId, this.#now);
          }, true),
      },
      runLog: async (level, message, data) => {
        // A log call never fails a Step: only a lost lease propagates.
        try {
          await this.#appendLog(level, message, row.id, data);
        } catch (error) {
          if (error instanceof RunLeaseLostError) throw error;
          this.#log.warn({ err: error }, 'could not append to the Run log');
        }
      },
      checkpoint: () => this.#checkpoint(),
      transaction: (fn, options) => this.#fence(fn, options?.migration === true),
    };
  }

  #checkpoint(): void {
    if (this.#lease.lost.aborted) throw new RunLeaseLostError();
    if (this.#cancel.signal.aborted) throw new RunCancelledError();
  }

  async #appendLog(
    level: 'info' | 'warn' | 'error',
    message: string,
    stepRowId: string | null,
    data?: Record<string, unknown>,
  ): Promise<void> {
    await this.#fence(async (tx) => {
      await tx.runLog.create({
        data: {
          runId: this.#runId,
          stepId: stepRowId,
          ts: this.#now(),
          level,
          message: stripText(message).slice(0, MAX_LOG_CHARS),
          ...(data ? { data: sanitizeLogData(data) } : {}),
        },
      });
      await publish(tx, 'run.log', { run: this.#runId, migration: this.#migrationId }, this.#now);
    });
  }

  async #delay(delayMs: number, reason: string): Promise<ExecuteResult> {
    this.#log.info({ delayMs, reason }, 'Run delayed');
    const ok = await handOffRun({
      pool: this.#deps.pool,
      runs: this.#deps.runs,
      runId: this.#runId,
      token: this.#lease.token,
      routing: this.#routing,
      delayMs,
    });
    return ok ? { outcome: 'delayed', delayMs, reason } : { outcome: 'lost' };
  }

  async #handOff(delayMs: number): Promise<ExecuteResult> {
    const ok = await handOffRun({
      pool: this.#deps.pool,
      runs: this.#deps.runs,
      runId: this.#runId,
      token: this.#lease.token,
      routing: this.#routing,
      delayMs,
    });
    return ok ? { outcome: 'handed_off' } : { outcome: 'lost' };
  }

  async #finish(
    status: FinalRunStatus,
    error: Record<string, unknown> | undefined,
  ): Promise<ExecuteResult> {
    this.#assertHeld();
    await finishRun(this.#deps.db, {
      runId: this.#runId,
      token: this.#lease.token,
      migrationId: this.#migrationId,
      status,
      error,
      now: this.#now,
      log: this.#log,
    });
    const seconds = this.#startedAt
      ? (this.#now().getTime() - this.#startedAt.getTime()) / 1000
      : 0;
    this.#deps.metrics?.recordRun(this.#run.kind, status, Math.max(0, seconds));
    this.#log.info({ status }, 'Run finished');
    return { outcome: 'finished', status };
  }
}

/** The `run.execute` handler (JOB-010). Register it in the worker's handler map. */
export function runHandlers<S>(deps: RunExecutorDeps<S>): JobHandlers {
  return {
    'run.execute': ({ runId }, ctx) =>
      executeRun(deps, runId, { jobId: ctx.job.id, shutdown: ctx.shutdown, log: ctx.log }),
  };
}

/** Wires `analyzeForRun` and the failure marker into a `RunAnalysisPort` (ADR-0343). */
export function createRunAnalysisPort(
  analysisDeps: import('../analysis/analysis.ts').AnalysisDeps,
  analyzeForRun: typeof import('../analysis/fresh.ts').analyzeForRun,
): RunAnalysisPort {
  return {
    run: (migrationId, { signal }) =>
      analyzeForRun(analysisDeps, migrationId, { shutdown: signal }),
    recordFailure: (migrationId) =>
      recordAnalysisFailure(analysisDeps.appPool, migrationId, analysisDeps.log),
  };
}

/** Scrubs the values of a log entry's data; a large one is replaced by a marker (never an error). */
function sanitizeLogData(data: Record<string, unknown>): never {
  const text = JSON.stringify(data);
  if (text.length > MAX_LOG_DATA_CHARS) {
    return { truncated: true, chars: text.length } as never;
  }
  return JSON.parse(JSON.stringify(stripBody(data))) as never;
}
