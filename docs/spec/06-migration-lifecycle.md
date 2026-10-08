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
| `revoke_complete` | `manually_completed` | `verified` if the latest parity is all equal and no tasks are open, else `statusBeforeManual` | |
| `source_missing` | any except `running` | `source_missing` | `statusBeforeMissing := from`. While `running`, the event is deferred until `run_finished`. |
| `source_present` | `source_missing` | `statusBeforeMissing` | |

Runs of every kind go through `running`. `verified` and `manually_completed` Migrations can start resync, verify, rollback and source read-only Runs.

### Readiness (LIF-004)

`Migration.readiness` is recomputed by the server whenever an Analysis completes, a ManualTask changes, a Run records findings, or a Mapping changes. It is never stored only on the Analysis.

- `blocked` if the latest Analysis has a blocker, or there is an open **run-origin blocker** (LIF-049).
- `needs_attention` if any `pre` task is `open`.
- `ready` otherwise.

Post tasks never affect readiness. The UI shows them as "N follow-up tasks" next to Ready.

**LIF-005 Readiness required per Run kind:** `migrate` requires `ready`. `run_anyway` requires `ready` or `needs_attention`. `resync` requires anything except `blocked`. `verify`, `rollback`, `source_read_only` and `undo_source_read_only` are not gated by readiness or blockers. A violation returns 422.

### Completing tasks (LIF-006)

Each finding code declares a `completion` mode in its FacetDefinition (ADP-030):

- **`manual`:** an operator marks it done, for example after reading a branching-model warning.
- **`accept`:** for `<facet>.accept-lossy` tasks. Marking done creates a Migration-scoped `lossy_accepted` Expected Difference recording the task's paths and policy key.
- **`resolution`:** cannot be marked done directly. Resolved only by changing the underlying data, for example `access-control.unmapped-principal` via an Identity Mapping confirm or exclude, which re-runs the Analysis. `done` returns 422. `dismiss` (with reason) is allowed and means "proceed without it".
- **`parity`:** verifiable. Auto-completed when the Facet's `isTaskSatisfied(task, targetDoc, parityResult)` predicate returns true. Operators may also mark it done manually.

## Route policies (LIF-011)

See FAC-005. Policies and per-Route `defaults` come from config. Changing them marks every Analysis on the Route stale.

## Analysis (LIF-020)

An Analysis runs in an analysis job (JOB-020):

1. Load the Route, mappings, naming rules, allowlist, overlays and Expected Differences.
2. Read every in-scope Facet from the source, storing Snapshots. Remove resources created by the framework's own source-side Mutations before translation (LIF-045). Endpoint dependencies apply only to principals referenced in this repository's own documents (FAC-006). Unrelated workspace membership never affects a repository's readiness.
3. Resolve the planned target name (LIF-030). Find the target by `Migration.targetRepositoryId` if set, otherwise by name. If it exists, read all target Facets too. A target whose ID equals `targetRepositoryId` is **owned** by this Migration and never raises `target.exists-*` blockers.
4. For each Facet, run `normalize` → `translate`, with Route policies applied (FAC-005).
5. Compute the Plan:
   - Steps (LIF-040 order).
   - Blockers, including name collisions, an existing non-empty target (LIF-031), `change-requests.open` and dependency blockers.
   - `pre` and `post` tasks, and warnings.
6. Persist the Analysis and PlanItems. Upsert ManualTasks by `(code, facetKey, paramsHash)`: existing done tasks stay done, and analysis-origin tasks no longer produced are set to `dismissed` with note `obsolete`. Run-origin tasks and blockers (LIF-049) are never dismissed by an Analysis.
7. Recompute readiness (LIF-004), `blockerCodes` and `readinessCounts`. Set `analysisStaleAt = now + schedules.analysisStaleAfter`, then apply event `analysis_completed` (LIF-002).

Analyses are **stale** after `schedules.analysisStaleAfter` (default 7 d), or when Route config (`Route.configHash`), policies, mappings, naming rules, allowlist or overlays change, or when inventory sees a newer `Repository.providerUpdatedAt` (LIF-021). Starting a migrate, run-anyway or resync Run re-analyzes inline first when the Analysis is stale **or older than `schedules.runRequiresAnalysisWithin`** (default 24 h). If readiness got worse, the Run aborts with `readiness_changed` and the UI shows the new findings (LIF-022).

## Naming (LIF-030)

```ts
type NamingPipeline = { steps: NamingStep[]; template: string };
type NamingStep =
  | { var: 'namespace' | 'repository' | 'group'; op: 'projectKey' | 'slug' | 'name' }   // initializes the variable from the source object
  | { var: string; op: 'lowercase' | 'kebab' | 'truncate'; arg?: number }
  | { var: string; op: 'replace'; pattern: string; with: string };
```

- The default pipeline for Bitbucket → GitHub routes is: `namespace = projectKey | lowercase`, `repository = slug | kebab`, `template = "{namespace}-{repository}"`.
- Rule precedence: repository-scope `override` > repository-scope pipeline > namespace-scope pipeline > Route default (`routes[].defaults.naming` in config; there is no database row for it).
- Team slugs use `routes[].defaults.teamNaming`, a pipeline over the variable `group`.
- `kebab` lowercases, replaces runs of characters outside `[a-z0-9]` with `-`, and trims `-` at either end.
- After templating, the name is validated against the target's `limits.repositoryName` (GitHub: ≤ 100 chars, `[A-Za-z0-9._-]`, case-insensitive uniqueness).
- **LIF-031 Blockers:**
  - `naming.invalid`: fails validation.
  - `naming.collision`: two source repositories on the Route produce the same name, case-insensitively. Every member of the collision is blocked.
  - `target.exists-nonempty`: the name exists on the target, has refs, and was not created by this Migration.
  - `target.exists-foreign-adopted`: an existing **empty** target is adopted automatically (Q12), so this is information only.

  Force-adopting a non-empty target is a Run option (`adoptNonEmpty: true`) that requires typed confirmation of the target name (LIF-043).
- Naming previews (`POST /api/v1/naming/preview`) compute names and collisions for a candidate rule without saving it.

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

- **LIF-042 Failure semantics.**
  - Step 13 (verify) never fails the Run. A parity error is recorded and the facet's ParityResult is `unverifiable`.
  - Step 14 failing makes the Run `partial`.
  - A single commit whose pack exceeds `git.maxPushBytes` is still pushed alone. If the provider rejects it, the Run fails with run-origin blocker `git-refs.push-too-large` (LIF-049).
  - Steps 1–5 are fatal on non-retryable failure: the Run becomes `failed`, and later steps are `skipped`.
  - Steps 6–12 are independent. A failed facet step is recorded, the remaining steps continue, and the Run ends `partial`.
  - Transient errors retry per ADP-060.
  - Rate limiting pauses the Run: the job is delayed and resumes at the first non-succeeded step. Steps are idempotent, so resuming is safe.
- **LIF-043 Run options.** Options travel in the request body `options`. The typed confirmation is always the top-level body field `confirm`, the exact target full name.
  - `adoptNonEmpty` requires `confirm`. The ref push then becomes a reconcile: force-push every source ref and delete target refs under `refs/heads/*` and `refs/tags/*` that aren't on the source, except `refs/heads/git-migrator/*`.
  - A `run_anyway` Run applies best-effort translations. Unmapped principals are skipped and unaccepted lossy decisions are applied as translated. Pre tasks stay open.
  - `resync` is identical to `migrate`, but targets an already-migrated repository.
- **LIF-044 Batched push.**
  1. Push LFS first.
  2. Push the default branch incrementally: walk `git rev-list --first-parent --reverse <default>` and push `<sha>:refs/heads/<default>` at checkpoints chosen so each push's estimated pack is ≤ `git.maxPushBytes` (default 1.5 GiB). Pack size is estimated with `git pack-objects --revs --stdout | wc -c` against the previously pushed checkpoint, or with `git rev-list --objects --disk-usage` when available.
  3. Push the remaining branches in groups of up to 50 refs, splitting a group when its estimate exceeds the limit.
  4. Push tags last, in groups of 100.
  5. Each push retries up to 3 times with backoff.

  `push.followTags` is off. `--atomic` is not used across groups.
- **LIF-045 Mutation ledger.** Every write on either side records a Mutation, through `apply`, `target.ensure-repository`, `target.lift-protection`, `source.read-only` or Change Request creation. A Mutation stores `paths` (the canonical field paths it touched).
  - **Source-side filtering:** before translation and parity, resources created by active (not undone) source-side Mutations are removed from the source canonical document, matched by `resourceRef`. For example, the read-only `push` restriction on `*` is never translated to the target. Description prefixes are stripped by `normalize` (FAC-SET-003).
  - **Target-side:** Mutations on target resources that are not part of the desired document create `framework_mutation` Expected Differences for their paths. Examples are `git-migrator/*` branches and Change Requests.
- **LIF-046 Concurrency guard and leases.**
  - DOM-010, plus a lease on the Run row: `leaseOwner` (worker ID) and `leaseExpiresAt` (renewed every 30 s, valid 2 min). A worker processes a Run only while holding the lease.
  - `maintenance.run-reaper` (every minute) re-enqueues `run.execute` for Runs whose lease expired while `running`. Steps are idempotent, so the Run resumes from the first non-succeeded step. After 3 reaper resumptions of the same Run, it is marked `failed` with error `run.abandoned`.
  - On SIGTERM, a worker finishes its current step, releases the lease, and re-enqueues the Run (delay 0) instead of waiting for the whole job.
- **LIF-049 Run-origin findings.** Findings discovered during a Run are stored as ManualTasks (`origin: run`), or, for blockers, in `Migration.runBlockers` (`[{code, params, at}]`). Examples are `git-refs.blob-too-large`, `git-refs.push-too-large` and `deploy-keys.key-in-use`. Run-origin blockers are cleared only when a later Run's `git.prepare` (or the relevant step) passes, or when an operator dismisses them with a reason. Readiness includes them (LIF-004).
- **LIF-047 Target Change Requests.** File changes go through the adapter's `ChangeRequestWriter`:
  1. Create branch `git-migrator/<purpose>` from the target default branch head.
  2. Commit the files with author `git-migrator <noreply@git-migrator.invalid>` and a message stating the purpose.
  3. Open a Change Request whose body explains the change and links to the Migration in the app.

  Ordering (step 9 before step 10), together with step 3a on resync, guarantees that branch protection never blocks the framework's own pushes. The GitHub App is never added to protection allowances.

  This is idempotent: an existing open Change Request for the same purpose is updated, not duplicated. A merged one is not reopened.
- **LIF-048 Overlays.** An Overlay's partial canonical document is merged onto the desired target document, with overlay values winning. The merged paths get `overlay` Expected Differences, so parity ignores them.

### Endpoint migration Run order (LIF-081)

`members` (invitations only via approved batches) → `teams` (create teams and set membership) → `org-variables` → `org-webhooks` → `verify`. Secrets produce post tasks only.

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

**LIF-061** A Migration receives `parity_equal` when every Facet that writes a ParityResult is `equal` and no ManualTask is `open`. Verifiable tasks (completion `parity`) are auto-completed (status `done`, actor = system) when their Facet's `isTaskSatisfied` returns true. This is evaluated before the `parity_equal` check.

**LIF-062** Parity runs at the end of every migrate, run-anyway, resync and verify Run, after task updates via the API, after Invitation status changes, and on demand.

## Drift (LIF-065)

- Applies to `verified` and `manually_completed` Migrations.
- Runs on schedule (default every 24 h), using FAC-GIT-006 containment once the source is read-only.
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

Both are Mutations, so undo (`undo_source_read_only` Run) deletes the restriction and restores the description. `sourceReadOnlyApplied` tracks the state. Tags are not protected; Bitbucket has no tag restriction. This is noted in the guidance.

## Manual completion (LIF-075)

- Requires role ≥ `operator`, a non-empty reason, and an AuditEvent.
- The status becomes `manually_completed`.
- Revoking restores the computed status: `verified` if parity and tasks allow, otherwise the last Run outcome.
- Manual completion does not close tasks.

## Rollback (LIF-077)

- Available for every status except `running`, `source_missing`, `discovered` and `rolled_back`, provided the Migration has a target or Mutations to undo. For `verified` and `manually_completed`, the typed confirmation is required as for every rollback.
- If `sourceReadOnlyApplied`, an `undo_source_read_only` Run must succeed first. The UI offers both in sequence.
- If `targetCreatedByFramework`: delete the target repository after typed confirmation of its full name. This requires the GitHub App permission `administration: write` and org policy allowing deletion. If deletion is forbidden, the Run fails with guidance.
- Otherwise (adopted): undo target Mutations in reverse order (delete created rules, hooks, keys, grants, variables, environments; close framework Change Requests), and leave git refs untouched.
- Afterwards the status is `rolled_back`, and the next Analysis returns it to `analyzed`.

## Endpoint migration (LIF-080)

There is one per Route, with its own Analysis, Runs and parity using endpoint Facets. Repository Migrations depend on it only through specific blockers (`access-control.team-missing`) and tasks (`access-control.pending-invitation`), so unrelated repositories proceed independently.

## Bulk actions and waves (LIF-090)

- Bulk actions apply to an explicit selection or a saved filter:
  - **analyze:** enqueue interactive analysis, capped at 200 per request.
  - **migrate-ready:** creates migrate Runs only for Migrations currently `ready` with a fresh Analysis; others are reported as skipped with a reason.
  - **assign-to-wave**, **remove-from-wave**.
- Waves (Q82): `name`, optional `targetDate`, `description`. Progress is a count by status. Wave members get priority in background analysis (JOB-022).
- Runs created by bulk actions are queued normally. Concurrency is bounded by worker configuration (JOB-012). Each Run is independent.
