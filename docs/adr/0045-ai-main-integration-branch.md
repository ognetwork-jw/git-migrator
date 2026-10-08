# ADR-0045: Agents integrate into `ai-main`; the human merges into `main`

- Status: accepted (user decision)
- Date: 2026-10-08
- Affects: PROC-002 (steps 1, 5), PROC-012, workflow "Merge" step, kickoff

## Context

The workflow has the merge agent fast-forward `main` after each review loop. In this environment an
automated permission check refused an agent push to `main`. The user asked to use an `ai-main`
branch instead and reconcile `main` later.

## Decision

- `ai-main` is the integration branch. Task worktrees branch from `origin/ai-main`, task PRs target
  `ai-main`, the merge agent rebases onto and fast-forwards `ai-main`, and the orchestrator commits
  `progress.md`, `followups.md`, ADR status changes and spec folding to `ai-main`.
- Agents never push to `main`. The human reviews and merges `ai-main` into `main`.
- Wherever the spec or process docs say `main` for agent integration (worktree base, rebase target,
  `origin/main` in hooks such as PROC-013's `--filter=...[origin/main]`, CI triggers), read `ai-main`.
  CI (T-003) runs on pushes and PRs to both `ai-main` and `main`.

## Consequences

`main` lags behind until the human merges. Branch deletion is also blocked in this environment, so
merged `task/*` branches remain on the remote for the human to clean up.
