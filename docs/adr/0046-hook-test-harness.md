# ADR-0046: Hooks are tested by running them in bash against real temporary repositories

- Status: accepted (no spec change needed)
- Date: 2026-10-08

## Context

T-003 requires the Claude Code hooks (PROC-010 … PROC-014) to be logic that is tested, not just configuration. The hooks are bash scripts that read hook JSON from stdin and block by exiting 2. The repository has no bash test framework, and the existing tooling runs everything through vitest in `pnpm test`.

## Decision

- Hook scripts live in `.claude/hooks/`. Shared parsing lives in `.claude/hooks/lib.sh`. `.claude/settings.json` wires them, and `.claude/hooks/*.sh` are the only executables.
- `tools/hooks.test.ts` runs every hook as a real `bash` process with sample hook JSON on stdin. It asserts exit 2 (block) or 0 (allow), and that the stderr names the requirement ID. Git and biome run for real, in temporary repositories created by the test. Nothing contacts a remote.
- Two environment variables replace the expensive or environment-bound commands in tests: `GM_HOOK_PROC013_CMD` (default `pnpm turbo run typecheck test --filter=...[origin/ai-main]`) and `GM_HOOK_PROC014_CMD` (default: the full Definition of Done). They are not used in normal runs.
- Hooks fail closed: no `jq`, or stdin that is not JSON, exits 2.
- `tools/agent-tooling.test.ts` checks the agent definitions and the CI workflow statically.

## Alternatives

- A bats test suite: adds a dependency and a second test runner, and `pnpm test` would not run it.
- Running the hooks only in CI: the hooks guard live agent sessions, so they must be checked before the session runs them.

## Affected requirements

PROC-010, PROC-011, PROC-012, PROC-013, PROC-014, PROC-007 (agent definitions), DEP-060 (CI workflow).
