# ADR-0397: LFS parity and post-cutover containment in the Parity Check

- Status: agent-decided
- Date: 2026-10-09
- Task: T-072
- Affects: FAC-GIT-005, FAC-GIT-006, LIF-060, LIF-065, ADP-071, JOB-041

## Context

FAC-GIT-005 requires every LFS object referenced by any ref of the mirror to be downloadable from the target. FAC-GIT-006 relaxes git parity once `sourceReadOnlyApplied` is true: each source ref must exist on the target and the target must equal it or descend from it; extra target refs are allowed. ADR-0100 left both to the Parity Check, because `compare(desired, actual, ctx)` is synchronous and sees neither the compare API nor the flag. Open: where the LFS object ids come from when no Run's mirror exists, what a failing check is, and whether containment applies to every check or only to the drift job.

## Decision

- **LFS object source.** `computeParity` asks an injected `LfsObjectSource` for the objects the source's refs reference (`createMirrorLfsSource` in the worker).
  - *Inside a Run* the mirror of `git.prepare` is reused: a Run's `services` may implement `ParityServices.sourceMirror(runId)` (`parity/compute.ts`), and the `verify` Step passes the directory to the source, which runs `git lfs ls-files --all` on it: no clone, no quota, no scratch. **T-071 supplies it**: return the directory of the Run's bare source mirror (the `dir` given to `GitService.mirror`) while the Run's scratch lives, `undefined` otherwise. Without it the next case applies.
  - *Otherwise* the source is mirrored into a per-check scratch directory (`withRunScratch`, JOB-015) and removed. Before the clone the JOB-015 disk precheck runs with `estimateScratchNeed(sizeBytes, 0)` and reserves the space; a check cannot wait 10 minutes six times like a Run, so a short volume makes the git-refs Facet `unverifiable` with `scratch.insufficient` (`ScratchInsufficientError`), not the whole check. The clone's 3 units are pre-acquired in the `git` bucket of the credential `connect` selects (`EndpointConnector.gitQuota`, `createGitQuota`, limit 60,000 an hour or `quota.overrides.git`, JOB-041/JOB-043), in the check's pool; a denial is `rate_limited` and ends the check with nothing stored (JOB-044). The credential reaches git through `GIT_ASKPASS` only (ADP-071).
  - Without a source (tests, tooling) LFS is not checked.
- **The check.** `checkLfsObjects` adapts the connection's `lfs.missing(ref, oids)` (the batch API `download` operation, through the adapter's `ProviderHttpClient` and the quota service, ADP-060) to the `LfsBatchClient` of `@git-migrator/git` and calls `verifyLfsParity` (groups of at most 100). Missing objects become one diff at `/lfs/oids` of `git-refs` (ADR-0395), so the Facet is `different`. An error of the batch API makes the Facet `unverifiable`, never `equal` (ADR-0240).
- **Containment applies to every check while `sourceReadOnlyApplied` is true**, not only to the drift job. LIF-065 names the drift check, but FAC-GIT-006's purpose ("normal development after cutover, including merging the framework's Change Requests") would make every explicit `verify` Run, and every resync check, report a verified Migration as drifted. The Facet's `compare` stays strict: `applyContainment` post-processes the strict diffs. A ref only on the target is allowed; a ref that differs passes when `refs.compare(target, base = source tip, head = target tip)` is `identical` or `ahead` (an annotated tag compares by its peeled commit); a ref missing on the target, a target `behind` or `diverged`, and a commit the target does not know (`not_found`) stay differences. The default branch is not relaxed. One compare call serves all the diffs of a ref. An error of the compare API makes the Facet `unverifiable`.
- **Order.** Strict diffs, then containment, then the LFS diff, then Expected Differences are subtracted by the engine (the adjusted diffs go through `compareFacet` again), so a `framework_mutation` or `manual_accepted` record can hide any of them.
- **Size routing.** Parity jobs run on the standard queue. A repository that does not fit the standard worker's scratch volume ends `unverifiable` (`scratch.insufficient`) instead of being routed to a large worker (a `parity-large` queue would need its own concurrency and pool sizing); inside a Run the Run's own mirror is used and routing is the Run's. Follow-up if large repositories need LFS parity outside a Run.
- **Hand-off notes (T-073, T-089).** Containment applies to explicit `verify` Runs too, so after cutover a verify reports `verified` while the target has extra commits. Every check outside a Run mirrors the source unless `lfs: 'skip'` is passed or `lfsBytes` is 0; T-089 passes `lfs: 'skip'` when the refs did not change.

## Alternatives

- Containment only in the drift job: a verify Run after cutover would flag legitimate commits.
- Reading the LFS ids from `GitRefs.lfs.oids` in the target Snapshot: that field is "filled during runs only" and the Snapshot is read live; stale ids would hide new objects.
- A new column for the LFS ids measured by `git.prepare`: a migration shared with T-071; the port is enough.

## Affected requirements

FAC-GIT-005, FAC-GIT-006, LIF-060, LIF-065, ADP-071, JOB-041.
