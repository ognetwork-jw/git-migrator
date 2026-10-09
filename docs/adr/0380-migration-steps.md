# ADR-0380: Migration Steps (LIF-040 steps 1 to 12)

- Status: agent-decided
- Date: 2026-10-09
- Task: T-071
- Affects: LIF-031, LIF-040, LIF-041, LIF-042, LIF-043, LIF-044, LIF-045, LIF-047, LIF-048, LIF-049, JOB-015, JOB-041, ADP-011, ADP-012, ADP-060, FAC-DKY-002, FAC-BRR-002

## Context

T-070 gave the executor a Step framework. The spec describes what each Step does but is silent on several seams. This ADR records the choices.

## Decision

- **One planner for three kinds.** `migrate`, `run_anyway` and `resync` share one planner. It lists the Steps from the `step` PlanItems of `Run.analysisId` (LIF-040 order, already filtered by flags and target capabilities) and maps each key to its implementation. A key without an implementation is left out: `verify` (T-072) and `source.read-only` (T-073) join through `MigrationServices.extraSteps`, so they sit where the Plan puts them. An endpoint Migration gets one failing Step `run.scope`, until LIF-081 is built. `analysis.refresh` (advisory) is appended: the Migration is analyzed again at the end of the Run, so an interactive Analysis taken mid-Run is superseded by its database-clock `startedAt` (T-062 follow-up).
- **What a Run applies** is the `desired` document of the Run's own Analysis (`Analysis.translation`), never a fresh translation, so a resume and a mid-Run Analysis cannot change it. `run_anyway` needs no different code: the translation already omits unmapped principals and applies lossy approximations.
- **Scratch.** `runHandlers` wraps each job in `withRunScratch` (JOB-015) and passes `ctx.scratchDir`. Scratch is removed with the job, so after a delay the next job starts empty; the push Steps rebuild the mirror (and fetch LFS) when it is missing. `git.prepare` does the disk precheck and returns `{status:'delay'}`; after 6 delays it fails `scratch.insufficient`. It records `Repository.lfsBytes` and the size class.
- **Git quota.** `GitAccess.quota` (optional `BucketSpec`) names the credential's git bucket; Bitbucket sets its `git` group (60,000/h). GitHub has none: git over HTTPS is not metered by its REST limits, so its git commands are not pre-acquired.
- **Limits.** The blob scan uses the target connection's `limits.maxBlobBytes`; the push limit is `min(git.maxPushBytes, limits.maxPushBytes)`.
- **Preflight (LIF-041)** reads `change-requests` from the source live and re-judges the group principals of `access-control`, `branch-rules` and `code-ownership` (latest source Snapshots) against the current group mappings, plus the git quota (a blocked or empty bucket delays the Run). New blockers fail the Step with `preflight.blocked` (details name the codes) and mark the Analysis stale. They are not stored as run-origin blockers: LIF-049 clears those only by a later Run or a dismissal, which would trap a Migration whose Change Requests were closed.
- **Adoption (LIF-031, LIF-043).** An existing target is adopted when empty; a non-empty one needs `adoptNonEmpty` (the typed confirmation is checked by `createRun`). The adoption is an `adopted` create record (before equals after, so undo never touches it). A repository this Migration created in an attempt whose claim was lost is recognised from the ledger and still counts as created by the framework. The claim (`targetRepositoryId`, `targetCreatedByFramework`, the target `Repository` row) is written under a per-repository advisory lock, so two Migrations cannot claim one repository (`target.owned-by-other-migration`, a run-origin blocker).
- **Spec gap, force-adopt readiness.** LIF-005 requires `ready` for migrate, but `target.exists-nonempty` makes a Migration `blocked`, so a force-adopt could never start. `effectiveReadiness` (used by `createRun` and the executor) judges a Run with `adoptNonEmpty` by its open pre tasks when every blocker is `target.exists-nonempty`; any other blocker still blocks.
- **Reconcile (LIF-043).** With `adoptNonEmpty` the push is forced; after the default branch is set, target branches and tags the source lacks are deleted, except `refs/heads/git-migrator/*`. Recorded as an inert delete (no undo).
- **Protection lift (3a)** deletes only rules matching branches this Run is about to change: source branches the target lacks or has elsewhere, the target branches a reconcile deletes, and the `git-migrator/ci` and `git-migrator/codeowners` branches when a Change Request will be opened. A resync that changes nothing lifts and re-creates nothing.
- **Intent and confirm.** Direct writes (repository create, default branch, push, LFS, reconcile) use `intend` before and `confirm` after, and a resumed Step settles open intents first (repository: read back by name; others: `applied`, the conservative answer). Facet `apply` calls run under an inert umbrella intent (`resourceRef.noop`), which marks the Run as having written even if the worker dies before the driver yields its first record; each driver record is ledgered as it arrives.
- **LFS** is pushed only for objects the target reports missing (`lfs.missing`), so a repeated Run records nothing.
- **Change Requests (LIF-047).** `code-ownership` is delivered by the target driver's own `apply` (it renders CODEOWNERS and opens the request). Pipelines are rendered by a new registry hook `pipelinesDelivery(source, target)`, implemented in the GitHub adapter because it names provider constructs (ARC-012). The Step re-reads the source pipeline file (never persisted), renders the workflows plus the original at `.github/git-migrator/bitbucket-pipelines.yml`, and calls `ChangeRequestWriter.upsert`. Records written before a failure travel on `error.mutations` and are ledgered. The `framework_mutation` Expected Difference is `/refs[name=refs/heads/git-migrator/<purpose>]` of `git-refs`. The Migration link in the body comes from `MigrationLinks`, which the adapter's `migrationUrl` option reads (`createBuiltinRegistry({migrationUrl})`).
- **Overlays (LIF-048).** Step 12 merges each Facet's enabled Overlays (oldest first) onto `desired` with core `mergeOverlay` (objects merge, keyed collections merge by key, everything else including sets is replaced by the overlay, matching T-072's parity merge), refuses prototype keys, validates with the Facet schema, applies, and records `overlay` Expected Differences for the overlay's paths (once; a revocation is never undone). When T-072 merges, the two merges must become one function (T-072's, plus the key guard).
- **Run-time findings (LIF-049).** `git.prepare` stores `git-refs.blob-too-large` blockers (cleared when it passes). A provider rejection for size becomes `git-refs.push-too-large` (cleared by `git.push-refs`) or `git-refs.blob-too-large`. `deploy-keys.key-in-use` becomes a verifiable post task when a desired key is missing after the apply (the driver only logs and skips). A refused force-push bypass list (`resourceRef.exemptionsDropped`) becomes a post task. `branch-rules.exemptions-dropped` is a policy key (FAC-005 keeps policy keys distinct from finding codes), so the task uses the new code `branch-rules.exemptions-not-applied`, with guidance. `git-refs.push-too-large` also gets guidance. Both are listed as agent-decided codes.
- **`StepFailure`** (new, `run/errors.ts`) is a non-retryable Step failure with a code of its own; the code and scrubbed details are stored.

## Alternatives

- One planner per kind: three copies of the same list.
- Re-translating at Run time: a resume could apply something other than the Analysis the operator saw.
- Keeping the scratch directory across jobs: contradicts JOB-015 (removed in `finally`).
- Storing preflight blockers as run-origin blockers: see above.

## Affected requirements

LIF-031, LIF-040 to LIF-045, LIF-047 to LIF-049, JOB-015, JOB-041, FAC-DKY-002, FAC-BRR-002.

## Round 2 (review of PR 48)

- **Blocker clearing.** `target.ensure-repository` declares `clearsBlockers` for `target.exists-nonempty` and `target.owned-by-other-migration`, so a later Run that passes the Step (for example a force-adopt) clears them.
- **Lost create response.** The adapter's create already never retries in process; a lost response is settled by the Step's retry (read back by name). `ledgerShowsCreation` also counts an unsettled `intended` create row of this Migration for the same name, across Steps and Runs, so a repository left behind by a failed or cancelled Run is the framework's own, not foreign. The lookup, create and claim of one target name are serialized by a session advisory lock (`target-name:<endpoint>:<name>`) on a connection of its own (released if the worker dies).
- **Recovering lost Facet records.** The umbrella intent of a Facet apply stores the document the target held before (`before`). A resumed Step diffs it against a fresh read: a difference is ledgered as a real record (`resourceRef.kind = recovered-write`, undoable by its paths), no difference settles the intent `not_applied`. Records that were ledgered before the crash may be repeated in the recovered one; undo is idempotent. Change Request umbrellas are settled as before (the writer is idempotent and ledgers an existing branch as adopted).
- **Migration link.** The Change Request Step notes the link from the database at its start and forgets it at its end; the map never outlives a Step.
- **Rebuilt mirror.** A mirror rebuilt in a later job passes the disk precheck (with its reservation, delay and `scratch.insufficient`) and the blob scan before anything is pushed. `MirrorRegistry.sourceMirror(runId)` returns the Run's bare source mirror while it exists in this job (for parity, T-072).
- **Inert records.** Git-push, LFS-push and default-branch records are `noop` (rollback deletes a created repository and leaves an adopted one's refs alone).
- **No Analysis.** A repository Run without an Analysis plans one fatal Step `run.analysis_missing`.
- **Failure after the lift.** When `git.push-lfs` or `git.push-refs` fails for good after step 3a lifted rules, a run-origin post task `branch-rules.protection-lifted` names them. Nothing re-applies them automatically. New agent-decided code, with guidance.
