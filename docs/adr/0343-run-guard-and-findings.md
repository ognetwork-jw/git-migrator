# ADR-0343: Run guard, run-origin findings, and Runs between transactions

- Status: accepted (spec updated)
- Date: 2026-10-09
- Task: T-070
- Affects: DOM-010, LIF-002, LIF-004, LIF-005, LIF-040, LIF-046, LIF-049, LIF-080

## Context

The task brief asks for "the concurrency guard (one active Run per Migration, and the Route / Endpoint limits per LIF-049 / DOM-010)". The spec contains one limit: DOM-010, at most one `queued` or `running` Run per Migration, plus the one-endpoint-Migration-per-Route index (DOM-014). LIF-049 is about run-origin findings, not limits. LIF-080 says repository Migrations proceed independently of the endpoint Migration. Worker concurrency (JOB-012) and provider rate limits (JOB-040 to JOB-045) are the other bounds and already exist. Also unspecified: who creates a Run and moves the Migration to `running`, how a Run that never reached the queue or a Migration left `running` behind an abandoned Run recovers (LIF-046 says the reaper does not change the Migration and that "the Run executor owns that transition"), and how run-origin findings are stored.

## Decision

- **Guard.** `createRun(db, { migrationId, kind, triggeredById, options })` is the one function that admits a Run; the Run endpoints and bulk actions (T-074) call it and then enqueue `run.execute` with the returned `routing`. In one transaction it locks the Migration row, refuses (with a `RunGuardError` carrying the HTTP status) a missing Migration (404 `run.migration_missing`), a retired Route (409 `run.route_retired`), an existing `queued` or `running` Run (409 `run.active`), a readiness that LIF-005 does not allow for the kind (422 `run.readiness_required`) and a `run_started` the LIF-002 table rejects (409 `run.not_permitted`, for example `source_missing`), then applies `run_started`, inserts the `queued` Run and publishes the events. The partial unique index remains as the backstop for writers that bypass the function; its violation is mapped to the same `run.active`.
- **Run options (LIF-043).** `createRun` validates `options` with a strict schema (`adoptNonEmpty`, `skipSourceReadOnly`; an unknown key is a 422 `run.options_invalid`, because a stored unknown option would silently never be honored) and, for `adoptNonEmpty`, requires the top-level `confirm` to equal the target's full name exactly: `Repository.fullPath` of the target when it exists, otherwise `<Route target namespace path>/<plannedTargetName>`. `adoptNonEmpty` is refused on kinds that push no refs. `confirm` is never stored with the options. The ref-push reconcile itself belongs to T-071.
- **Route and Endpoint limits.** No limit beyond DOM-010 is invented. The endpoint-scope Migration is one row per Route, so "one endpoint Run per Route" follows from DOM-010 plus DOM-014, and it does not block repository Runs of that Route (LIF-080). A per-Endpoint cap on concurrent Runs would contradict JOB-012, which bounds concurrency by worker configuration; provider load is bounded by the quota service.
- **Readiness `null`.** LIF-005 gives `resync` "anything except blocked", so a Migration with no readiness may resync (the inline Analysis of LIF-022 runs first); `migrate` and `run_anyway` require `ready` (or `needs_attention`) and refuse an unset readiness.
- **Run-origin findings (LIF-049).** `ctx.findings.addBlocker`, `clearBlockers` and `addTask` write `Migration.runBlockers` (`[{code, params, at}]`, one per code and params) and ManualTasks with `origin: 'run'`, each in a transaction under the Migration and Run locks, and recompute readiness from the latest Analysis' blockers and warnings, the run blockers and all tasks (LIF-004) through `recomputeReadiness`. An Analysis never dismisses these (ADR-0310 already skips run-origin tasks). `addTask` is keyed by `(code, facetKey, paramsHash)` like Analysis tasks and never reopens a task an operator completed. A Migration without an Analysis keeps `readiness` null unless a run blocker exists (fail closed, `deriveReadiness`).
- **Queued Runs whose job was never enqueued** (the process died between the commit of `createRun` and the enqueue) would hold the unique index for ever. `maintenance.run-reaper` calls `requeueOrphanedQueuedRuns`: a `queued` Run older than 120 s whose `run-<id>` job is not pending is enqueued again under the default id.
- **Migrations left `running`.** After the reaper marks a Run `failed` (`run.abandoned`), the Migration is still `running`. `settleOrphanedMigrations` finds Migrations that are `running` with no `queued` or `running` Run and applies `run_finished` for the latest Run's outcome, under the Migration lock, in the same `maintenance.run-reaper` job. It is idempotent and runs on any worker. `MaintenanceDeps.db` is optional; without it the job behaves as before.
- **Decision: the reaper deviation from LIF-046.** LIF-046 says the reaper does not change the Migration and that the Run executor owns that transition, but an abandoned Run has no executor. Rather than let the reaper write the Migration, `maintenance.run-reaper` calls `settleOrphanedMigrations` after it, which applies `run_finished` for the Migration's latest Run under the Migration lock (and skips the Run's unfinished Steps). The reaper function itself still never touches the Migration; the transition is applied by the same job right after, using the same code as the executor. The orchestrator folds this into the spec.
- **Cancel** of a `queued` Run is immediate (`requestRunCancel`, ADR-0340), so a Run cannot sit in the queue after an operator cancelled it.

## Alternatives

- Settle the Migration inside the reaper: LIF-046 says it does not.
- A queued-Run lease instead of re-enqueueing: more states for a rare crash window; BullMQ deduplication already makes the re-enqueue safe.
- A per-Route concurrency cap: not in the spec; would need a config key and a decision about large pushes, so a follow-up if wanted.

## Affected requirements

DOM-010, LIF-002, LIF-004, LIF-005, LIF-040, LIF-046, LIF-049, LIF-080.
