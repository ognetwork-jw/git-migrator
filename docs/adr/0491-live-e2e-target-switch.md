# ADR-0491: The live e2e chooses its target with `GM_E2E_TARGET` and fails closed

- Status: agent-decided
- Date: 2026-10-09
- Task: T-095
- Affects: TST-006, TST-030, TST-031, DEV-040

## Context

TST-030 asks for `testing/e2e/live/phase1.live.spec.ts` with "the same steps as TST-021" against real accounts, and the work breakdown asks for a "dry" mode (`GM_E2E_TARGET=fakes`) that CI runs. TST-006 forbids tests from calling a real provider, except the live e2e; "never in CI" is the table's rule (`Live e2e ... ✗ (human, on demand)`). The spec does not say how the target is chosen, what stops a live run in CI, or what happens when the dry mode meets an endpoint the fakes lack.

## Decision

1. `GM_E2E_TARGET` is `fakes` or `live`. It has **no default**: unset or any other value is an error (`src/live/target.ts`), so a typo never selects the live mode and a missing variable selects nothing.
2. `live` is refused (fail closed, before anything starts, in the global setup, the spec and the reset script) when:
   - any of `CI`, `GITHUB_ACTIONS`, `GITLAB_CI`, `BUILDKITE`, `JENKINS_URL`, `TF_BUILD`, `TEAMCITY_VERSION`, `CODEBUILD_BUILD_ID`, `BITBUCKET_BUILD_NUMBER`, `CIRCLECI`, `DRONE` or `BUILD_ID` is non-empty (even `false`);
   - `GM_ENVIRONMENT` is set to anything but `e2e` (the provider HTTP client refuses real hosts under `test`, TST-006);
   - `GM_CONFIG_FILE` is unset or names a missing file;
   - the configuration is not the real accounts: `environment` is not `e2e`, test sign-in is off, an endpoint points at a loopback address, a placeholder of `config.e2e.example.yaml` is left, or an ID is 0;
   - a secret is missing (`BITBUCKET_CREDENTIALS`, `GITHUB_APP_PRIVATE_KEY`, `GM_TEST_USER_PASSWORD`).
   Every reason is listed in one message with the command that fixes it.
3. The dry mode runs the same spec, preconditions and Octokit and Bitbucket clients against the TST-021 stack (`harness/stack.ts`). It builds its context from the running fakes with fake credentials only. CI runs it as a step of the `e2e` job after the UI tier (`pnpm --filter @git-migrator/e2e test:e2e:live:dry`; root script `pnpm test:e2e:live:dry` builds the web app first). It is an addition to the DEV-040 script table.
4. The fakes lack some endpoints (the source tag listing, source file lookups, Actions variables, and, on the target, whatever was pushed over git as seen through REST). A context may list such checks in `skipChecks` (`bitbucket-tags`, `bitbucket-lfs`, `github-variables`, `github-refs`, `github-contents`, `github-protection`). Only the `fakes` target honours the list, and the dry global setup is the only code that sets it, so a live run can never skip a check. The skipped assertions are reported as skipped Playwright tests, not hidden.
5. The provider clients of the live spec use Octokit with App authentication (TST-030) and a small `fetch` client for Bitbucket. They are not `ProviderHttpClient` and bypass the quota service: they are test code that runs a handful of reads against dedicated test accounts, and the AGENTS.md rule is about the application's provider traffic. They are never imported by application code (ARC-012).
6. The precondition checks read GitHub through `GET /orgs/{org}/installation` with the App JWT (permissions, repository selection, ID, suspension) rather than `GET /app/installations/{id}`, because the former is what the fake GitHub implements and both exist on GitHub.

## Alternatives

- Infer the target from `CI` or from the presence of a config file: implicit, and a laptop with a stale file would run live.
- A separate spec file for the dry mode: two specs drift apart, and the dry mode would not guard the live spec.
- Skip the checks the fakes lack by editing them per mode in the check code: the live mode would then share code paths that can skip.
