# ADR-0485: How the UI e2e tier (TST-021) starts its stack

- Status: agent-decided
- Date: 2026-10-09
- Task: T-087
- Affects: TST-001, TST-006, TST-021, DEV-001

## Context

`pnpm test:e2e` was a stub. TST-021 asks for Playwright specs against "the full app (web + worker) against the fakes", signed in through the test form. `testing/e2e` held only the visual suite, which mocks the API. The Phase-1 spec (T-083) and the NeedsAttention spec (T-087) need the same stack.

## Decision

1. `testing/e2e/playwright.config.ts` runs every `*.spec.ts` in `testing/e2e` except `visual/` and `live/`, which keep their own configurations. One worker, no retries, one shared stack: the specs run one after another, and each owns a repository of the fixture world.
2. `testing/e2e/harness/global-setup.ts` starts the stack once (`harness/stack.ts`) and sets `GM_E2E_BASE_URL`, which the config reads for `baseURL`:
   - a throw-away Postgres database (`createTestDatabase`), then `runMigrate` and `runSeed`, the code behind `pnpm db:migrate` and `pnpm db:seed`;
   - the TST-012 fakes (`startWorldFakes`) with the world loaded, in the Playwright runner process;
   - the worker (`startWorker`, role `all`) in the same process, so a spec needs no worker process management;
   - the web app as a real child process: the standalone build through `apps/web/scripts/start-standalone.mjs`, on a free port, with the configuration file and secrets in its environment, as a deployment would give them.
3. The configuration is the same YAML and environment the Phase-1 integration test uses (ADR-0475), with `publicUrl` set to the web app's own origin so Better Auth accepts the sign-in.
4. The root script `pnpm test:e2e` builds the web app first (as `test:visual` does) and then runs `playwright test` in `@git-migrator/e2e`.
5. Specs sign in through the real form (`harness/ui.ts`) and wait on what a user sees. Nothing in a spec reads the database or the fakes' state.

6. Teardown closes each step on its own with a 60 s bound, and the web process group gets SIGTERM, then SIGKILL after 10 s, so a hung step cannot keep the database from being dropped. A spec that shares one browser context across its steps traces it by hand and keeps the trace and a screenshot only when a step failed (the config sets `trace: 'off'`).
7. A spec that claims a live update proves it: `watchLive` waits for `data-live-mode="sse"`, plants a no-reload marker and records any switch to `polling`; `expectLiveStayedSse` asserts both after the result showed.
8. (T-087, arrives with its spec.) The NeedsAttention spec covers "complete a task" by dismissing it: the only task of `data/unmapped-user` is the resolution task `access-control.unmapped-principal`, which the server refuses to mark done (LIF-006). The spec asserts that refusal. Its guidance has no value to copy, so the spec asserts the guidance text only; copy controls are covered by the guidance view's unit tests.
9. The web and worker logs go to `testing/e2e/logs/` (the worker log is redacted; the web log is raw Next.js output); CI uploads them with `test-results/` when the job fails. Traces and logs embed what the pages and processes handled, so the e2e credentials must stay fake.

## Alternatives

- Playwright `webServer` entries for the web app and the worker: they cannot know the database name and the fake ports, which are chosen at start.
- A worker child process: closer to a deployment, but the worker's health port and logging are then process-level concerns of every spec author. The integration tier already runs `startWorker` in process.
- One stack per spec file: slower, with no isolation gain, since each spec uses its own repositories.

## Consequences

The harness imports the fixtures, fakes, database and worker packages, so `testing/e2e` declares them as dependencies (`testing/*` may depend on anything, ARC-012). T-083 adds the Phase-1 spec to the same config; a merge of the two harnesses should keep one `stack.ts`.
