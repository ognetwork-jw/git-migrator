# ADR-0212: Run reaper details and processors owned by later tasks

- Status: accepted (spec updated)
- Date: 2026-10-08
- Task: T-028
- Affects: LIF-046, JOB-011, JOB-050

## Context

LIF-046 says the reaper re-enqueues expired Runs and fails a Run after 3 resumptions. It does not say how the re-enqueue avoids BullMQ deduplication, what happens to a `running` Run that never got a lease, or what the Migration does when a Run is abandoned. The schedulers of JOB-050 also fire jobs whose processors belong to later tasks.

## Decision

- **Expiry.** A `running` Run is expired when `leaseExpiresAt < now`, or, with no lease yet, when `updatedAt` is older than the lease TTL (2 min). All times are the database clock.
- **Pending markers.** While a Run waits for a job without a live lease, `lease_owner` holds a marker: `reaper:resume-pending:<dedupe id>` after a reaper resume, `handoff-pending:<dedupe id>` after a SIGTERM hand-off. The marker carries the deduplication id of the awaited job, so the reaper can look that job up (`getDeduplicationJobId`, then its state). A Run with no owner at all waits for its first job, enqueued under `run-<runId>`.
- **Resumption.** In one transaction under `FOR UPDATE SKIP LOCKED` the reaper writes the resume marker and a fresh lease period, and after the commit enqueues under the stable id `run-<runId>:resume-<n>` (`n` = counted resumptions + 1). `claimRunLease` counts one resumption when it takes over a resume marker or an expired real lease. A plain `run-<runId>` id would drop the enqueue while the dead worker's job exists (JOB-011).
- **Leases are not re-entrant.** Each claim uses a fresh token `<worker>:<job>:<random>`; a second claim over a live lease fails even from the same pod (an OOM-restarted pod with the same name cannot re-enter). `keepRunLease` aborts `lost` when a renewal finds the row gone, and also when no renewal succeeded within 90 s of the 120 s TTL, whatever the error. Run workers use `maxStalledCount: 0`, so BullMQ never re-queues a stalled Run job: the reaper is the only resume path.
- **Local limit.** `keepRunLease` arms a dedicated timer for 90 s after the *send* time of the last successful renewal and re-arms it on each success; the 30 s tick does no limit check, so the abort happens at most 90 s after the last success, not 120 s. Renewals can answer out of order, so only a success sent later than the last one re-arms the timer.
- **SIGTERM hand-off.** `handOffRun` sets the hand-off marker with expiry TTL ahead, and enqueues `run-<runId>:handoff-<token>` (the old token is unique per claim, so the id is stable and never collides with an earlier hand-off). A claim over the hand-off marker counts nothing. It does nothing when the token no longer owns the lease.
- **Waiting for a job (amended in round 4).** When a marker (or a Run with no owner) expires, the reaper looks up the awaited job. If it is waiting, delayed, prioritized or active, the reaper only extends the period: no count, no new job, so a backlogged queue can delay a Run but never abandon it. If the job is missing, failed or completed without claiming, the wait is over. A dead resume job counts as the resumption it was (its claim never will), and the next resume is enqueued. A dead hand-off or first job becomes a resume, counted when claimed or when it dies. So every resume attempt counts exactly once, and the 3-resumption bound of LIF-046 holds even while `run.execute` has no handler (until T-070, every Run job fails). If the lookup itself fails, the reaper waits for the next pass. A bare marker without an id counts as a dead job.
- **Draining Workers.** BullMQ's `close()` can still let a Worker with a free slot activate one waiting job. `JobRuntime` gives such a job back (`moveToWait`, `WaitingError`) without running or failing it once shutdown began, keeping its id and `attemptsMade`. Handlers must still check `shutdown.aborted`. `JobRuntime.processJob` is public (marked internal) only so a test can hand it a job activated after shutdown began.
- **Abandonment.** When a real lease expires, or an awaited job is found dead, and `reaperResumes` is already 3, the Run becomes `failed` with `error = {code: "run.abandoned", resumes: 3}` and `finishedAt`. The reaper does not change the Migration: the status transition for a failed Run belongs to the Run executor (T-070), reported as a follow-up.
- **Queue choice.** `run.execute` goes to `runs-large` only for a repository-scope Migration with `sizeClass = large` and a git Run kind (`migrate`, `run_anyway`, `resync`); everything else goes to `runs-standard` (JOB-010).
- **Pending processors.** `inventory.endpoint`, `analysis.feeder`, `drift.sweep` and `parity.migration` have schedulers but no processor yet (T-060, T-061, T-089, T-072). Their handlers log a warning and complete as `{skipped: true}`, so the schedulers do not fill the failed set. User-triggered jobs (`analysis.migration`, `inventory.namespace`, `run.execute`) have no handler and fail without retry until their task lands.

## Alternatives

- Fail abandoned Runs and also move the Migration: duplicates the lifecycle machine.
- Fail every job without a processor: seven days of failed jobs and noisy alerts.

## Affected requirements

LIF-046, JOB-011, JOB-050.
