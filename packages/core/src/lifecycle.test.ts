import { describe, expect, it } from 'vitest';
import {
  initialLifecycleState,
  isUnmigrated,
  LIFECYCLE_EVENT_TYPES,
  type LifecycleEffect,
  LifecycleError,
  type LifecycleEvent,
  type LifecycleState,
  MIGRATION_STATUSES,
  type MigrationStatus,
  RUN_KINDS,
  RUN_OUTCOMES,
  type RunKind,
  type RunOutcome,
  type TransitionErrorCode,
  transition,
  transitionOrThrow,
} from './lifecycle.ts';

/** All four saved fields hold distinct, individually valid values so a wrong pick is visible. */
const BASE = {
  statusBeforeRun: 'drifted',
  statusBeforeDrift: 'manually_completed',
  statusBeforeManual: 'analyzed',
  statusBeforeMissing: 'discovered',
} as const satisfies Omit<LifecycleState, 'status'>;

const at = (status: MigrationStatus): LifecycleState => Object.freeze({ status, ...BASE });

// --- every event variant -------------------------------------------------------------------
const finishedEvents: LifecycleEvent[] = RUN_KINDS.flatMap((kind) => [
  ...(['succeeded', 'partial', 'failed'] as const).map(
    (outcome): LifecycleEvent => ({ type: 'run_finished', kind, outcome }),
  ),
  { type: 'run_finished', kind, outcome: 'cancelled', recordedMutation: true },
  { type: 'run_finished', kind, outcome: 'cancelled', recordedMutation: false },
]);
const ALL_EVENTS: LifecycleEvent[] = [
  { type: 'analysis_completed' },
  ...RUN_KINDS.map((kind): LifecycleEvent => ({ type: 'run_started', kind })),
  ...finishedEvents,
  { type: 'parity_equal' },
  { type: 'parity_different' },
  { type: 'mark_complete' },
  { type: 'revoke_complete', parityEqualAndNoOpenTasks: true },
  { type: 'revoke_complete', parityEqualAndNoOpenTasks: false },
  { type: 'source_missing' },
  { type: 'source_present' },
];

// --- the oracle: the spec table (docs/spec/06-migration-lifecycle.md), written independently ---
type Expect =
  | { reject: TransitionErrorCode }
  | {
      to: MigrationStatus;
      patch?: Partial<LifecycleState>;
      effects?: LifecycleEffect[];
      changed?: boolean;
      deferred?: true;
    };

const RESET: LifecycleEffect = {
  type: 'reset_flags',
  flags: ['targetCreatedByFramework', 'sourceReadOnlyApplied'],
};

function oracle(from: MigrationStatus, ev: LifecycleEvent): Expect {
  switch (ev.type) {
    case 'analysis_completed': {
      const to = from === 'discovered' || from === 'rolled_back' ? 'analyzed' : from;
      return { to, effects: [{ type: 'recompute_readiness' }], changed: to !== from };
    }
    case 'run_started':
      return from === 'running' || from === 'source_missing'
        ? { reject: 'not_permitted' }
        : { to: 'running', patch: { statusBeforeRun: from } };
    case 'run_finished': {
      if (from !== 'running') return { reject: 'not_permitted' };
      const back = BASE.statusBeforeRun;
      const { kind } = ev;
      if (kind === 'verify') return { to: back };
      if (kind === 'source_read_only' || kind === 'undo_source_read_only') {
        return {
          to: back,
          effects:
            ev.outcome === 'succeeded'
              ? [{ type: 'set_source_read_only_applied', value: kind === 'source_read_only' }]
              : [],
        };
      }
      if (ev.outcome === 'cancelled') return { to: ev.recordedMutation ? 'partial' : back };
      if (kind === 'rollback') {
        return ev.outcome === 'succeeded'
          ? { to: 'rolled_back', effects: [RESET] }
          : { to: 'partial' };
      }
      return {
        to: { succeeded: 'migrated', partial: 'partial', failed: 'failed' }[
          ev.outcome
        ] as MigrationStatus,
      };
    }
    case 'parity_equal':
      if (from === 'migrated' || from === 'partial') {
        return { to: 'verified', effects: [{ type: 'set_verified_at' }] };
      }
      if (from === 'drifted') return { to: BASE.statusBeforeDrift };
      return { to: from, changed: false };
    case 'parity_different':
      return from === 'verified' || from === 'manually_completed'
        ? { to: 'drifted', patch: { statusBeforeDrift: from } }
        : { to: from, changed: false };
    case 'mark_complete':
      return ['running', 'source_missing', 'manually_completed'].includes(from)
        ? { reject: 'not_permitted' }
        : { to: 'manually_completed', patch: { statusBeforeManual: from } };
    case 'revoke_complete':
      if (from !== 'manually_completed') return { reject: 'not_permitted' };
      return { to: ev.parityEqualAndNoOpenTasks ? 'verified' : BASE.statusBeforeManual };
    case 'source_missing':
      if (from === 'running') return { to: 'running', changed: false, deferred: true };
      if (from === 'source_missing') return { to: from, changed: false };
      return { to: 'source_missing', patch: { statusBeforeMissing: from } };
    case 'source_present':
      return from === 'source_missing'
        ? { to: BASE.statusBeforeMissing }
        : { reject: 'not_permitted' };
  }
}

const label = (ev: LifecycleEvent): string => JSON.stringify(ev);
const eventKey = (ev: LifecycleEvent): string =>
  ev.type === 'run_started'
    ? `${ev.type}:${ev.kind}`
    : ev.type === 'run_finished'
      ? `${ev.type}:${ev.kind}:${ev.outcome}`
      : ev.type;

describe('[LIF-001] statuses', () => {
  it('[LIF-001] defines exactly the eleven statuses of the spec table', () => {
    expect([...MIGRATION_STATUSES]).toEqual([
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
    ]);
  });

  it('[LIF-001] a new Migration starts discovered with no saved statuses', () => {
    expect(initialLifecycleState()).toEqual({
      status: 'discovered',
      statusBeforeRun: null,
      statusBeforeDrift: null,
      statusBeforeManual: null,
      statusBeforeMissing: null,
    });
  });

  it('[LIF-001] "unmigrated" means status not in {verified, manually_completed}', () => {
    for (const s of MIGRATION_STATUSES) {
      expect(isUnmigrated(s)).toBe(s !== 'verified' && s !== 'manually_completed');
    }
  });

  it('[LIF-001] covers the Run kinds and outcomes of the data model', () => {
    expect([...RUN_KINDS]).toEqual([
      'migrate',
      'run_anyway',
      'resync',
      'verify',
      'rollback',
      'source_read_only',
      'undo_source_read_only',
    ]);
    expect([...RUN_OUTCOMES]).toEqual(['succeeded', 'partial', 'failed', 'cancelled']);
    expect([...LIFECYCLE_EVENT_TYPES]).toHaveLength(9);
  });
});

describe('[LIF-002] transitions: the full status x event cross-product', () => {
  const rows = MIGRATION_STATUSES.flatMap((from) => ALL_EVENTS.map((ev) => [from, ev] as const));

  it('[LIF-002] generates 11 statuses x every event variant', () => {
    expect(ALL_EVENTS).toHaveLength(1 + 7 + 7 * 5 + 2 + 1 + 2 + 2);
    expect(rows).toHaveLength(MIGRATION_STATUSES.length * ALL_EVENTS.length);
  });

  it.each(rows)('[LIF-002] [LIF-003] %s + %o matches the spec table', (from, ev) => {
    const expected = oracle(from, ev);
    const result = transition(at(from), ev);
    if ('reject' in expected) {
      expect(result.ok, label(ev)).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(expected.reject);
        expect(result.error.status).toBe(from);
        expect(result.error.event).toBe(ev.type);
      }
      return;
    }
    expect(result.ok, label(ev)).toBe(true);
    if (!result.ok) return;
    expect(result.state).toEqual({ ...at(from), status: expected.to, ...expected.patch });
    expect(result.effects).toEqual(expected.effects ?? []);
    expect(result.changed).toBe(expected.changed ?? true);
    expect(result.deferred).toBe(expected.deferred);
  });

  it('[LIF-002] accepts exactly 145 distinct (status, event) pairs and rejects the rest', () => {
    const accepted = new Set<string>();
    const rejected = new Set<string>();
    for (const [from, ev] of rows) {
      (transition(at(from), ev).ok ? accepted : rejected).add(`${from}|${eventKey(ev)}`);
    }
    // analysis 11 + run_started 9x7 + run_finished 28 (running only) + parity 11 + 11
    // + mark_complete 8 + revoke 1 + source_missing 10 + source_present 1
    expect(accepted.size).toBe(11 + 63 + 28 + 11 + 11 + 8 + 1 + 11 + 1);
    expect(accepted.size).toBe(145);
    expect(accepted.size + rejected.size).toBe(MIGRATION_STATUSES.length * 42);
  });

  it('[LIF-003] every unlisted pair is rejected, as a value, without throwing', () => {
    const listed = (from: MigrationStatus, ev: LifecycleEvent): boolean =>
      !('reject' in oracle(from, ev));
    let rejections = 0;
    for (const [from, ev] of rows) {
      if (listed(from, ev)) continue;
      rejections++;
      const result = transition(at(from), ev);
      expect(result.ok).toBe(false);
    }
    expect(rejections).toBeGreaterThan(300);
  });

  it('[LIF-003] a run can only finish while running', () => {
    for (const s of MIGRATION_STATUSES.filter((x) => x !== 'running')) {
      for (const ev of finishedEvents)
        expect(transition(at(s), ev).ok, `${s} ${label(ev)}`).toBe(false);
    }
  });

  it('[LIF-003] source_missing while running is accepted as deferred: no change, not a rejection', () => {
    const r = transition(at('running'), { type: 'source_missing' });
    expect(r).toEqual({
      ok: true,
      state: at('running'),
      effects: [],
      changed: false,
      deferred: true,
    });
  });

  it('[LIF-003] rejection reports are structured for logging and never alter the input', () => {
    const state = at('verified');
    const r = transition(state, { type: 'source_present' });
    expect(r).toEqual({
      ok: false,
      error: {
        code: 'not_permitted',
        status: 'verified',
        event: 'source_present',
        message: 'event "source_present" is not allowed in status "verified"',
      },
    });
    expect(state).toEqual(at('verified'));
  });

  it('[LIF-003] transitionOrThrow throws LifecycleError carrying the structured error', () => {
    expect(() =>
      transitionOrThrow(at('running'), { type: 'run_started', kind: 'migrate' }),
    ).toThrow(LifecycleError);
    try {
      transitionOrThrow(at('running'), { type: 'run_started', kind: 'migrate' });
    } catch (e) {
      expect((e as LifecycleError).error.code).toBe('not_permitted');
      expect((e as Error).message).toMatch(/^not_permitted:/);
    }
    expect(transitionOrThrow(at('discovered'), { type: 'analysis_completed' }).state.status).toBe(
      'analyzed',
    );
  });
});

describe('[LIF-002] saved statuses and edge rows', () => {
  const E = {
    start: (kind: RunKind): LifecycleEvent => ({ type: 'run_started', kind }),
    done: (kind: RunKind, outcome: Exclude<RunOutcome, 'cancelled'>): LifecycleEvent => ({
      type: 'run_finished',
      kind,
      outcome,
    }),
  };
  const run = (state: LifecycleState, ...events: LifecycleEvent[]): LifecycleState =>
    events.reduce((s, ev) => transitionOrThrow(s, ev).state, state);

  it('[LIF-002] a Run records the status it started from and restores it on verify/cancel', () => {
    for (const from of MIGRATION_STATUSES.filter(
      (s) => s !== 'running' && s !== 'source_missing',
    )) {
      const started = run(at(from), E.start('verify'));
      expect(started.statusBeforeRun).toBe(from);
      expect(run(started, E.done('verify', 'failed')).status).toBe(from);
      expect(
        run(started, {
          type: 'run_finished',
          kind: 'migrate',
          outcome: 'cancelled',
          recordedMutation: false,
        }).status,
      ).toBe(from);
      expect(
        run(started, {
          type: 'run_finished',
          kind: 'migrate',
          outcome: 'cancelled',
          recordedMutation: true,
        }).status,
      ).toBe('partial');
    }
  });

  it('[LIF-002] source read-only Runs update sourceReadOnlyApplied only on success', () => {
    const start = (k: RunKind) => run(at('verified'), E.start(k));
    const effectsOf = (k: RunKind, o: Exclude<RunOutcome, 'cancelled'>) =>
      transitionOrThrow(start(k), E.done(k, o)).effects;
    expect(effectsOf('source_read_only', 'succeeded')).toEqual([
      { type: 'set_source_read_only_applied', value: true },
    ]);
    expect(effectsOf('undo_source_read_only', 'succeeded')).toEqual([
      { type: 'set_source_read_only_applied', value: false },
    ]);
    for (const o of ['partial', 'failed'] as const) {
      expect(effectsOf('source_read_only', o)).toEqual([]);
      expect(effectsOf('undo_source_read_only', o)).toEqual([]);
    }
    const cancelled = transitionOrThrow(start('source_read_only'), {
      type: 'run_finished',
      kind: 'source_read_only',
      outcome: 'cancelled',
      recordedMutation: true,
    });
    expect(cancelled.effects).toEqual([]);
    expect(cancelled.state.status).toBe('verified');
  });

  it('[LIF-002] happy path: discovered to verified, then drift, accept and resync', () => {
    let s = initialLifecycleState();
    s = run(s, { type: 'analysis_completed' }, E.start('migrate'), E.done('migrate', 'succeeded'));
    expect(s.status).toBe('migrated');
    s = run(s, { type: 'parity_equal' });
    expect(s.status).toBe('verified');
    s = run(s, { type: 'parity_different' });
    expect(s).toMatchObject({ status: 'drifted', statusBeforeDrift: 'verified' });
    s = run(s, { type: 'parity_equal' }); // accepted differences
    expect(s.status).toBe('verified');
    s = run(s, { type: 'parity_different' }, E.start('resync'), E.done('resync', 'succeeded'));
    expect(s.status).toBe('migrated');
    s = run(s, { type: 'parity_equal' });
    expect(s.status).toBe('verified');
  });

  it('[LIF-002] manual completion: from drifted, revoke back, and revoke to verified', () => {
    let s = run(at('drifted'), { type: 'mark_complete' });
    expect(s).toMatchObject({ status: 'manually_completed', statusBeforeManual: 'drifted' });
    expect(
      run(s, {
        type: 'revoke_complete',
        parityEqualAndNoOpenTasks: false,
        lastRunStatus: 'migrated',
      }).status,
    ).toBe('migrated'); // LIF-075: never back to a verification that no longer holds
    expect(run(s, { type: 'revoke_complete', parityEqualAndNoOpenTasks: true }).status).toBe(
      'verified',
    );
    // manually completed then drift: remembers manually_completed as the way back
    s = run(s, { type: 'parity_different' });
    expect(s).toMatchObject({ status: 'drifted', statusBeforeDrift: 'manually_completed' });
    expect(run(s, { type: 'parity_equal' }).status).toBe('manually_completed');
  });

  it('[LIF-002] a source that vanishes and returns restores the exact prior status', () => {
    for (const from of MIGRATION_STATUSES.filter(
      (x) => x !== 'running' && x !== 'source_missing',
    )) {
      const gone = run(at(from), { type: 'source_missing' });
      expect(gone).toMatchObject({ status: 'source_missing', statusBeforeMissing: from });
      expect(run(gone, { type: 'source_present' }).status).toBe(from);
    }
  });

  it('[LIF-002] a repeated source_missing keeps the original prior status (no trap state)', () => {
    const gone = run(at('verified'), { type: 'source_missing' }, { type: 'source_missing' });
    expect(gone.statusBeforeMissing).toBe('verified');
    expect(run(gone, { type: 'source_present' }).status).toBe('verified');
  });

  it('[LIF-002] source_missing during a Run is deferred, then applies after run_finished', () => {
    const running = run(at('migrated'), E.start('verify'));
    expect(transition(running, { type: 'source_missing' })).toMatchObject({
      ok: true,
      changed: false,
      deferred: true,
    });
    const after = run(running, E.done('verify', 'succeeded'), { type: 'source_missing' });
    expect(after).toMatchObject({ status: 'source_missing', statusBeforeMissing: 'migrated' });
  });

  it('[LIF-002] a rollback that succeeds resets flags; analysis then returns it to analyzed', () => {
    let s = run(at('verified'), E.start('rollback'));
    const fin = transitionOrThrow(s, E.done('rollback', 'succeeded'));
    expect(fin.state.status).toBe('rolled_back');
    expect(fin.effects).toEqual([RESET]);
    s = run(fin.state, { type: 'analysis_completed' });
    expect(s.status).toBe('analyzed');
  });

  it('[LIF-002] analysis_completed always asks for readiness to be recomputed', () => {
    for (const s of MIGRATION_STATUSES) {
      expect(transitionOrThrow(at(s), { type: 'analysis_completed' }).effects).toEqual([
        { type: 'recompute_readiness' },
      ]);
    }
  });

  it('[LIF-002] keeps saved statuses untouched except where the table assigns them', () => {
    const r = transitionOrThrow(at('failed'), { type: 'mark_complete' }).state;
    expect({ ...r, statusBeforeManual: null, status: 'x' }).toEqual({
      ...at('failed'),
      statusBeforeManual: null,
      status: 'x',
    });
  });
});

describe('[LIF-002] revoke_complete never restores verified without parity (LIF-075)', () => {
  const revoke = (
    s: LifecycleState,
    eq: boolean,
    last?: 'migrated' | 'partial' | 'failed' | 'rolled_back',
  ) =>
    transition(s, { type: 'revoke_complete', parityEqualAndNoOpenTasks: eq, lastRunStatus: last });

  it('[LIF-075] verified, mark_complete, task reopened, revoke: the last Run outcome, not verified', () => {
    const marked = transitionOrThrow(at('verified'), { type: 'mark_complete' }).state;
    expect(marked).toMatchObject({ status: 'manually_completed', statusBeforeManual: 'verified' });
    for (const last of ['migrated', 'partial', 'failed', 'rolled_back'] as const) {
      const r = revoke(marked, false, last);
      expect(r).toMatchObject({ ok: true, state: { status: last } });
    }
    expect(revoke(marked, true)).toMatchObject({ ok: true, state: { status: 'verified' } });
  });

  it('[LIF-075] drifted presupposes a verification, so it is not restored blindly either', () => {
    const marked = transitionOrThrow(at('drifted'), { type: 'mark_complete' }).state;
    expect(revoke(marked, false, 'partial')).toMatchObject({
      ok: true,
      state: { status: 'partial' },
    });
  });

  it('[LIF-075] without lastRunStatus (or with a bogus one) it fails closed', () => {
    const marked = transitionOrThrow(at('verified'), { type: 'mark_complete' }).state;
    expect(revoke(marked, false)).toMatchObject({
      ok: false,
      error: { code: 'inconsistent_state' },
    });
    expect(revoke(marked, false, 'verified' as never)).toMatchObject({
      ok: false,
      error: { code: 'inconsistent_state' },
    });
  });

  it('[LIF-075] other saved statuses are restored as before and ignore lastRunStatus', () => {
    const marked = transitionOrThrow(at('failed'), { type: 'mark_complete' }).state;
    expect(revoke(marked, false, 'migrated')).toMatchObject({
      ok: true,
      state: { status: 'failed' },
    });
  });
});

describe('[LIF-003] inconsistent and malformed input is rejected, never guessed', () => {
  const bad = (state: Partial<LifecycleState> & { status: MigrationStatus }): LifecycleState => ({
    ...initialLifecycleState(),
    ...state,
  });

  it('[LIF-003] refuses to restore a missing or impossible saved status', () => {
    const cases: [LifecycleState, LifecycleEvent][] = [
      [bad({ status: 'running' }), { type: 'run_finished', kind: 'verify', outcome: 'succeeded' }],
      [
        bad({ status: 'running' }),
        { type: 'run_finished', kind: 'migrate', outcome: 'cancelled', recordedMutation: false },
      ],
      [
        bad({ status: 'running', statusBeforeRun: 'running' }),
        { type: 'run_finished', kind: 'verify', outcome: 'failed' },
      ],
      [
        bad({ status: 'running', statusBeforeRun: 'source_missing' }),
        { type: 'run_finished', kind: 'source_read_only', outcome: 'failed' },
      ],
      [bad({ status: 'drifted' }), { type: 'parity_equal' }],
      [bad({ status: 'drifted', statusBeforeDrift: 'migrated' }), { type: 'parity_equal' }],
      [
        bad({ status: 'manually_completed' }),
        { type: 'revoke_complete', parityEqualAndNoOpenTasks: false },
      ],
      [
        bad({ status: 'manually_completed', statusBeforeManual: 'manually_completed' }),
        { type: 'revoke_complete', parityEqualAndNoOpenTasks: false },
      ],
      [bad({ status: 'source_missing' }), { type: 'source_present' }],
      [
        bad({ status: 'source_missing', statusBeforeMissing: 'source_missing' }),
        { type: 'source_present' },
      ],
      [
        bad({ status: 'source_missing', statusBeforeMissing: 'running' }),
        { type: 'source_present' },
      ],
    ];
    for (const [state, ev] of cases) {
      const r = transition(state, ev);
      expect(r, `${state.status} ${label(ev)}`).toMatchObject({
        ok: false,
        error: { code: 'inconsistent_state' },
      });
    }
  });

  it('[LIF-003] a missing saved status is irrelevant where it is not read', () => {
    expect(
      transition(bad({ status: 'running' }), {
        type: 'run_finished',
        kind: 'migrate',
        outcome: 'failed',
      }).ok,
    ).toBe(true);
    expect(
      transition(bad({ status: 'manually_completed' }), {
        type: 'revoke_complete',
        parityEqualAndNoOpenTasks: true,
      }).ok,
    ).toBe(true);
  });

  it('[LIF-003] rejects unknown events, kinds, outcomes and statuses', () => {
    const s = at('running');
    const events = [
      { type: 'explode' },
      { type: undefined },
      null,
      { type: 'run_started', kind: 'nuke' },
      { type: 'run_started' },
      { type: 'run_finished', kind: 'migrate', outcome: 'exploded' },
      { type: 'run_finished', kind: 'nuke', outcome: 'failed' },
      { type: 'run_finished', kind: 'migrate', outcome: 'cancelled' },
      { type: 'run_finished', kind: 'migrate', outcome: 'cancelled', recordedMutation: 'yes' },
      { type: 'revoke_complete' },
      { type: 'revoke_complete', parityEqualAndNoOpenTasks: 1 },
    ] as unknown as LifecycleEvent[];
    for (const ev of events) {
      expect(transition(s, ev), label(ev)).toMatchObject({
        ok: false,
        error: { code: 'invalid_event' },
      });
    }
    expect(
      transition({ ...s, status: 'bogus' as MigrationStatus }, { type: 'parity_equal' }),
    ).toMatchObject({
      ok: false,
      error: { code: 'invalid_event' },
    });
    expect(transition(null as unknown as LifecycleState, { type: 'parity_equal' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_event' },
    });
  });
});
