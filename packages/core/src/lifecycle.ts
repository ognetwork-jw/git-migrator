/**
 * Migration lifecycle state machine (LIF-001, LIF-002, LIF-003).
 *
 * `transition(state, event)` is a pure function over the table in docs/spec/06-migration-lifecycle.md.
 * Any (status, event) pair the table does not list is rejected with a structured error that the
 * caller logs (LIF-003). Accepted-but-unchanged pairs (the "others: unchanged" rows) are successes
 * with `changed: false`. Side effects that touch storage are returned as data (`effects`), never
 * performed. Decisions: docs/adr/0058-lifecycle-edge-cases.md.
 */

export const MIGRATION_STATUSES = [
  'discovered',
  'analyzed',
  'running',
  'migrated',
  'partial',
  'failed',
  'verified',
  'manually_completed',
  'drifted',
  'rolled_back',
  'source_missing',
] as const;
export type MigrationStatus = (typeof MIGRATION_STATUSES)[number];

export const RUN_KINDS = [
  'migrate',
  'run_anyway',
  'resync',
  'verify',
  'rollback',
  'source_read_only',
  'undo_source_read_only',
] as const;
export type RunKind = (typeof RUN_KINDS)[number];

/** How a Run ended (a `RunStatus` other than `queued` and `running`). */
export const RUN_OUTCOMES = ['succeeded', 'partial', 'failed', 'cancelled'] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

export const LIFECYCLE_EVENT_TYPES = [
  'analysis_completed',
  'run_started',
  'run_finished',
  'parity_equal',
  'parity_different',
  'mark_complete',
  'revoke_complete',
  'source_missing',
  'source_present',
] as const;
export type LifecycleEventType = (typeof LIFECYCLE_EVENT_TYPES)[number];

/** Statuses a finished migrate/run-anyway/resync/rollback Run leaves behind. */
export const LAST_RUN_STATUSES = ['migrated', 'partial', 'failed', 'rolled_back'] as const;
export type LastRunStatus = (typeof LAST_RUN_STATUSES)[number];

/** `status` plus the saved-status fields of `Migration` (LIF-002). */
export interface LifecycleState {
  readonly status: MigrationStatus;
  readonly statusBeforeRun: MigrationStatus | null;
  readonly statusBeforeDrift: MigrationStatus | null;
  readonly statusBeforeManual: MigrationStatus | null;
  readonly statusBeforeMissing: MigrationStatus | null;
}

export type LifecycleEvent =
  | { readonly type: 'analysis_completed' }
  | { readonly type: 'run_started'; readonly kind: RunKind }
  | {
      readonly type: 'run_finished';
      readonly kind: RunKind;
      readonly outcome: Exclude<RunOutcome, 'cancelled'>;
    }
  | {
      readonly type: 'run_finished';
      readonly kind: RunKind;
      readonly outcome: 'cancelled';
      /** Whether this Run recorded any Mutation (`Run.hasMutations`). */
      readonly recordedMutation: boolean;
    }
  | { readonly type: 'parity_equal' }
  | { readonly type: 'parity_different' }
  | { readonly type: 'mark_complete' }
  | {
      readonly type: 'revoke_complete';
      /** The latest parity is all equal and no task is open. */
      readonly parityEqualAndNoOpenTasks: boolean;
      /**
       * The status the last Run left (`Migration` before it became manually completed). Needed
       * only when parity/tasks do not allow `verified` and the saved status was `verified` or
       * `drifted`: LIF-075 restores "the last Run outcome", never `verified`.
       */
      readonly lastRunStatus?: LastRunStatus;
    }
  | { readonly type: 'source_missing' }
  | { readonly type: 'source_present' };

/** Storage side effects the caller must perform in the same transaction. */
export type LifecycleEffect =
  | { readonly type: 'recompute_readiness' }
  | { readonly type: 'set_verified_at' }
  | { readonly type: 'set_source_read_only_applied'; readonly value: boolean }
  | {
      readonly type: 'reset_flags';
      readonly flags: readonly ['targetCreatedByFramework', 'sourceReadOnlyApplied'];
    };

export type TransitionErrorCode =
  | 'not_permitted' // the table does not list this (status, event) pair
  | 'inconsistent_state' // a saved-status field the transition needs is missing or impossible
  | 'invalid_event'; // malformed event or state

export interface TransitionError {
  readonly code: TransitionErrorCode;
  readonly status: string;
  readonly event: string;
  readonly message: string;
}

export type TransitionResult =
  | {
      readonly ok: true;
      readonly state: LifecycleState;
      readonly effects: readonly LifecycleEffect[];
      /** False for the accepted "unchanged" rows. */
      readonly changed: boolean;
      /**
       * True only for `source_missing` while running: accepted, nothing changes, and the caller
       * must remember the event and send it again after `run_finished`. Not a rejection.
       */
      readonly deferred?: true;
    }
  | { readonly ok: false; readonly error: TransitionError };

export class LifecycleError extends Error {
  readonly error: TransitionError;
  constructor(error: TransitionError) {
    super(`${error.code}: ${error.message}`);
    this.name = 'LifecycleError';
    this.error = error;
  }
}

export function initialLifecycleState(): LifecycleState {
  return {
    status: 'discovered',
    statusBeforeRun: null,
    statusBeforeDrift: null,
    statusBeforeManual: null,
    statusBeforeMissing: null,
  };
}

const STATUS_SET: ReadonlySet<string> = new Set(MIGRATION_STATUSES);
const KIND_SET: ReadonlySet<string> = new Set(RUN_KINDS);
const OUTCOME_SET: ReadonlySet<string> = new Set(RUN_OUTCOMES);

/** Statuses a saved-status field may legitimately hold. */
const SAVED_ALLOWED = {
  statusBeforeRun: new Set<MigrationStatus>(
    MIGRATION_STATUSES.filter((s) => s !== 'running' && s !== 'source_missing'),
  ),
  statusBeforeDrift: new Set<MigrationStatus>(['verified', 'manually_completed']),
  statusBeforeManual: new Set<MigrationStatus>(
    MIGRATION_STATUSES.filter(
      (s) => s !== 'running' && s !== 'source_missing' && s !== 'manually_completed',
    ),
  ),
  statusBeforeMissing: new Set<MigrationStatus>(
    MIGRATION_STATUSES.filter((s) => s !== 'running' && s !== 'source_missing'),
  ),
} as const;

type SavedField = keyof typeof SAVED_ALLOWED;

const ok = (
  state: LifecycleState,
  effects: readonly LifecycleEffect[] = [],
  changed = true,
): TransitionResult => ({ ok: true, state, effects, changed });

function fail(
  code: TransitionErrorCode,
  state: LifecycleState,
  eventType: string,
  message: string,
): TransitionResult {
  return { ok: false, error: { code, status: String(state.status), event: eventType, message } };
}

/** Moves to `status`, leaving the saved-status fields as they are. */
const to = (s: LifecycleState, status: MigrationStatus): LifecycleState => ({ ...s, status });

/** Restores a saved status, or reports the inconsistency. */
function restore(
  s: LifecycleState,
  field: SavedField,
  eventType: string,
  effects: readonly LifecycleEffect[] = [],
): TransitionResult {
  const saved = s[field];
  if (saved === null || !SAVED_ALLOWED[field].has(saved)) {
    return fail(
      'inconsistent_state',
      s,
      eventType,
      `${field} is ${saved === null ? 'not set' : `"${saved}"`}, which cannot be restored from "${s.status}"`,
    );
  }
  return ok(to(s, saved), effects);
}

const notPermitted = (s: LifecycleState, e: LifecycleEvent): TransitionResult =>
  fail('not_permitted', s, e.type, `event "${e.type}" is not allowed in status "${s.status}"`);

function validate(state: LifecycleState, event: LifecycleEvent): TransitionResult | null {
  const type = (event as { type?: unknown } | null)?.type;
  const evName = typeof type === 'string' ? type : String(type);
  if (typeof state?.status !== 'string' || !STATUS_SET.has(state.status)) {
    return fail('invalid_event', state ?? initialLifecycleState(), evName, 'unknown status');
  }
  if (typeof type !== 'string' || !(LIFECYCLE_EVENT_TYPES as readonly string[]).includes(type)) {
    return fail('invalid_event', state, evName, 'unknown event type');
  }
  const e = event as Record<string, unknown>;
  if ((type === 'run_started' || type === 'run_finished') && !KIND_SET.has(String(e.kind))) {
    return fail('invalid_event', state, type, 'unknown run kind');
  }
  if (type === 'run_finished') {
    if (!OUTCOME_SET.has(String(e.outcome))) {
      return fail('invalid_event', state, type, 'unknown run outcome');
    }
    if (e.outcome === 'cancelled' && typeof e.recordedMutation !== 'boolean') {
      return fail('invalid_event', state, type, 'a cancelled Run needs recordedMutation');
    }
  }
  if (type === 'revoke_complete' && typeof e.parityEqualAndNoOpenTasks !== 'boolean') {
    return fail('invalid_event', state, type, 'revoke_complete needs parityEqualAndNoOpenTasks');
  }
  return null;
}

function finishRun(s: LifecycleState, e: Extract<LifecycleEvent, { type: 'run_finished' }>) {
  if (s.status !== 'running') return notPermitted(s, e);
  const { kind, outcome } = e;
  const back = (effects: readonly LifecycleEffect[] = []) =>
    restore(s, 'statusBeforeRun', e.type, effects);

  // Kind-specific "any outcome" rows win over the generic cancelled row (ADR-0058).
  if (kind === 'verify') return back();
  if (kind === 'source_read_only' || kind === 'undo_source_read_only') {
    return back(
      outcome === 'succeeded'
        ? [{ type: 'set_source_read_only_applied', value: kind === 'source_read_only' }]
        : [],
    );
  }
  if (e.outcome === 'cancelled') return e.recordedMutation ? ok(to(s, 'partial')) : back();

  if (kind === 'rollback') {
    if (outcome === 'succeeded') {
      return ok(to(s, 'rolled_back'), [
        { type: 'reset_flags', flags: ['targetCreatedByFramework', 'sourceReadOnlyApplied'] },
      ]);
    }
    return ok(to(s, 'partial')); // failed | partial
  }
  // migrate | run_anyway | resync
  return ok(
    to(s, outcome === 'succeeded' ? 'migrated' : outcome === 'partial' ? 'partial' : 'failed'),
  );
}

/** Applies `event` to `state`. Pure; never throws for a well-typed or malformed event. */
export function transition(state: LifecycleState, event: LifecycleEvent): TransitionResult {
  const invalid = validate(state, event);
  if (invalid !== null) return invalid;
  const s = state;
  const status = s.status;

  switch (event.type) {
    case 'analysis_completed': {
      const next = status === 'discovered' || status === 'rolled_back' ? to(s, 'analyzed') : s;
      return ok(next, [{ type: 'recompute_readiness' }], next !== s);
    }
    case 'run_started':
      if (status === 'running' || status === 'source_missing') return notPermitted(s, event);
      return ok({ ...s, status: 'running', statusBeforeRun: status });
    case 'run_finished':
      return finishRun(s, event);
    case 'parity_equal':
      if (status === 'migrated' || status === 'partial') {
        return ok(to(s, 'verified'), [{ type: 'set_verified_at' }]);
      }
      if (status === 'drifted') return restore(s, 'statusBeforeDrift', event.type);
      return ok(s, [], false);
    case 'parity_different':
      if (status === 'verified' || status === 'manually_completed') {
        return ok({ ...s, status: 'drifted', statusBeforeDrift: status });
      }
      return ok(s, [], false);
    case 'mark_complete':
      if (status === 'running' || status === 'source_missing' || status === 'manually_completed') {
        return notPermitted(s, event);
      }
      return ok({ ...s, status: 'manually_completed', statusBeforeManual: status });
    case 'revoke_complete':
      if (status !== 'manually_completed') return notPermitted(s, event);
      if (event.parityEqualAndNoOpenTasks) return ok(to(s, 'verified'));
      // LIF-075 beats the LIF-002 "else statusBeforeManual" cell (ADR-0058): never fall back to
      // `verified` (or `drifted`, which presupposes a verification) when parity/tasks disagree.
      if (s.statusBeforeManual === 'verified' || s.statusBeforeManual === 'drifted') {
        const last = event.lastRunStatus;
        if (last === undefined || !(LAST_RUN_STATUSES as readonly string[]).includes(last)) {
          return fail(
            'inconsistent_state',
            s,
            event.type,
            `revoking from "${s.statusBeforeManual}" without parity needs lastRunStatus`,
          );
        }
        return ok(to(s, last));
      }
      return restore(s, 'statusBeforeManual', event.type);
    case 'source_missing':
      if (status === 'running') {
        return { ok: true, state: s, effects: [], changed: false, deferred: true };
      }
      // Already missing: keep the saved status, or source_present could never leave the state.
      if (status === 'source_missing') return ok(s, [], false);
      return ok({ ...s, status: 'source_missing', statusBeforeMissing: status });
    case 'source_present':
      if (status !== 'source_missing') return notPermitted(s, event);
      return restore(s, 'statusBeforeMissing', event.type);
  }
}

/** Like `transition`, but throws `LifecycleError` on rejection. */
export function transitionOrThrow(
  state: LifecycleState,
  event: LifecycleEvent,
): Extract<TransitionResult, { ok: true }> {
  const result = transition(state, event);
  if (!result.ok) throw new LifecycleError(result.error);
  return result;
}

/** "Unmigrated" (the default Repositories filter): status not in {verified, manually_completed}. */
export function isUnmigrated(status: MigrationStatus): boolean {
  return status !== 'verified' && status !== 'manually_completed';
}
