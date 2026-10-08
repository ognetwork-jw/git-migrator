# Agent Workflow

This is how the orchestrator, implementor, reviewer and merge agents build git-migrator. The human does not review code along the way (Q70). The human validates at the end, starting with the live e2e test.

## Roles (PROC-001)

| Role | Responsibilities | Edits |
|---|---|---|
| **Orchestrator** | Owns [15-work-breakdown](../spec/15-work-breakdown.md) and `progress.md`. Starts tasks whose dependencies are merged, dispatches reviewers, decides when a loop ends, folds `agent-decided` ADRs into the spec, keeps `docs/followups.md`. | `docs/spec/**`, `docs/process/progress.md`, `docs/followups.md`, `docs/adr/**` (status changes) |
| **Implementor** | Implements exactly one task in its own worktree and branch. Writes tests and descriptive docs. Records `agent-decided` ADRs. Fixes review findings. | Everything except `docs/spec/**` |
| **Reviewer** | Reviews one task's PR against the spec, the task's acceptance criteria and [review.md](review.md). Returns findings only. | Nothing |
| **Merge agent** | Rebases reviewed branches onto `main`, resolves conflicts, re-runs CI, fast-forwards `main`. | Conflict resolutions only |

## Lifecycle of a task (PROC-002)

1. The orchestrator marks the task `in_progress` in `progress.md` and creates a worktree: `git worktree add .worktrees/T-xxx -b task/T-xxx-<slug> origin/main`.
2. The implementor works in that worktree and commits with Conventional Commits (`feat(core): …`, `fix(adapter-github): …`), using one commit per logical change. When it's done, it pushes the branch and opens a PR titled `T-xxx: <title>`, whose body lists the requirement IDs and acceptance checklist.
3. CI must be green before review starts.
4. **Review loop** (PROC-020), at most 5 rounds:
   1. The orchestrator dispatches **two reviewers in parallel**: a *spec-conformance* reviewer (does it do exactly what the spec says, and are tests meaningful?) and an *adversarial* reviewer (failure modes, security, concurrency, idempotency, data loss, edge cases).
   2. Reviewers return findings labeled BLOCKER, MAJOR or MINOR ([review.md](review.md)).
   3. If there are no BLOCKER or MAJOR findings, the loop ends. Any MINOR findings are fixed in the same pass if a fix pass happens; if only MINORs remain, the loop ends without a fix pass (Q69).
   4. Otherwise the implementor fixes **all** findings, including MINORs. Each fix is folded into the commit it corrects with `git commit --fixup=<sha>`, then `git rebase -i --autosquash origin/main` (non-interactive via `GIT_SEQUENCE_EDITOR=:`), then a force-push to the task branch. A *new* commit is allowed only when a finding demands genuinely new functionality.
   5. CI must be green again, then the next round starts.
   6. If round 5 still has BLOCKER or MAJOR findings, the orchestrator ends the loop anyway. It appends each open finding to `docs/followups.md` (task, round, severity, finding, file and line), then proceeds to merge.
5. **Merge:** the merge agent rebases onto the current `main`, resolves conflicts (keeping both sides' intent), re-runs CI, and fast-forward merges. History stays linear, with no merge commits. The branch and worktree are deleted.
6. The orchestrator updates `progress.md` and starts newly unblocked tasks.

## Model selection (PROC-007)

Every subagent runs on the **cheapest model tier that is appropriate for its work**. Tiers, from cheapest to most capable: `haiku` < `sonnet` < `opus`. `fable` (Mythos tier) is never used.

**Agent definitions.** T-003 creates one definition per role in `.claude/agents/`. The `model` frontmatter sets that role's default tier:

| Agent file | Role | Default `model` | Rationale |
|---|---|---|---|
| `orchestrator.md` | Orchestrator (top-level session) | `opus` | Owns the plan, spec folding and loop decisions. Runs for the whole project, but does little token-heavy work itself. |
| `implementor.md` | Implementor | `sonnet` | Most tasks are well-specified code against the spec. |
| `reviewer-spec.md` | Spec-conformance reviewer | `sonnet` | Checklist-style comparison of the diff to the requirement IDs. |
| `reviewer-adversarial.md` | Adversarial reviewer | `sonnet` | Raised per task tier (below). |
| `merge-agent.md` | Merge agent | `haiku` | Rebase, CI and fast-forward. Escalates on conflicts (below). |
| `explorer` (built-in `Explore`) | Read-only lookups for any role | `haiku` | Locating code and docs only. |

**Per-task tiers.** Each task in [15-work-breakdown](../spec/15-work-breakdown.md) carries a **Tier** (`L`, `M` or `H`). The orchestrator passes the Agent tool's `model` parameter accordingly, overriding the role default:

| Task tier | Implementor | Spec reviewer | Adversarial reviewer |
|---|---|---|---|
| `L`: mechanical (scaffolding, config, docs, CI glue, straightforward CRUD UI) | `haiku` | `haiku` | `sonnet` |
| `M`: typical feature work | `sonnet` | `sonnet` | `sonnet` |
| `H`: correctness-critical (state machine, translation engine, quota, git transport, run executor, parity, pipelines translation, auth and policies) | `sonnet` | `sonnet` | `opus` |

High-tier implementation still starts on `sonnet`. Capability is concentrated in the adversarial review, where mistakes are caught.

**Escalation (PROC-008).** The orchestrator raises the implementor one tier (haiku → sonnet → opus) for the remaining rounds of a task when:

- CI fails twice in a row on the same task;
- a review round ≥ 3 still has BLOCKER findings; or
- the implementor reports it is stuck.

The merge agent escalates to `sonnet` when a rebase has conflicts beyond lockfiles or generated files. Escalations are recorded in `progress.md`, in the "Notes" column with the tier used. Tiers never de-escalate within a task.

**PROC-009** The final whole-repository review (PROC-030) uses `opus` for both reviewers.

**PROC-003** Parallel implementors never share a worktree. When two in-flight tasks are likely to touch the same files (for example both edit `schema.zmodel`), the orchestrator SHOULD serialize them.

**PROC-004** Commit messages end with the attribution trailer configured in the environment, if one is configured.

## Ambiguity handling (PROC-005)

When the spec is silent or contradictory, the implementor:

1. Picks the most reasonable option consistent with the rest of the spec.
2. Writes `docs/adr/NNNN-<slug>.md` with `status: agent-decided`, context, decision, alternatives and the affected requirement IDs.
3. Mentions it in the PR.

The orchestrator either folds the decision into the spec (and sets the ADR `status: accepted (spec updated)`), or rejects it and opens a follow-up task. All `agent-decided` ADRs are listed in `docs/handoff.md` for the human.

## Definition of Done

PROC-006:

- `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm test:integration` are green. CI is fully green.
- Coverage thresholds are met (TST-005).
- Every requirement ID listed for the task is referenced by at least one test, where testable.
- Affected descriptive docs are updated: package README, provider docs, `docs/README.md` for new commands.
- No `TODO` without a linked follow-up entry.
- If the chart was touched: `pnpm helm:check` and helm-unittest pass.
- No secrets, tokens or real customer data are committed. A `gitleaks` check runs in CI.

## Claude Code hooks

PROC-010 … PROC-014.

T-003 creates `.claude/settings.json` and `.claude/hooks/*.sh`. All hooks read the hook JSON from stdin and exit `2` with a message on stderr to block.

| ID | Event | Matcher | Behavior |
|---|---|---|---|
| PROC-010 | `PostToolUse` | `Edit\|Write\|MultiEdit` | Run `biome check --write` on the edited file if it's a supported type. Report remaining errors (exit 2 so the agent fixes them). |
| PROC-011 | `PreToolUse` | `Edit\|Write\|MultiEdit` | Block edits to `docs/spec/**` when the target path is inside `.worktrees/` (implementor context). The orchestrator works in the main checkout. |
| PROC-012 | `PreToolUse` | `Bash` | Block `git push` with `--force`/`-f` when the target is `main`. Block `git commit --no-verify`. Block `rm -rf` outside `.worktrees/` and scratch directories. |
| PROC-013 | `SubagentStop` | — | If the subagent's cwd is inside `.worktrees/T-*` and the branch has commits beyond `origin/main`, run `pnpm turbo run typecheck test --filter=...[origin/main]`. On failure, exit 2 with the failing output tail. Reviewers make no commits, so they are unaffected. |
| PROC-014 | `Stop` | — | In the main checkout: if `progress.md` says every task is merged, run the full DoD (`lint typecheck test test:integration test:e2e helm:check`) and block on failure. |

## Final review (PROC-030)

T-097: a final pair of reviewers (spec-conformance and adversarial) reviews the *whole repository* against every spec file, using the same severity rules and the same 5-round cap. The output is `docs/handoff.md`.

## Files

- `docs/process/progress.md`: task table (ID, status, branch, PR, loops, notes).
- `docs/followups.md`: unresolved findings and deferred items.
- `docs/handoff.md`: final state for the human (T-097).
