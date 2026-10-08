# ADR-0211: Worker process decisions

- Status: accepted (spec updated)
- Date: 2026-10-08
- Task: T-028
- Affects: JOB-012, JOB-015, JOB-046, JOB-050, ARC-023, DEP-002, DEP-030

## Context

The spec fixes the roles, queues and schedules but leaves several runtime choices open.

## Decision

- **Scratch cleanup runs in every pod.** The scratch directory is pod-local, so `maintenance.scratch-cleanup` cannot be a queue job that any pod may take. Each worker pod cleans at start-up and on `schedules.scratchCleanup` with a local timer (`cron-parser`, UTC). The job name stays registered, so it can still be enqueued by hand. The leader's schedulers do not include it.
- **Retention is hourly per process.** `maintenance.prune` runs every 10 minutes; the DATA-020 pass (raw responses, Analyses, Snapshots) runs when the last pass in that process is an hour old, and on the first run. There is no shared "last run" column; the statements are idempotent, so two pods doing it is redundant, not wrong.
- **Analysis concurrency applies to each analysis queue.** `worker.standard.concurrency.analysis` is the concurrency of the interactive Worker and of the background Worker, so a saturated background pool never starves interactive analyses. Provider quota is the real throttle (JOB-012). `maintenance` has no config key; it uses 2.
- **Leader election.** `pg_try_advisory_lock(hashtextextended('gm-scheduler-leader', 0))` on a dedicated connection that pings every 5 s. Only `standard` and `all` workers take part; `large` workers never lead. On election the leader registers the schedulers and re-reconciles every 5 minutes, because endpoint Migrations (parity schedulers) are created by inventory after start-up; schedulers no longer wanted are removed.
- **Health server** on port 8081 (`/healthz`, `/readyz`), plain `node:http`; ready after the queue Workers started, not ready after shutdown begins.
- **Scratch.** Each job uses `$GM_SCRATCH_DIR/<runId>/<random>` and removes only its own directory (and the Run directory once empty), so overlapping jobs for one Run never delete each other's files; the Run directory is skipped by cleanup while any job uses it. When the first job of a Run starts in a process, the job directories already under the Run directory belong to a dead process (a crashed job before its resume) and are removed first; jobs of that Run wait for the removal. The precheck subtracts, for each other Run this process reserved for, the part of the reservation not yet written (`max(0, reservation − bytes under its directory)`), because written bytes already left the free space.
- **Retention deletes.** Raw responses are deleted by `DELETE … WHERE id IN (SELECT … LIMIT 1000)` until a pass deletes nothing, so the ids never reach the process. Analyses and Snapshots are ranked once; each chunk of 1,000 ranked ids is deleted by a statement that re-checks the protection (a Run or a Migration's latest), so a row protected after the ranking stays.
- **Entrypoints.** `apps/worker/src/worker.ts` (`--role standard|large|all`, default `all`) and `migrate.ts` replace the T-002 placeholder `dev-worker.ts` (ADR-0068), and the `dev` script runs `worker.ts`. Producing `dist/<cmd>.js` for the image is T-090.
- **Provider environment.** The worker builds the adapter host pieces (quota gate, lease gate, `RawCaptureSink` over `RawResponse`, `ProviderTelemetry` over `MetricRecorders` and the tracer) with `createProviderEnvironment`. `RawResponse` has no header column, so captured headers are not stored.

## Alternatives

- Scratch cleanup as a fan-out job per pod: needs pod discovery.
- A `prune_state` row for the hourly gate: a new table for an idempotent job.

## Affected requirements

JOB-012, JOB-015, JOB-046, JOB-050, ARC-023, DEP-002, DEP-030.
