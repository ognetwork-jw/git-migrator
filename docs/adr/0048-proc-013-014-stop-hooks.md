# ADR-0048: Scope, triggers and loop guard of the SubagentStop and Stop hooks

- Status: accepted (no spec change needed)
- Date: 2026-10-08

## Context

PROC-013 says to run `pnpm turbo run typecheck test --filter=...[origin/main]` when a subagent in `.worktrees/T-*` has commits beyond the base. ADR-0045 changes that base to `origin/ai-main`. PROC-014 says to run the full Definition of Done in the main checkout once `progress.md` says every task is merged. Neither says what to do when the base cannot be resolved, what "merged" means in the table, what happens when the check keeps failing, or how reviewers are kept out. Without a guard, a failing check blocks every stop, and the orchestrator can be trapped in a loop that re-runs the full Definition of Done on every stop.

## Decision

- **Loop guard (both hooks).** Claude Code sends `stop_hook_active: true` when the stop is already being continued by a hook. In that case a failing check prints a warning with the tail of the output and lets the stop through (exit 0). It blocks (exit 2) at most once per stop sequence. The same guard is in `gate_failure` in `.claude/hooks/lib.sh`.
- **Explicit timeouts.** `Stop` has a 1800 s timeout and `SubagentStop` a 900 s timeout in `.claude/settings.json`. Pre- and post-tool hooks have 60 s.
- **PROC-013** (`.claude/hooks/subagent-stop-check.sh`). It runs only when the hook's `cwd` matches `*/.worktrees/T-*`. Reviewer agents are skipped when the payload names one (`agent_type` or `agent_name` starting with `reviewer-`). This field name is not verified against a live payload. If the payload does not expose it, reviewers in a task worktree still run the check, as the spec allows, and the time cost is accepted. The hook counts `origin/ai-main..HEAD` in the worktree. A count of zero allows the stop without running the check. An unresolvable base blocks (fail closed), with a hint to run `git fetch origin ai-main`.
- **PROC-014** (`.claude/hooks/stop-dod.sh`). It runs only in the main checkout (a root with a `.git` directory) and only when `docs/process/progress.md` has at least one `| T-xxx |` row and every row is `merged` or `split`. `split` counts as done: the task was divided, and its parts are tracked in their own rows. Any other status keeps the hook quiet.
- **Green-state cache (PROC-014).** A green run is recorded in `.git/gm-dod-green` as a checksum of `HEAD`, `git status --porcelain`, `git diff HEAD` and the contents of untracked, non-ignored files. A later stop with the same state skips the Definition of Done. A red run is never cached, so the next stop runs again.

## Consequences

- While `test:integration`, `test:e2e` and `helm:check` are not implemented (`tools/not-implemented.ts`), PROC-014 fails once every task is merged or split. That is the intended signal, and the loop guard means it warns instead of trapping the session.

## Affected requirements

PROC-013, PROC-014, ADR-0045.
