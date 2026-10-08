# git-migrator documentation

| Area | Location | Nature |
|---|---|---|
| Specification | [spec/](spec/00-overview.md) | Normative. Orchestrator-owned. |
| Decisions | [adr/](adr/README.md) | Decision log. `agent-decided` entries need human review. |
| Process | [process/kickoff.md](process/kickoff.md), [process/workflow.md](process/workflow.md), [process/review.md](process/review.md), `process/progress.md` | How agents build this |
| Providers | [providers/bitbucket-cloud.md](providers/bitbucket-cloud.md), [providers/github.md](providers/github.md) | API usage, permissions, limits, quirks |
| Live e2e | [e2e-setup.md](e2e-setup.md) | Human setup for the live test |
| Follow-ups | [followups.md](followups.md) | Unresolved review findings, deferred work |
| Deployment | `deployment.md` (written by T-090) | Azure and Helm operations |
| API usage | `api-usage.md` (written by T-062) | Automation via RPC and `/api/v1` |
| Handoff | `handoff.md` (written by T-097) | Final state for the human |

## Commands

The root [README](../README.md) lists the commands; the ones added by T-001 are `pnpm lint` (Biome plus the ARC-012 dependency check), `pnpm typecheck` (`tsc -b`), `pnpm test` (Vitest with the TST-005 coverage thresholds), `pnpm check:packages` (the same checks through Turborepo), `pnpm spec:coverage` (requirement IDs without tests; add `-- --strict` to gate) and `pnpm spec:must-test` (regenerate `must-test.txt`). Commands owned by later tasks currently print "not yet implemented (T-xxx)". T-002 extends the getting-started section below.

## Getting started

T-002 writes this section: devenv path, Docker Compose path, secretspec setup and the first run.
