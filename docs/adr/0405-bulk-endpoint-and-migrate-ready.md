# ADR-0405: `POST /migrations/bulk` lives in packages/api and creates Runs through `createRun`

- Status: accepted (spec updated)
- Date: 2026-10-09
- Task: T-088
- Affects: LIF-090, API-020, LIF-005, DOM-010, UI-021

## Context

LIF-090 says "migrate-ready creates migrate Runs only for Migrations currently `ready` with a fresh Analysis; others are reported as skipped with a reason". API-020 gives `POST /migrations/bulk` the shape `{ids?, filter?, action, waveId?}` and the answer `{accepted:[], skipped:[{id, reason}]}`. The single-Run endpoint (`POST /migrations/{id}/runs`, T-074) is not on `ai-main` yet. What exists is `createRun` in `@git-migrator/jobs` (T-070), which T-070's own header names as the call both T-074 and bulk actions use, and `JobRuntime.enqueueRun`.

## Decision

- The endpoint is in `packages/api/src/bulk.ts` and is mounted by `createV1`. `bulkMigrate` is exported from there so T-074 can reuse the same "create, then enqueue, then audit" sequence.
- No parallel Run path: every Run is made by `createRun(db, { kind: 'migrate', triggeredById })`, which takes the Migration row lock and re-checks Route, active Run, readiness (LIF-005) and the lifecycle (`run_started`). The endpoint's own pre-checks (scope, retired Route, `source_missing`, readiness `ready`, an Analysis exists and is not stale) only produce the more specific reason codes; they never replace the guard.
- Reason codes (the UI has one string for each, `repositories.bulk.reason.*`): `not_found`, `not_repository`, `source_missing`, `route_retired`, `not_ready`, `not_analyzed`, `analysis_stale`, `run_active`, `not_permitted`, `already_in_wave`, `not_in_wave`, `queue_unavailable`. A `RunGuardError` maps to `run_active`, `not_ready`, `not_permitted`, `route_retired` or `not_found`.
- If `enqueueRun` fails after `createRun` committed, the Run is cancelled with `requestRunCancel` (a queued Run is cancelled at once and the Migration returns to its saved status) and the item is skipped as `queue_unavailable`. The `run.create` audit is written before the enqueue and a `run.cancel` audit (reason `queue_unavailable`) after the failure. The queue is then taken to be down: the remaining items are skipped without creating Runs. Otherwise a queued Run no job will ever start would block the Migration (DOM-010).
- Runs are made one at a time, each in its own transaction: each Run is independent (LIF-090), and one failure never rolls back another item.
- `ApiServices.jobs` now also requires `enqueueRun`.
- Each accepted item writes its own `AuditEvent` (`run.create` with `data.bulk = true`, `migration.analyze`, `migration.wave_assign`, `migration.wave_remove`), so the audit log reads the same whether a user acted once or in bulk.

## Alternatives

- Waiting for T-074 and calling its endpoint internally: blocks T-088 on a task that is not required to precede it, and an in-process HTTP call adds nothing.
- One transaction for the whole request: one stuck row lock would hold every item, and the executor would see no Run until the end.
- Trusting the client's `readiness`: refused; the web UI sends ids only.
