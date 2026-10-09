# 06 — Migration Lifecycle

## Status and readiness (LIF-001)

`status` (lifecycle position) and `readiness` (what the latest Analysis allows) are independent fields.

| Status | Meaning |
|---|---|
| `discovered` | Inventoried, never analyzed |
| `analyzed` | Has a current Analysis. `readiness` is set. |
| `running` | A Run of any kind is queued or running |
| `migrated` | Last migrate/run-anyway/resync Run succeeded, but parity is not yet fully equal or post tasks are open |
| `partial` | Last Run finished with some failed facet steps |
| `failed` | Last migrate/run-anyway/resync Run failed in steps 1–5 |
| `verified` | Parity is equal (after Expected Differences), and all tasks are `done` or `dismissed` |
| `manually_completed` | An Actor marked it complete (LIF-075) |
| `drifted` | A drift check found differences on a `verified` or `manually_completed` Migration |
| `rolled_back` | A rollback Run succeeded |
| `source_missing` | The source repository disappeared from inventory |

"Unmigrated" (the default Repositories filter) means status not in {`verified`, `manually_completed`}.

### Transitions (LIF-002)

The state machine is a pure function in `core`: `transition(state, event) → state | error`. `state` includes the status plus the saved-status fields `statusBeforeRun`, `statusBeforeDrift`, `statusBeforeManual` and `statusBeforeMissing` (all on `Migration`). The table is exhaustive. Any (status, event) pair not listed is rejected and logged, and it is unit-tested to be rejected (LIF-003).

| Event | From | To | Side effects |
|---|---|---|---|
| `analysis_completed` | `discovered`, `rolled_back` | `analyzed` | readiness recomputed |
| `analysis_completed` | any other (including `running`) | unchanged | readiness recomputed |
| `run_started(k)` | any except `running`, `source_missing` | `running` | `statusBeforeRun := from` |
| `run_finished(migrate\|run_anyway\|resync, succeeded)` | `running` | `migrated` | then `parity_*` from the Run's verify step applies |
| `run_finished(migrate\|run_anyway\|resync, partial)` | `running` | `partial` | |
| `run_finished(migrate\|run_anyway\|resync, failed)` | `running` | `failed` | |
| `run_finished(k, cancelled)` | `running` | `partial` if this Run recorded any Mutation, else `statusBeforeRun` | |
| `run_finished(verify, any)` | `running` | `statusBeforeRun` | then `parity_*` applies |
| `run_finished(rollback, succeeded)` | `running` | `rolled_back` | flags reset (LIF-077) |
| `run_finished(rollback, failed\|partial)` | `running` | `partial` | |
| `run_finished(source_read_only\|undo_source_read_only, any)` | `running` | `statusBeforeRun` | `sourceReadOnlyApplied` updated only on success |
| `parity_equal` (all compared facets equal **and** no open tasks) | `migrated`, `partial` | `verified` | `verifiedAt := now` |
| `parity_equal` | `drifted` | `statusBeforeDrift` | |
| `parity_equal` | others | unchanged | |
| `parity_different` | `verified`, `manually_completed` | `drifted` | `statusBeforeDrift := from` |
| `parity_different` | others | unchanged | |
| `mark_complete` | any except `running`, `source_missing`, `manually_completed` | `manually_completed` | `statusBeforeManual := from` |
| `revoke_complete` | `manually_completed` | `verified` if the latest parity is all equal and no tasks are open; else `statusBeforeManual`, except that a saved `verified` or `drifted` is never restored: the last Run outcome (`migrated`, `partial`, `failed` or `rolled_back`, from the latest finished migrate/run-anyway/resync/rollback Run that changed status) is used instead (LIF-075, ADR-0058) | |
| `source_missing` | any except `running` and `source_missing` | `source_missing` | `statusBeforeMissing := from`. While `running`, the event is accepted but deferred until `run_finished` (not a LIF-003 rejection). While already `source_missing`, it is a no-op (ADR-0058). |
| `source_present` | `source_missing` | `statusBeforeMissing` | |

Runs of every kind go through `running`. `verified` and `manually_completed` Migrations can start resync, verify, rollback and source read-only Runs.

"Then `parity_*` applies" is realized in the transaction that ends the Run: after `run_finished`, the verdict of the Run's `verify` Step is applied through `transition()`, but only when that Step `succeeded` (a failed Run skips `verify` and changes nothing more). The verdict comes from the latest ParityResult of every Facet and the open ManualTasks: `parity_different` if any Facet is `different`; `parity_equal` if at least one Facet stored a result, all are `equal` and no task is `open`; otherwise no event, since `unverifiable` is neither (ADR-0396). A `cancelled` Run "recorded a Mutation" when any ledger row of it is not `not_applied` (`Run.hasMutations`, adopted and no-op records included, LIF-045).

### Readiness (LIF-004)

`Migration.readiness` is recomputed by the server whenever an Analysis completes, a ManualTask changes, a Run records findings, or a Mapping changes. It is never stored only on the Analysis.

- `blocked` if the latest Analysis has a blocker, or there is an open **run-origin blocker** (LIF-049).
- `needs_attention` if any `pre` task is `open`.
- `ready` otherwise.

Post tasks never affect readiness. The UI shows them as "N follow-up tasks" next to Ready.

**LIF-005 Readiness required per Run kind:** `migrate` requires `ready`. `run_anyway` requires `ready` or `needs_attention`. `resync` requires anything except `blocked`. `verify`, `rollback`, `source_read_only` and `undo_source_read_only` are not gated by readiness or blockers. A violation returns 422 `readiness_required`. A Migration with no readiness yet may `resync` (the inline Analysis of LIF-022 runs first); `migrate` and `run_anyway` refuse it. A Run with `adoptNonEmpty` whose only blockers are `target.exists-nonempty` is judged by its open pre tasks instead, so that a force-adopt can start; any other blocker still blocks (ADR-0343, ADR-0380). The guard checks readiness at creation (DOM-010), and the executor checks it again after the inline Analysis. A Migration that became unready while its Run was queued ends that Run `cancelled` with `readiness_changed`, before any Step runs (ADR-0340).

### Completing tasks (LIF-006)

Each finding code declares a `completion` mode in its FacetDefinition (ADP-030):

- **`manual`:** an operator marks it done, for example after reading a branching-model warning.
- **`accept`:** for `<facet>.accept-lossy` tasks. Marking done creates a Migration-scoped `lossy_accepted` Expected Difference recording the task's paths and policy key: one per path, with the policy key as `note`. A row is owned by the `done` accept tasks of its Facet that list its path. Reopening a task revokes only the paths that no other `done` accept task with the same policy key covers, and such a row cannot be revoked directly (409) (ADR-0415).
- **`resolution`:** cannot be marked done directly. Resolved only by changing the underlying data, for example `access-control.unmapped-principal` via an Identity Mapping confirm or exclude, which re-runs the Analysis. `done` returns 422. `dismiss` (with reason) is allowed and means "proceed without it".
- **`parity`:** verifiable. Auto-completed when the Facet's `isTaskSatisfied(task, targetDoc, parityResult)` predicate returns true. Operators may also mark it done manually.

Task actions (API-020): `done` from `open` or `dismissed`, `dismiss` from `open`, and `reopen` from `done` or `dismissed`; any other pair is 409. `done` and `dismiss` set `completedById` and `completedAt`, and `reopen` clears both. A code the registry does not know is `manual`. Each action recomputes readiness and enqueues a Parity Check after commit (LIF-062) (ADR-0415).

## Route policies (LIF-011)

See FAC-005. Policies and per-Route `defaults` come from config. Changing them marks every Analysis on the Route stale.

## Analysis (LIF-020)

An Analysis runs in an analysis job (JOB-020):

1. Load the Route, mappings, naming rules, allowlist, overlays and Expected Differences.
2. Read every in-scope Facet from the source, storing Snapshots. Remove resources created by the framework's own source-side Mutations before translation (LIF-045). Endpoint dependencies apply only to principals referenced in this repository's own documents (FAC-006). Unrelated workspace membership never affects a repository's readiness.
3. Resolve the planned target name (LIF-030). Find the target by `Migration.targetRepositoryId` if set, otherwise by name. If it exists, read all target Facets too. A target whose ID equals `targetRepositoryId` is **owned** by this Migration and never raises `target.exists-*` blockers, unless a *different* target repository holds the planned name, which raises `target.exists-nonempty` (ADR-0095). A target claimed by another Migration raises `target.owned-by-other-migration` (LIF-031).
4. For each Facet, run `normalize` → `translate`, with Route policies applied (FAC-005).
5. Compute the Plan:
   - Steps (LIF-040 order).
   - Blockers, including name collisions, an existing non-empty target (LIF-031), `change-requests.open` and dependency blockers.
   - `pre` and `post` tasks, and warnings.
6. Persist the Analysis and PlanItems. Upsert ManualTasks by `(code, facetKey, paramsHash)`: existing done tasks stay done, and analysis-origin tasks no longer produced are set to `dismissed` with note `obsolete` and `completedById` null, whatever their earlier status. A `dismissed` analysis-origin task with null `completedById` is reopened when the same finding returns (the decision never reads `note`). Every other path that dismisses a task (API-020 `dismiss`, bulk actions) MUST set `completedById`, or the Analysis would reopen it. Run-origin tasks and blockers (LIF-049) are never dismissed by an Analysis. The write is one transaction that first locks the Migration row. If a newer Analysis of the Migration is already stored (by database-clock `startedAt`), this one is dropped and stores nothing. Writers that mark several Migrations stale lock rows in id order.
7. Recompute readiness (LIF-004), `blockerCodes` and `readinessCounts`. Set `analysisStaleAt = now + schedules.analysisStaleAfter`, or the database clock now when anything marked the Migration stale since the Analysis read its inputs (every marker increments `Migration.staleGeneration`, even on a stale or never-analyzed Migration), then apply event `analysis_completed` (LIF-002).

An Analysis is **stale** when `analysisStaleAt <= now`: that is, after `schedules.analysisStaleAfter` (default 7 d), or when Route config (`Route.configHash`), policies, mappings, naming rules, allowlist or overlays change, or when inventory sees a newer `Repository.providerUpdatedAt` (LIF-021). Marking sets `analysisStaleAt` to now unless it is already due, and clears the failure markers of JOB-020. Any write that changes what mapping resolution returns (FAC-006) MUST mark the Route's Analyses stale. That covers Identity and Group Mapping decisions, CSV imports that change a row, an invitation send claim, and every invitation outcome that moves a mapping. Each calls the shared marker in its own transaction and publishes one `migration.updated` without ids when it newly marks a Migration. A decision that changes nothing marks nothing (ADR-0320, ADR-0370). Creating or revoking an Expected Difference, including those an `accept` task creates, marks the Migration stale, or the whole Route for a Route-wide record (ADR-0415). These do not mark anything stale: a task status change, a Wave assignment (ADR-0407) and an invitation deselection, which leaves mapping resolution unchanged (ADR-0370). Starting a migrate, run-anyway or resync Run re-analyzes inline first when the Analysis is stale **or older than `schedules.runRequiresAnalysisWithin`** (default 24 h). If readiness got worse, the Run aborts with `readiness_changed` and the UI shows the new findings (LIF-022). The Run then ends `cancelled` with error `{code: readiness_changed, before, after}` and no Step rows, and the Migration returns to `statusBeforeRun`. An inline Analysis that throws ends the Run `failed` (`run.analysis_failed`) and records the feeder's failure marker (JOB-020). A skipped one ends it `failed` with `run.analysis_skipped`, and a rate-limited one delays the Run. The inline Analysis runs once per Run, never on a resume, and sets `Run.analysisId` (ADR-0340).

## Naming (LIF-030)

```ts
type NamingPipeline = { steps: NamingStep[]; template: string };
type NamingStep =
  | { var: 'namespace' | 'repository' | 'group'; op: 'projectKey' | 'slug' | 'name' }   // initializes the variable from the source object
  | { var: string; op: 'lowercase' | 'kebab' | 'truncate'; arg?: number }
  | { var: string; op: 'replace'; pattern: string; with: string };
```

- `replace` patterns are RE2 (linear time; no back references or lookarounds). `with` uses RE2J replacement syntax: `$1`, `$<name>` and `$$`; unresolved references are rejected. Patterns and `with` are at most 200 characters, and every variable is capped at 256 code points after each step. Pipeline faults become `naming.invalid` findings; the pipeline never throws. `.`, `..` and a trailing `.git` (judged after NFKC) are always invalid (ADR-0095).
- The default pipeline for Bitbucket → GitHub routes is: `namespace = projectKey | lowercase`, `repository = slug | kebab`, `template = "{namespace}-{repository}"`.
- Rule precedence: repository-scope `override` > repository-scope pipeline > namespace-scope pipeline > Route default (`routes[].defaults.naming` in config; there is no database row for it).
- Team slugs use `routes[].defaults.teamNaming`, a pipeline over the variable `group`.
- `kebab` lowercases, replaces runs of characters outside `[a-z0-9]` with `-`, and trims `-` at either end.
- After templating, the name is validated against the target's `limits.repositoryName` (GitHub: ≤ 100 chars, `[A-Za-z0-9._-]`, case-insensitive uniqueness).
- **LIF-031 Blockers:**
  - `naming.invalid`: fails validation.
  - `naming.collision`: two source repositories on the Route produce the same name, case-insensitively. Every member of the collision is blocked.
  - `target.exists-nonempty`: the name exists on the target, has refs, and was not created by this Migration.
  - `target.owned-by-other-migration`: the target repository is already claimed by another Migration on the Route, either by the same `targetRepositoryId` or by a name that matches a target another Migration claims. Every Migration involved is blocked.
  - `target.exists-foreign-adopted`: an existing **empty** target is adopted automatically (Q12), so this is information only.

  Force-adopting a non-empty target is a Run option (`adoptNonEmpty: true`) that requires typed confirmation of the target name (LIF-043).
- Naming previews (`POST /api/v1/routes/{id}/naming/preview`) compute names and collisions for a candidate rule without saving it. The candidate replaces the saved rule of its own scope, and every other rule applies with the precedence above. No provider is contacted: the name limits come from the registry's static limits for the target type (409 when it has none), and the only existing targets seen are those claimed by Migrations of the Route. Every Migration of the Route is named in memory. The answer lists the in-scope Migrations plus every member of a collision group that involves one, cursor-paginated by Migration id. A Route with more than 20,000 present repositories is refused with 422. Nothing is written or enqueued (ADR-0331).
- An `override` rule stores the placeholder pipeline `{steps: [], template: ""}` next to its literal name; the override is read first, so the placeholder never runs (ADR-0364).

## Runs (LIF-040)

### Step order for a repository migrate / run-anyway / resync Run

| # | Step key | Notes |
|---|---|---|
| 1 | `preflight` | Re-checks `change-requests` and endpoint dependency blockers, plus quota availability. Aborts on new blockers. (LIF-041) |
| 2 | `git.prepare` | Mirror-clone into scratch, `git lfs fetch --all`, blob scan (FAC-GIT-004), compute LFS OIDs. No target writes before this succeeds. |
| 3 | `target.ensure-repository` | Create the repository with name, visibility and description, or adopt it. Records `targetCreatedByFramework` and `targetRepositoryId`, and upserts the target `Repository` row immediately. |
| 3a | `target.lift-protection` | Only when the target already has branch protection rules (resync, adoption): delete the rules matching refs about to be pushed, recorded as Mutations. Step 10 re-creates them. Rules matching `git-migrator/*` branches are lifted too. |
| 4 | `git.push-lfs` | `git lfs push --all` to the target |
| 5 | `git.push-refs` | Batched push (LIF-044). Then set the default branch. |
| 6 | `facet.repository-settings.apply`, `facet.merge-settings.apply` | |
| 7 | `facet.access-control.apply` | |
| 8 | `facet.environments.apply`, `facet.variables.apply`, `facet.deploy-keys.apply` | |
| 9 | `change-requests.open` | `code-ownership` and `pipelines` Change Requests (LIF-047). Runs before branch rules exist, so pushes to `git-migrator/*` branches are never blocked. Skipped with warning `git-refs.empty-repository` when the target has no default branch. |
| 10 | `facet.branch-rules.apply` | Also re-creates rules lifted in step 3a |
| 11 | `facet.webhooks.apply` | Allowlisted hooks only |
| 12 | `overlays.apply` | LIF-048 |
| 13 | `verify` | Parity check (LIF-060) |
| 14 | `source.read-only` | Only if `sourcePostAction = read-only`, the Run option `skipSourceReadOnly` is not set, steps 1–12 all succeeded, and `git-refs` parity is `equal` (LIF-070) |

- **Planning.** One planner serves `migrate`, `run_anyway` and `resync`, and later tasks register theirs per Run kind. The planner lists the Steps from the `step` PlanItems of the Run's own Analysis (`Run.analysisId`), in this order, and appends the advisory Step `analysis.refresh`, which analyzes the Migration again at the end of the Run. The Run applies the `desired` document of that Analysis, never a fresh translation, so a resume or a mid-Run Analysis cannot change what it writes. A Step the Plan lists with no implementation is planned as a skipped advisory Step and logged as a warning. A Run with no Analysis plans one fatal Step `run.analysis_missing` (ADR-0340, ADR-0380, ADR-0435).
- **Step rows.** A Step row is identified by its key and Facet. A start or a resume inserts the planned Steps that have no row yet, after the highest `order`. A stored unfinished row that the plan no longer contains ends with `run.plan_changed`: `failed` if it was planned `fatal` and had started (which fails the Run), otherwise `skipped`. A Step returns `succeeded`, `skipped` (with a reason for the Run log) or `delay` (with a duration and a reason). A thrown error is a failure of that Step. On success a Step may clear run-origin blockers it declares (`clearsBlockers`, LIF-049) (ADR-0340, ADR-0341).
- **Step details.** Step 2 runs the JOB-015 disk precheck, delaying the Run while space is short, and records `Repository.lfsBytes` and the size class. The blob scan uses the target's `limits.maxBlobBytes`, and the push limit is the smaller of `git.maxPushBytes` and the target's `limits.maxPushBytes`. A push Step rebuilds a mirror missing after a delay, under the same precheck and scan. Step 3a deletes only rules that match branches this Run is about to change: source branches the target lacks or has elsewhere, branches a reconcile deletes, and the `git-migrator/*` branches of Change Requests about to be opened. A resync that changes nothing lifts nothing. When a push Step fails for good after step 3a lifted rules, a run-origin post task names the lifted rules, and nothing re-applies them automatically. LFS objects are pushed only when the target reports them missing (ADR-0380).

- **LIF-041 Preflight** reads `change-requests` from the source live, re-judges the group principals of `access-control`, `branch-rules` and `code-ownership` against the current mappings, and checks the git quota; a blocked or empty bucket delays the Run. New blockers fail the Step with `preflight.blocked`, naming the codes, and mark the Analysis stale. They are not stored as run-origin blockers, so a Migration whose Change Requests were closed is not trapped (ADR-0380).
- **LIF-042 Failure semantics.** Each Step is planned with a severity, stored on its row: `fatal` (steps 1–5), `independent` (steps 6–12 and 14) or `advisory` (step 13 and `analysis.refresh`). The outcome is `failed` if any `fatal` Step failed, else `partial` if any `independent` Step failed, else `succeeded`. `advisory` failures are ignored (ADR-0341).
  - Step 13 (verify) never fails the Run. A parity error is recorded and the facet's ParityResult is `unverifiable`.
  - Step 14 failing makes the Run `partial`.
  - A single commit whose pack exceeds `git.maxPushBytes` is still pushed alone. If the provider rejects it, the Run fails with run-origin blocker `git-refs.push-too-large` (LIF-049).
  - Steps 1–5 are fatal on non-retryable failure: the Run becomes `failed`, and later steps are `skipped`.
  - Steps 6–12 are independent. A failed facet step is recorded, the remaining steps continue, and the Run ends `partial`.
  - Transient errors retry per ADP-060. A Step attempt that still fails with a retryable error, other than `rate_limited`, is retried by the executor with full-jitter exponential backoff from 1 s to 60 s. Each Step has a budget of `maxAttempts` failures (default 4). `RunStep.failures` counts them across resumes, including an attempt a worker died in. A Step found at its limit fails with `step.attempts_exhausted`. A non-retryable error fails the Step at once. The row is `pending` while it waits to retry, and the wait wakes on cancel and SIGTERM (ADR-0341).
  - Rate limiting pauses the Run: the job is delayed and resumes at the first non-succeeded step. Steps are idempotent, so resuming is safe. A rate limit, or a Step that returns `delay`, is not a failure. The Step goes back to `pending`, `RunStep.delays` increases, and the Run is handed off with a delay (LIF-046). The delay comes from the error's retry time, else `retryAfterMs`, else 60 s, and is at least 1 s. The number of rate-limit delays is unbounded; a Step bounds its own `delay` returns (JOB-015: 6).
  - A Step that fails for good may call a Run-level `onFailed` hook. An error in the hook is logged and never changes the outcome (ADR-0380).
  - Stored Step and Run errors keep `code`, a scrubbed `message` of at most 500 characters, `retryable`, `provider` and the request without secrets, and never a stack (ADR-0340).
- **LIF-043 Run options.** Options travel in the request body `options`. The typed confirmation is always the top-level body field `confirm`, the exact target full name. The options schema is strict: `adoptNonEmpty` and `skipSourceReadOnly` only. An unknown key is 422 (`run.options_invalid`), because a stored unknown option would silently never be honored. `confirm` is never stored. The target full name is the target Repository's `fullPath` when it exists, otherwise `<Route target namespace path>/<plannedTargetName>`. A missing or wrong confirmation is 422 `confirmation_required` (ADR-0343, ADR-0415).
  - `adoptNonEmpty` requires `confirm`, which must match exactly, and is refused for kinds that push no refs. The ref push then becomes a reconcile: force-push every source ref and delete target refs under `refs/heads/*` and `refs/tags/*` that aren't on the source, except `refs/heads/git-migrator/*`. The reconcile's deletions are recorded as inert records that are never undone (ADR-0380).
  - **Adoption.** An existing empty target is adopted, and the adoption is recorded as an `adopted` create record. A target this Migration claimed earlier, or one another Migration claims, is recognized first (`target.owned-by-other-migration`, a run-origin blocker), however far the other Migration has pushed. The claim (`targetRepositoryId`, `targetCreatedByFramework`, the target Repository row) is written under a per-name lock, so two Migrations cannot claim one repository. A repository found by name counts as created by the framework only on proof. Either the ledger holds a recorded, non-adopted creation of that provider id, or an unsettled create intent for the name exists, the repository is empty, and the provider's creation time (`RepositoryRecord.createdAt`) is not earlier than the intent, compared at second resolution. Clock skew can only err towards "not ours", so the repository is adopted and kept. Older open create intents for the name are settled `not_applied` before a new create. `target.ensure-repository` clears `target.exists-nonempty` and `target.owned-by-other-migration` when it passes (ADR-0380).
  - A `run_anyway` Run applies best-effort translations. Unmapped principals are skipped and unaccepted lossy decisions are applied as translated. Pre tasks stay open.
  - `resync` is identical to `migrate`, but targets an already-migrated repository.
- **LIF-044 Batched push.**
  1. Push LFS first.
  2. Push the default branch incrementally: walk `git rev-list --first-parent --reverse <default>` and push `<sha>:refs/heads/<default>` at checkpoints chosen so each push's estimated pack is ≤ `git.maxPushBytes` (default 1.5 GiB). Pack size is estimated with `git pack-objects --revs --stdout | wc -c` against the previously pushed checkpoint, or with `git rev-list --objects --disk-usage` when available.
  3. Push the remaining branches in groups of up to 50 refs, splitting a group when its estimate exceeds the limit.
  4. Push tags last, in groups of 100.
  5. Each push retries up to 3 times with backoff.

  `push.followTags` is off. `--atomic` is not used across groups.

  Only `refs/heads/*` and `refs/tags/*` are pushed (hidden refs stay in the mirror), never with `--mirror`, and refs already at the wanted commit are skipped. Estimates are only estimates: when the provider rejects a multi-commit push as too large, the target size is halved and the push is planned again, and a rejected group is split. Only a single commit or tag rejected alone raises `push-too-large` (LIF-042). Retries apply to retryable failures only (network, 5xx, unknown), with full-jitter exponential backoff from 1 s to 60 s. A per-ref rejection is a non-retryable `conflict` naming the refs and reasons. A remote command with no output for 10 minutes is killed and raises a retryable `transient` error (ADR-0240).
- **LIF-045 Mutation ledger.** Every write on either side records a Mutation, through `apply`, `target.ensure-repository`, `target.lift-protection`, `source.read-only` or Change Request creation. A Mutation stores `paths` (the canonical field paths it touched).
  - **Source-side filtering:** before translation and parity, resources created by active (not undone) source-side Mutations are removed from the source canonical document, matched by `resourceRef`. For example, the read-only `push` restriction on `*` is never translated to the target. Description prefixes are stripped by `normalize` (FAC-SET-003).
  - **Target-side:** Mutations on target resources that are not part of the desired document create `framework_mutation` Expected Differences for their paths. Examples are `git-migrator/*` branches and Change Requests.
  - **Adopted and no-op records:** a record for state that already existed (`resourceRef.adopted`) or for a write that changed nothing (`resourceRef.noop`) has `before` equal to `after`. Undo never reverts it, so undo never removes or rewrites state the Run did not change (ADR-0222, ADR-0231). An adapter that sends such a record with unequal images has `after` replaced by `before`. What undo reverts is defined once, in `core`: records not undone, not adopted, not no-op and not `not_applied`, newest first by `Mutation.seq`. Rollback uses that definition (ADR-0342).
  - **Writing.** A Step records each record as `apply` yields it, so the records of a partial `apply` are kept and an idempotent retry adds only what is new. Ledger writes are not fenced on the lease token: a record describes a change already made on a provider and is always kept, and a duplicate is harmless because undo is idempotent. A write that lands after its Run finished is still recorded. If the Run is `cancelled`, this is its first Mutation, no later Run exists and the Migration still has the status the cancel gave it, the Migration takes `run_finished(cancelled)` again and becomes `partial`. In every other case the Migration is not rewritten. Instead, a run-origin blocker `run.late-mutation` is added, the Analysis is marked stale and a warning is logged. A ledger write aborted by a deadlock or serialization failure is retried up to 5 times and then fails the attempt with a retryable `transient` error (ADR-0340, ADR-0342).
  - **Intents.** Before a provider call whose outcome could be lost (a create it cannot read back), a Step records an `intended` record. It settles the record as `recorded` (optionally with what really happened) or `not_applied` after the response or a read-back. A resumed Step finds its open intents (`writtenByStep`) and reconciles them first. Undo treats an unsettled intent as possibly applied. Settling an intent `not_applied` revokes only the Expected Differences it alone caused, and recomputes `Run.hasMutations`. A Facet `apply` runs under an inert umbrella intent that keeps the document before the write and the document the write meant to leave. A resumed Step records the paths that differ in both comparisons as a recovered write, minus the paths its own later records cover, so a change somebody else made meanwhile is not claimed (ADR-0342, ADR-0380). Documents in the ledger pass the same webhook URL reduction as FAC-WEB-002, and nothing else stored there holds a secret (ADR-0435).
  - **Origin.** Each write is `desired` (a Facet `apply`, compared by parity) or `framework` (a resource the desired document does not contain: `git-migrator/*` branches, framework Change Requests, the source read-only restriction). The caller decides the origin, never the adapter. A record without a Facet names its Expected Difference paths itself. The `framework_mutation` Expected Differences come from target-side `framework` records that are not adopted, not no-op and not deletions. Each is inserted once per Migration, Facet and path, and is never inserted again after an operator revoked it. Source-side records derive none (ADR-0342).
- **LIF-046 Concurrency guard and leases.**
  - DOM-010, plus a lease on the Run row: `leaseOwner` (worker ID) and `leaseExpiresAt` (renewed every 30 s, valid 2 min). A worker processes a Run only while holding the lease.
  - `maintenance.run-reaper` (every minute) re-enqueues `run.execute` for Runs whose lease expired while `running`. Steps are idempotent, so the Run resumes from the first non-succeeded step. After 3 reaper resumptions of the same Run, it is marked `failed` with error `{code: run.abandoned, resumes: 3}`. The reaper function does not change the Migration. An abandoned Run has no executor, so the same `maintenance.run-reaper` job then settles orphaned Migrations. A Migration that is `running` with no `queued` or `running` Run takes `run_finished` for its latest Run's outcome, under the Migration lock, using the executor's code; unfinished Steps are skipped. The same job re-enqueues a `queued` Run older than 120 s whose job is not pending, because its creator died before enqueuing (ADR-0343).
  - **Start and fence.** The executor starts a Run with one conditional update from `queued` to `running` that also takes the lease, so two jobs cannot both start it and a cancelled Run is never started; a re-delivered job does nothing. Every write that changes the Run's own state (Step status, findings, the end of the Run) first locks the Run row with the worker's lease token and status `running`. When no row matches, the worker stops, so a worker that lost its lease cannot move Steps or finish the Run. Writes that lock both rows take the Migration row, then the Run row, both `FOR NO KEY UPDATE`. Step-level writes lock only the Run row (ADR-0340).
  - **Ending.** Ending a Run is one transaction under both locks. It skips the pending Steps, sets the Run's status, `finishedAt`, error and cleared lease, applies `run_finished` with its effects, and publishes `run.updated` and `migration.updated` (JOB-060). An exception outside Step code does not release the lease. The lease expires and the reaper counts the resumption, so a deterministic crash ends as `run.abandoned` (ADR-0340).
  - **Cancel.** A `queued` Run is cancelled at once: `run_finished(cancelled)` with no Mutation returns the Migration to `statusBeforeRun`. The same applies to a Run whose lease holds a hand-off marker, such as one waiting for a delayed job. A `running` Run gets `cancelRequestedAt`. The executor polls it every 2 s and before every Step, and aborts the Step's signal, which reaches provider calls, git and Step checkpoints. The interrupted Step is stored `failed` with `run.cancelled`, the remaining Steps `skipped`, and the Run `cancelled`. A Run whose lease holds a reaper resume marker is only marked, and the resumed executor finishes it, because the old worker may still record a change (ADR-0340).
  - A `running` Run is expired when `leaseExpiresAt` has passed or, with no lease yet, when `updatedAt` is older than the lease validity (database clock). Leases are not re-entrant: a claim over a live lease fails, even from the same worker. A worker aborts a Run as lost when a renewal finds the row gone, or when no renewal has succeeded for 90 s.
  - Each resume is enqueued under its own stable job id, so job deduplication (JOB-011) cannot drop it. While the awaited job is waiting, delayed or active, the reaper only extends the wait and counts nothing, so a backlog can delay a Run but never abandon it. Each resume attempt counts exactly once, when its job claims the lease or when the job is found dead (ADR-0212).
  - On SIGTERM, a worker finishes its current step, releases the lease, and re-enqueues the Run (delay 0) instead of waiting for the whole job. A resume after such a hand-off is not counted as a reaper resumption (ADR-0212). SIGTERM is checked between Steps, and the current Step's signal is not aborted. A delay (LIF-042) uses the same hand-off: the lease is released into a marker and `run.execute` is enqueued under a stable id with the delay. The reaper only extends the wait for such a job and counts nothing (ADR-0340).
- **LIF-049 Run-origin findings.** Findings discovered during a Run are stored as ManualTasks (`origin: run`), or, for blockers, in `Migration.runBlockers` (`[{code, params, at}]`). Examples are `git-refs.blob-too-large`, `git-refs.push-too-large` and `deploy-keys.key-in-use`. Run-origin blockers are cleared only when a later Run's `git.prepare` (or the relevant step) passes, or when an operator dismisses them with a reason. Readiness includes them (LIF-004).
  - `Migration.runBlockers` holds one entry per code and params. A run-origin task is keyed by `(code, facetKey, paramsHash)` like an Analysis task and never reopens a task an operator completed. Each write takes the Migration and Run locks and recomputes readiness from the latest Analysis, the run blockers and all tasks. A Migration without an Analysis keeps `readiness` null unless a run blocker exists, in which case it is `blocked`. An Analysis never dismisses these findings (ADR-0343).
  - Run-time codes: `git.prepare` stores `git-refs.blob-too-large` and clears it when it passes. A provider size rejection becomes `git-refs.push-too-large` (cleared by `git.push-refs`) or `git-refs.blob-too-large`. A desired deploy key missing after the apply becomes `deploy-keys.key-in-use`. A force-push bypass list the target refused becomes the post task `branch-rules.exemptions-not-applied`. A push Step that fails for good after step 3a becomes the post task `branch-rules.protection-lifted`. A competing claim on the target repository becomes the blocker `target.owned-by-other-migration`, and a ledger write after the Run ended becomes `run.late-mutation` (LIF-045). Every code here except `run.late-mutation` has guidance (ADR-0342, ADR-0380).
- **LIF-047 Target Change Requests.** File changes go through the adapter's `ChangeRequestWriter`:
  1. Create branch `git-migrator/<purpose>` from the target default branch head.
  2. Commit the files with author `git-migrator <noreply@git-migrator.invalid>` and a message stating the purpose.
  3. Open a Change Request whose body explains the change and links to the Migration in the app.

  Ordering (step 9 before step 10), together with step 3a on resync, guarantees that branch protection never blocks the framework's own pushes. The GitHub App is never added to protection allowances.

  `code-ownership` is delivered by the target driver's own `apply`. Pipelines are rendered by the registry's `pipelinesDelivery` hook of the target adapter (ADP-032), from the source pipeline file read again in the Step and never persisted. Records written before a failure are still recorded. The branch gets a `framework_mutation` Expected Difference at `/refs[name=refs/heads/git-migrator/<purpose>]` of `git-refs`. The Migration link in the body is known to the adapter only for the duration of a Facet apply (ADR-0380).

  This is idempotent: an existing open Change Request for the same purpose is updated, not duplicated. A merged one is not reopened. An existing `git-migrator/<purpose>` branch is reused only when every commit it adds to the default branch has the framework author; otherwise the writer fails with `conflict` and writes nothing (ADR-0231).
- **LIF-048 Overlays.** An Overlay's partial canonical document is merged onto the desired target document, with overlay values winning. The merged paths get `overlay` Expected Differences, so parity ignores them. Step 12 and the Parity Check use one merge: enabled Overlays oldest first, objects merged, keyed collections merged by key, everything else (sets included) replaced, and prototype keys refused. The result is validated with the Facet schema. An `overlay` Expected Difference is recorded once and never re-created after a revocation (ADR-0380, ADR-0396). Overlays are written only through `/api/v1/overlays`. Each document is validated on write against the Facet's schema in deep-partial strict form: every object field optional, unknown keys refused at any depth, field rules kept, whole-document refinements dropped. Also refused: `__proto__`, `constructor` and `prototype` keys, nesting deeper than 32, and documents over 64 KB. The document is stored as sent (ADR-0362).

### Endpoint migration Run order (LIF-081)

`members` (invitations only via approved batches) → `teams` (create teams and set membership) → `org-variables` → `org-webhooks` → `verify`. Secrets produce post tasks only.

- The repository planner serves endpoint Runs too. It plans the `step` PlanItems of the Run's Analysis, maps each Facet Step to the shared ledger path (umbrella intent, records ledgered as they arrive, recovery on resume), adds `verify`, and closes with `analysis.refresh`. The four Facet Steps are `independent`. `members` writes nothing, because the target's `members` driver has no `apply` and people join only through approved Invitation Batches (AUTH-061). A person joins their teams in the first endpoint Run after their invitation is accepted and the mapping confirmed (ADR-0435).
- **Settling teams.** After `facet.teams.apply`, the Run lists the target's teams and upserts the target Group rows, refreshing slug and name. It then confirms the Route's GroupMappings whose `plannedSlug` equals the slug of a team this Migration created, with `targetGroupId` set. A team counts as created only when the ledger proves it: a `create` record, or a recovered write that recorded the team's slug or name path and in which the team was absent before. A slug is matched only when exactly one `unmapped` or `suggested` mapping plans it (or a `confirmed` one whose team is gone) and no confirmed mapping already holds the team. Otherwise a `teams.unmapped-principal` pre task asks for a decision. A team the framework did not create is never confirmed here. The writes take the target Endpoint's invitation lock and then the Route mapping lock (AUTH-061 lock order), check the lease, and condition each update on the status read under the lock. Each confirmation writes a `group-mapping.confirm` audit event with a null Actor, and the Run marks the Route's repository Analyses stale so that `access-control.team-missing` clears on re-Analysis (FAC-ACL-004) (ADR-0435).

## Parity (LIF-060)

Parity compares the **desired** target document with the **actual** target document per Facet. It never compares the raw source document directly with the target.

1. Read the source and target Snapshots. A verify Run re-reads both. A drift check re-reads the target, plus the source `git-refs` (and the full source only when `schedules.driftReadsSource` is true).
2. Apply source-side filtering (LIF-045) and `normalize`, then translate the source to `desired`.
   - `desired` contains the **approximated target value** for `translated` and `lossy` fields (for example `enforcement: enforced`, approvals capped at 6).
   - It contains Route defaults for `unreadable_defaulted` fields.
   - It contains Overlay values merged in.
   - Excluded and unmapped principals are omitted.
3. `compare(desired, target)` yields field diffs.
4. Subtract diffs whose path matches an active Expected Difference for this Migration or Route.
5. Store a ParityResult.

The source decides which Facets a Migration has, as in the Analysis: a Facet the source cannot read stores no result. The Parity Check uses the Analysis' inputs (mappings, capabilities, deploy-key usage) and the Overlay merge of LIF-048. Results are stored as follows (ADR-0395, ADR-0396):

- **One row per Migration and Facet**, updated in place, so DATA-020's "latest per facet" bounds the table. Rows of Facets the check did not produce are deleted, and a check that compares no Facet stores nothing. A check reads `Migration.parityGeneration` and the database clock (`checkedAt`) before any provider read. Under the Migration lock it stores nothing if the generation moved meanwhile, and it never replaces a row with a later `checkedAt`. Each stored check bumps the generation and publishes `migration.updated`.
- `diffs[].source` is the desired value and `diffs[].target` the actual value, at canonical field paths, so they can be accepted. At most 1,000 diffs and 1,000 `excluded` entries (`{path, expectedDifferenceId, reason}`) are kept; a last entry carries the total. The status is unaffected by the cap.
- `unverifiable` stores no diffs. Its reason goes to the Run log and the worker log only, never to the row.
- The writer redacts like the diff endpoint: a string under or at a sensitive key or selector becomes `[REDACTED]`, webhook URLs reduce to their origin, and every other string is scrubbed.
- A Facet whose source or target read fails, whose `compare` throws, or whose repository is gone is `unverifiable`. So is every Facet when the translation fails or the target found has a provider id other than the migrated one, and a Facet whose dependency's source read failed. A rate limit or an abort is not unverifiable: the check ends, the Run is delayed or the job retries, and nothing is stored.

**Role of each Expected Difference reason in parity (LIF-063):**

| Reason | Masks diffs? | Example |
|---|---|---|
| `framework_mutation` | yes, on target extras | `/refs[name=refs/heads/git-migrator/*]` present on target only |
| `identity_excluded` | yes | an excluded user that someone added on GitHub anyway: `/grants[principal=identity:123]` |
| `manual_accepted` | yes | drift accepted by an operator |
| `lossy_accepted`, `unreadable_defaulted`, `overlay` | no diff remains, because `desired` already holds the approximated, default or overlay value | kept as the auditable record of why target differs from source; shown in the UI |

Unreadable source fields (secret values, webhook secrets) are compared by presence or name only, as each Facet defines.

**ParityResult status:**

- `equal`: no diffs remain.
- `different`: diffs remain.
- `unverifiable`: the target Facet couldn't be read, or the verify step errored.

Facets with `compare: none` write no ParityResult: `change-requests` and `extras`.

**LIF-061** A Migration receives `parity_equal` when every Facet that writes a ParityResult is `equal` and no ManualTask is `open`. Verifiable tasks (completion `parity`) are auto-completed (status `done`, actor = system) when their Facet's `isTaskSatisfied` returns true. This is evaluated before the `parity_equal` check. It happens in the transaction that stores the ParityResults: `completedById` stays null, `note` is `parity.auto-completed`, and an AuditEvent `task.auto_complete` with a null Actor is written. Readiness is recomputed and `task.updated` published. An `unverifiable` Facet completes no task, and parity never dismisses one (ADR-0396).

**LIF-062** Parity runs at the end of every migrate, run-anyway, resync and verify Run, after task updates via the API, after Invitation status changes, and on demand. Inside a Run it is the `verify` Step (step 13, `advisory`; also the planner of `verify` Runs). Outside a Run it is the `parity.migration` job, deduplicated per Migration while waiting. That job checks a Migration in `migrated`, `partial`, `verified`, `manually_completed` or `drifted`, and leaves alone a Migration with a Run in flight. The API enqueues it after the commit of a task action or an Expected Difference create or revoke, and never runs a check inline. A failed enqueue does not undo the change. A Route-wide revoke enqueues one check per analyzed repository Migration of the Route, at most 500 (ADR-0396, ADR-0415).

## Drift (LIF-065)

- Applies to `verified` and `manually_completed` Migrations.
- Runs on schedule (default every 24 h), using FAC-GIT-006 containment once the source is read-only. Containment applies to every Parity Check while the source is read-only, verify Runs included (ADR-0397).
- Differences produce status `drifted`, keep `statusBeforeDrift`, store diffs, and emit an event.
- Resolutions:
  - **Resync:** a Run that rewrites the target from the source. Its status path is `running` → `migrated` → `verified` via `parity_equal` (LIF-002).
  - **Accept:** creates `manual_accepted` Expected Differences for the shown paths, then re-runs parity. `parity_equal` returns the Migration to `statusBeforeDrift`.
  - **Re-mark complete:** `mark_complete` from `drifted`.
- Changes made by the framework are excluded via Mutation-derived Expected Differences (Q15).

## Source read-only (LIF-070)

Default `sourcePostAction: read-only`, with per-Migration opt-out as a Run option `skipSourceReadOnly`. On Bitbucket this means:

1. Add a branch restriction `kind: push`, pattern `*` (all branches), with no users or groups.
2. Prefix the description with `[MIGRATED → <target web URL>] `.
   The repository update endpoint can also create or rename a repository (ADR-0036), so the adapter MUST: `GET` the repository first in the same step and never write if it is missing; send a body containing only `description` (never `name`); `GET` again afterwards and, if `is_private`, `fork_policy`, `project` or `mainbranch` changed, restore them and fail the step. A changed `name` is not restored (the rename changed the slug, so the old path no longer addresses the repository); the step fails with a manual-repair message (ADR-0222).

Both are Mutations, so undo (`undo_source_read_only` Run) deletes the restriction and restores the description. When identical state already exists (a restriction of that shape, or the prefix), nothing is written and nothing is undone: undo never removes state this Run did not write. A write whose response was lost is read back and recorded; if the read-back also fails, the step reports the write as possibly applied and needs a manual check before a retry (ADR-0222). `sourceReadOnlyApplied` tracks the state. Tags are not protected; Bitbucket has no tag restriction. This is noted in the guidance.

## Manual completion (LIF-075)

- Requires role ≥ `operator`, a non-empty reason, and an AuditEvent.
- The status becomes `manually_completed`.
- Revoking restores the computed status: `verified` if parity and tasks allow, otherwise the last Run outcome.
- Manual completion does not close tasks.
- Marking and revoking go through `transition()` in one transaction under the Migration lock, with `manualCompletion = {actorId, reason, at}`. The reason is trimmed and must be 1 to 500 characters, and a refused transition is 409. The "last Run outcome" is the status set by the latest finished Run that changed it; a cancelled Run counts only if it recorded a Mutation, and with no such Run the outcome is `migrated` (ADR-0415).

## Rollback (LIF-077)

- Available for every status except `running`, `source_missing`, `discovered` and `rolled_back`, provided the Migration has a target or Mutations to undo. For `verified` and `manually_completed`, the typed confirmation is required as for every rollback. Every `rollback` Run requires `confirm` equal to the target full name, compared case-insensitively after trimming; a Migration with no target to name needs none (ADR-0415).
- If `sourceReadOnlyApplied`, an `undo_source_read_only` Run must succeed first. The UI offers both in sequence.
- If `targetCreatedByFramework`: delete the target repository after typed confirmation of its full name. This requires the GitHub App permission `administration: write` and org policy allowing deletion. If deletion is forbidden, the Run fails with guidance.
- Otherwise (adopted): undo target Mutations in reverse order (delete created rules, hooks, keys, grants, variables, environments; close framework Change Requests), and leave git refs untouched.
- Afterwards the status is `rolled_back`, and the next Analysis returns it to `analyzed`.

## Endpoint migration (LIF-080)

There is one per Route, with its own Analysis, Runs and parity using endpoint Facets. Repository Migrations depend on it only through specific blockers (`access-control.team-missing`) and tasks (`access-control.pending-invitation`), so unrelated repositories proceed independently. A Run of the endpoint Migration never blocks repository Runs of the Route: DOM-010 limits each Migration separately, and no other limit applies (ADR-0343).

## Bulk actions and waves (LIF-090)

- Bulk actions apply to an explicit selection or a saved filter:
  - **analyze:** enqueue interactive analysis, capped at 200 per request.
  - **migrate-ready:** creates migrate Runs only for Migrations currently `ready` with a fresh Analysis; others are reported as skipped with a reason.
  - **assign-to-wave**, **remove-from-wave**.
- Waves (Q82): `name`, optional `targetDate`, `description`. Progress is a count by status. Wave members get priority in background analysis (JOB-022).
- Runs created by bulk actions are queued normally. Concurrency is bounded by worker configuration (JOB-012). Each Run is independent.
- A request carries exactly one of `ids` and `filter`. `ids` allows at most 1,000 array entries and 200 distinct ids. `filter` is the repositories-list filter with `routeId` required, resolved on the server to repository-scope Migrations. Every action is capped at 200 Migrations per request: a selection or filter that matches more is 422 and nothing is done. Unknown ids are skipped as `not_found` (ADR-0406).
- Each item is handled in its own transaction and writes its own AuditEvent. Migrate-ready creates every Run through the Run guard (DOM-010), and its own pre-checks only refine the reason. Skip reasons: `not_found`, `not_repository`, `source_missing`, `route_retired`, `not_ready`, `not_analyzed`, `analysis_stale`, `run_active`, `not_permitted`, `already_in_wave`, `not_in_wave` and `queue_unavailable`. When the enqueue fails after a Run was created, that Run is cancelled, the item is skipped as `queue_unavailable`, and the remaining items are skipped without creating Runs (ADR-0405).
- Assigning and removing need the Waves capability; analyze and migrate-ready need the run capability. Wave membership is not an Analysis input, so it marks nothing stale. Remove-from-wave with a `waveId` removes only that Wave's members. Wave create, edit and delete go through the Model API (API-012). The feeder's order (JOB-022) already gives members priority (ADR-0407).
