# ADR-0341: Run Step state machine, severity and retries

- Status: agent-decided
- Date: 2026-10-09
- Task: T-070
- Affects: LIF-040, LIF-042, LIF-046, ADP-060, JOB-015, JOB-044

## Context

LIF-042 gives failure semantics by step number ("steps 1 to 5 are fatal", "steps 6 to 12 are independent", "step 13 never fails the Run", "step 14 failing makes the Run partial") and says transient errors retry per ADP-060 and rate limiting pauses the Run. The framework knows no step numbers, only keys, and the spec does not say how a Step's status moves, how many attempts a retryable error gets across resumes, or whether a rate limit counts as an attempt.

## Decision

- **Statuses** (existing `StepStatus`): `pending` (not started, or sent back after a delay), `running`, `succeeded`, `failed`, `skipped`. A resume re-runs `pending` and `running` Steps (a `running` row is a worker that died mid-Step) and never touches the other three. `succeeded` is therefore never repeated: an idempotent re-run of a completed Step is a no-op. `failed` is final for that Run.
- **Severity per Step definition**, so the planner carries the numbers of LIF-040: `fatal` (steps 1 to 5: the Run becomes `failed` and later Steps `skipped`), `independent` (steps 6 to 12 and 14: recorded, the rest continue, the Run ends `partial`), `advisory` (step 13 verify: stored as a failed Step but the Run's outcome ignores it, per "never fails the Run"). A Step a build no longer plans counts as `independent` for the outcome.
- **A Step may return** `succeeded`, `skipped` (with a reason that goes to the Run log; used for the conditional Steps 3a, 9 and 14) or `delay` (ms and a reason). A thrown error is a failure of that Step.
- **Retries.** Only errors with `retryable` true that are not `rate_limited` (network, 5xx, unknown transient, ADP-060) are retried by the executor, in process, with full-jitter exponential backoff from 1 s to 60 s: `random() * min(60 s, 1 s * 2^(retry-1))`. `maxAttempts` defaults to 4 (the first try and the 3 retries of LIF-044). It is a budget of **failures**, counted over every resume in `RunStep.failures` (new column): an attempt that ends in a retryable error counts one, and so does an attempt a worker died in (found as a `running` row when the Step is picked up again). A Step that crashes its worker every time therefore cannot retry for ever, and a Step found at its limit fails with `step.attempts_exhausted` before it runs again. `RunStep.attempts` still counts attempts started, for display. The provider HTTP client already retried 5 times inside each attempt (ADP-060), so a Step attempt that still fails is persistent enough to bound at 4. Non-retryable errors fail the Step on the first attempt. The sleep takes the Step signal, so a cancel interrupts the wait; the lease is renewed by its own timer while waiting.
- **Rate limits and delays are not failures.** (Round 2: the first version spent the retry budget on them; four rate limits and one 503 failed the Run.) A `rate_limited` error sends the Step back to `pending`, increments `RunStep.delays` (new column) and delays the Run (ADR-0340). The delay is not bounded: the quota service decides how long the provider needs, and the Run keeps its place. Neither `failures` nor the budget changes.
- **The retry wait is `pending`.** The failure is counted and the row is set `pending` before the backoff sleep, so a worker that dies in the wait does not have it counted a second time as a crash by the resume (round 3). The next attempt marks the row `running` again.
- **Severity is stored.** `run_step.severity` records what the Step was planned with, so the Run's outcome and the fatal check do not depend on the current plan still containing the Step (ADR-0340). A stored row that leaves the plan unfinished is marked `failed` (`run.plan_changed`) and fails the Run if it was planned `fatal` and has started (`running`, or `failures > 0`); a `pending` row that never ran, or any non-fatal row, is `skipped` with `run.plan_changed`.
- **Waiting to retry is interruptible.** The backoff sleep wakes on a cancel and on SIGTERM. On SIGTERM the Run is handed off with the Step already `pending`; the resume does not count a crash.
- **`clearsBlockers`.** A `StepDefinition` may list run-origin blocker codes that the executor clears when the Step succeeds (LIF-049), before marking it `succeeded` so that a crash in between repeats the idempotent clear.
- **A cancelled Step** is stored `failed` with `{ code: 'run.cancelled' }`: it did start, and its work may be partial, which the operator should see; Steps that never started are `skipped`. The Run's outcome is `cancelled` whatever the Step statuses are.
- **Events**: every Step state change publishes `run.updated` in its transaction (JOB-060).

## Alternatives

- Put the step numbers in the framework: duplicates LIF-040 and makes T-071 edit the framework for every reordering.
- Count rate-limit hits as attempts: a Run paused for an hour of rate limiting would fail.
- Reset `attempts` on resume: lets a crash loop retry for ever, past the reaper's bound.

## Affected requirements

LIF-040, LIF-042, LIF-046, ADP-060, JOB-015, JOB-044.
