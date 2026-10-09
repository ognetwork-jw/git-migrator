/**
 * The Run executor's public vocabulary (LIF-040): how a task registers the Steps of a Run kind,
 * and what a Step may do. Decisions: docs/adr/0340-run-executor-framework.md.
 */
import type { LedgerOrigin, LedgerRecord, LedgerSide, RunKind } from '@git-migrator/core';
import type { Db } from '@git-migrator/db';
import type { Logger } from '@git-migrator/observability';

/** The transaction client a fenced write receives. */
export type Tx = Pick<
  Db,
  | 'run'
  | 'runStep'
  | 'runLog'
  | 'migration'
  | 'manualTask'
  | 'planItem'
  | 'parityResult'
  | 'auditEvent'
  | '$executeRaw'
  | '$queryRaw'
>;

/**
 * What a failure of the Step does to the Run (LIF-042):
 * - `fatal`: steps 1 to 5. A non-retryable failure ends the Run `failed`; later Steps are `skipped`.
 * - `independent`: steps 6 to 12 and 14. The failure is recorded, later Steps still run, and the Run
 *   ends `partial`.
 * - `advisory`: step 13 (verify). The failure is recorded on the Step only; it never changes the Run.
 */
export type StepSeverity = 'fatal' | 'independent' | 'advisory';

export type StepResult =
  | { readonly status: 'succeeded'; readonly detail?: Readonly<Record<string, unknown>> }
  /** Nothing to do (a condition of LIF-040 does not hold). `reason` goes to the Run log. */
  | { readonly status: 'skipped'; readonly reason: string }
  /**
   * Pause the Run: the job is released and `run.execute` is enqueued again after `delayMs`; the Run
   * resumes at this Step (rate limit, JOB-044; not enough scratch space, JOB-015). `ctx.step.delays`
   * counts the earlier delays of this Step.
   */
  | { readonly status: 'delay'; readonly delayMs: number; readonly reason: string };

export interface StepDefinition<S = unknown> {
  /** Stable key, for example `git.push-refs` or `facet.webhooks.apply` (LIF-040). */
  readonly key: string;
  readonly facetKey?: string | null;
  readonly severity: StepSeverity;
  /**
   * Retry budget: the Step fails after this many attempts that ended in a retryable error or a
   * worker crash, counted over every resume (default `DEFAULT_MAX_ATTEMPTS`). A `rate_limited`
   * error or a `delay` result is not an attempt: it delays the Run (ADR-0341).
   */
  readonly maxAttempts?: number;
  /**
   * Run-origin blocker codes cleared when this Step succeeds (LIF-049: "cleared when a later Run's
   * `git.prepare` (or the relevant step) passes").
   */
  readonly clearsBlockers?: readonly string[];
  /**
   * Idempotent: a Step runs again after a crash, a lost lease or a delay, and must change only what
   * differs. Check `ctx.signal` during long work; throw to fail the Step.
   */
  run(ctx: StepContext<S>): Promise<StepResult | undefined>;
}

export interface RunSnapshot {
  readonly id: string;
  readonly kind: RunKind;
  readonly migrationId: string;
  readonly analysisId: string | null;
  readonly triggeredById: string;
  readonly options: Readonly<Record<string, unknown>>;
}

export interface MigrationSnapshot {
  readonly id: string;
  readonly routeId: string;
  readonly scope: 'repository' | 'endpoint';
  readonly sourceRepositoryId: string | null;
  readonly targetRepositoryId: string | null;
  readonly plannedTargetName: string | null;
  readonly targetCreatedByFramework: boolean;
  readonly sourceReadOnlyApplied: boolean;
}

export interface LedgerWrite {
  readonly side: LedgerSide;
  /** `desired` for a Facet `apply`; `framework` for resources the desired document lacks. */
  readonly origin: LedgerOrigin;
  /** Explicit parity paths for a record with no `facetKey` (LIF-045). */
  readonly differences?: readonly { readonly facetKey: string; readonly path: string }[];
}

/** An adapter `MutationRecord`, as the ledger takes it. */
export type MutationLike = LedgerRecord;

export interface OpenIntent {
  readonly id: string;
  readonly side: LedgerSide;
  readonly facetKey: string | null;
  readonly action: 'create' | 'update' | 'delete';
  readonly resourceRef: Record<string, unknown>;
  readonly paths: readonly string[];
  readonly before: unknown;
  readonly after: unknown;
}

export interface StepLedger {
  /** Persists the records in one transaction before returning (LIF-045). */
  record(write: LedgerWrite, records: readonly MutationLike[]): Promise<void>;
  /**
   * Persists each record the moment `apply` yields it, so the records of the changes made before a
   * failure still reach the ledger when the iteration throws (ADP-011, ADR-0222).
   */
  recordAll(write: LedgerWrite, records: AsyncIterable<MutationLike>): Promise<number>;
  /**
   * Writes an intent before a provider call whose outcome could be lost (a timeout, a crash): the
   * record is stored `intended`, and rollback treats an unconfirmed intent as possibly applied
   * (ADR-0342). Returns its id for `confirm`.
   */
  intend(write: LedgerWrite, record: MutationLike): Promise<string>;
  /**
   * The intents of this Step that were never confirmed, oldest first. A resumed Step reconciles
   * them first: read the provider, then `confirm` each as applied or not applied (ADR-0342).
   */
  openIntents(): Promise<readonly OpenIntent[]>;
  /**
   * Settles an intent after the call: `applied` (optionally with the record of what really
   * happened) or `not_applied`.
   */
  confirm(id: string, outcome: 'applied' | 'not_applied', actual?: MutationLike): Promise<void>;
}

export interface RunFindingInput {
  readonly code: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface StepFindings {
  /** Stores a run-origin blocker in `Migration.runBlockers` and recomputes readiness (LIF-049). */
  addBlocker(finding: RunFindingInput): Promise<void>;
  /** Clears run-origin blockers whose code is listed (a later Run's step passed, LIF-049). */
  clearBlockers(codes: readonly string[]): Promise<void>;
  /** Stores a run-origin ManualTask and recomputes readiness (LIF-049). Idempotent. */
  addTask(
    finding: RunFindingInput & {
      readonly facetKey: string;
      readonly phase: 'pre' | 'post';
      readonly verifiable?: boolean;
    },
  ): Promise<void>;
}

export interface StepContext<S = unknown> {
  readonly run: RunSnapshot;
  /** Read fresh when the Step starts. */
  readonly migration: MigrationSnapshot;
  readonly step: {
    readonly id: string;
    readonly key: string;
    readonly facetKey: string | null;
    /** This attempt's number, over every resume. */
    readonly attempt: number;
    /** How often this Step already delayed the Run. */
    readonly delays: number;
  };
  /**
   * Aborted when cancel was requested or the lease was lost. A Step passes it to everything that
   * waits (provider calls, git) and stops when it aborts. A SIGTERM does not abort it: the Step
   * finishes first (LIF-046).
   */
  readonly signal: AbortSignal;
  readonly log: Logger;
  /** Services of the process (adapters, git, scratch) injected by the worker wiring. */
  readonly services: S;
  /**
   * This job's scratch directory (JOB-015), removed when the job ends: after a delay or a hand-off
   * the next job starts with an empty one, so a Step that needs files rebuilds them. Absent when the
   * executor runs without scratch handling.
   */
  readonly scratchDir: string | undefined;
  readonly ledger: StepLedger;
  readonly findings: StepFindings;
  /** Appends to the Run log and publishes `run.log` (JOB-060). */
  runLog(
    level: 'info' | 'warn' | 'error',
    message: string,
    data?: Record<string, unknown>,
  ): Promise<void>;
  /**
   * Throws `RunCancelledError` or `RunLeaseLostError` when the Run must stop. Call it between units
   * of work that do not take the signal.
   */
  checkpoint(): void;
  /**
   * Runs `fn` in a transaction that first locks the Run row under this worker's lease, so a worker
   * that lost the lease writes nothing. With `{ migration: true }` the Migration row is locked
   * first: lock order is always Migration row, then Run row (ADR-0340), so a Step that updates
   * the Migration must pass it, or it can deadlock with cancel and finish.
   */
  transaction<T>(
    fn: (tx: Tx) => Promise<T>,
    options?: { readonly migration?: boolean },
  ): Promise<T>;
}

export interface RunPlanInput {
  readonly run: RunSnapshot;
  readonly migration: MigrationSnapshot;
}

export interface RunPlanner<S = unknown> {
  /**
   * The Steps of a Run, in order. Called when the Run starts, and again on every resume, which must
   * give the same keys: the stored Step rows are authoritative for status and order.
   */
  steps(input: RunPlanInput): readonly StepDefinition<S>[] | Promise<readonly StepDefinition<S>[]>;
}

export const DEFAULT_MAX_ATTEMPTS = 4;

export class RunStepRegistry<S = unknown> {
  readonly #planners = new Map<RunKind, RunPlanner<S>>();

  /** Registers the planner of `kind`. T-071 and later tasks call this once per kind at start-up. */
  register(kind: RunKind, planner: RunPlanner<S>): this {
    if (this.#planners.has(kind)) throw new Error(`Run kind ${kind} already has a planner`);
    this.#planners.set(kind, planner);
    return this;
  }

  planner(kind: RunKind): RunPlanner<S> | undefined {
    return this.#planners.get(kind);
  }

  has(kind: RunKind): boolean {
    return this.#planners.has(kind);
  }
}

/** The Run must stop: cancel was requested. */
export class RunCancelledError extends Error {
  constructor() {
    super('Run cancelled');
    this.name = 'RunCancelledError';
  }
}

/** The worker no longer holds the Run's lease: stop without writing (LIF-046). */
export class RunLeaseLostError extends Error {
  constructor() {
    super('Run lease lost');
    this.name = 'RunLeaseLostError';
  }
}
