# ADR-0455: Local gate while GitHub Actions cannot run jobs

- Status: agent-decided
- Date: 2026-10-09
- Task: orchestration (PROC-020 merge step)
- Affects: PROC-006, PROC-020

## Context

From 2026-10-09 12:53 UTC every GitHub Actions job on this repository ends as `failure` within seconds, with no runner assigned (`runner_id: 0`), no steps and no logs. This happens on every PR head and on re-runs. The last job that ran was on 12:04 UTC. The cause is outside the repository, for example account billing or Actions settings. The orchestrator cannot fix it. The merge rule requires CI green on the exact head before `ai-main` is fast-forwarded. Before T-003 added the workflow, "CI green" meant that the Definition of Done commands pass locally.

## Decision

While Actions cannot run jobs, a reviewed head (both reviewers ACCEPTABLE, or only MINORs left) may be fast-forwarded into `ai-main` when the merge agent has run the CI job's commands locally on that exact head and they pass:

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`, re-running known load flakes alone
- `pnpm helm:check`
- gitleaks over `origin/ai-main..HEAD` with the pinned 8.30.1 binary

The Docker image build is not reproduced locally.

- Only `ai-main` is affected; `main` is never pushed.
- Each merge made this way is recorded in `docs/process/progress.md` as `local gate (ADR-0455)`.
- When Actions runs jobs again, CI is re-run on the `ai-main` head. Any failure there is fixed before the next merge.
- The fallback ends as soon as Actions runs jobs again.

## Alternatives

- Wait for Actions to return. This stalls all integration, because every remaining task depends on merges.
- Stop and hand off. Not needed: this blocks only one gate, and that gate has a local equivalent.

## Addendum (same day)

`helm` and `kubeconform` are not installed in the orchestration container, so `pnpm helm:check` cannot run there. It is required only when the merged diff touches chart or deploy files (`deploy/`, `charts/`, Helm values or templates); otherwise it is waived and the waiver is noted in the merge report. A diff that touches those files waits for Actions or for a machine with the tools.
