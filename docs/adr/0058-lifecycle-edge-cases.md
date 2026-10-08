# ADR-0058: Lifecycle state machine edge cases

- Status: accepted (spec updated)
- Date: 2026-10-08

## Context

The LIF-002 table is exhaustive for the pairs it lists, but a few rows overlap, one is self-defeating, and storage effects need a representation.

## Decision

- **API.** `transition(state, event)` returns `{ ok: true, state, effects, changed }` or `{ ok: false, error }`; `transitionOrThrow` throws `LifecycleError`. Error codes: `not_permitted` (unlisted pair, LIF-003), `inconsistent_state`, `invalid_event`. Core is pure, so it returns the rejection for the caller to log. The "others: unchanged" rows are *accepted* (`changed: false`), not rejected. `analysis_completed` is accepted from every status and always carries `recompute_readiness`.
- **Cancelled Runs.** The generic row `run_finished(k, cancelled)` ("partial if this Run recorded any Mutation, else `statusBeforeRun`") overlaps the kind rows for `verify`, `source_read_only` and `undo_source_read_only`, which say "any" outcome. The kind-specific rows win for those kinds (`statusBeforeRun` even if a Mutation was recorded; `sourceReadOnlyApplied` still changes only on success). The generic row applies to `migrate`, `run_anyway`, `resync` and `rollback`. The event carries `recordedMutation` (required for `cancelled`).
- **`source_missing` in `source_missing`.** The table says "any except `running`", which includes `source_missing` and would record `statusBeforeMissing := source_missing`, a state `source_present` could never leave. It is accepted as an idempotent no-op that keeps the original `statusBeforeMissing`.
- **`source_missing` while running** is *accepted* with `{ ok: true, changed: false, deferred: true }`: no state change, no effects, and it is not a LIF-003 rejection (callers that log every `ok: false` therefore do not mislog it). Remembering the event and re-sending it after `run_finished` is the caller's job (JOB layer).
- **`revoke_complete` without parity (LIF-075 wins over the LIF-002 cell).** The table says "else `statusBeforeManual`", but that would restore `verified` for the sequence verified, `mark_complete`, task reopened, `revoke_complete`, contradicting LIF-001 and LIF-075 ("restores `verified` if parity and tasks allow, otherwise the last Run outcome"). When the flag is false and `statusBeforeManual` is `verified` or `drifted` (which presupposes a verification), the event must carry `lastRunStatus` (`migrated | partial | failed | rolled_back`) and that status is restored; a missing or other value is `inconsistent_state`. Any other saved status is restored as before. (Orchestrator decision; the LIF-002 table is to be amended.)
- **Saved statuses.** A saved field is validated when it is *read*: `statusBeforeRun` and `statusBeforeMissing` must not be `running` or `source_missing`; `statusBeforeDrift` must be `verified` or `manually_completed`; `statusBeforeManual` must not be `running`, `source_missing` or `manually_completed`. A missing or impossible value yields `inconsistent_state` rather than a guessed status. Saved fields are never cleared by the machine; only the table assigns them.
- **Effects** (data, performed by the caller in the same transaction): `recompute_readiness`, `set_verified_at` (`parity_equal` from `migrated`/`partial`), `set_source_read_only_applied { value }` (successful `source_read_only` sets true, successful `undo_source_read_only` false), and `reset_flags` for a successful rollback. LIF-077 does not name the flags; the effect lists `targetCreatedByFramework` and `sourceReadOnlyApplied`.
- `run_finished(*, ...)` "then `parity_*` applies" is two calls: the caller sends `parity_equal`/`parity_different` afterwards. Readiness gating of Run kinds (LIF-005) and rollback availability (LIF-077) are API rules, not state-machine rules.

## Alternatives

- Throwing on rejection: callers must log and map to HTTP; a value is easier to test exhaustively.
- Letting the generic cancelled row win: a cancelled `verify` would become `partial` after no write.

## Affected requirements

LIF-001, LIF-002, LIF-003, LIF-077, LIF-075.
