# ADR-0475: The integration tier, its script and CI job, and how the Phase-1 scenario is composed

- Status: agent-decided
- Date: 2026-10-09
- Task: T-075
- Affects: TST-001, TST-002, TST-005, TST-020, DEP-060

## Context

`pnpm test:integration` was a stub. Every file under `testing/integration/src` ran in the unit project of `pnpm test`, because `testing/*/src/**/*.test.ts` is a unit glob. TST-001 makes the integration tier a tier of its own that CI runs. TST-020 names `testing/integration/phase1.test.ts`, but the package keeps its tests under `src/` (they are type-checked by `tsconfig.tests.json`).

## Decision

1. The integration tier is a second Vitest project, `integration`, with the glob `INTEGRATION_INCLUDE` (`testing/integration/**/*.test.*`, in `tools/test-globs.ts`). It runs every file of the package. `pnpm test:integration` runs `vitest run --project integration`.
2. Both: the existing files of `testing/integration` also stay in the unit project, because the TST-005 thresholds are measured from them (without them `packages/jobs` falls from above 80% to 66.6% lines, and the adapters drop too). Only the new, slow Phase-1 scenario (`INTEGRATION_ONLY`) is excluded from `pnpm test`, so `pnpm test` gains no time. `pnpm test` is now `vitest run --coverage --project unit`. A later task may merge coverage from both projects and move the files out of `pnpm test`.
3. The package `testing/integration` has no `test` script of its own, so `turbo run test` does not run the slow tier a second time. The root script is the entry point.
4. CI gets a job `integration` beside `checks`, with the same Postgres service. The fakes and the git http-backend are started by the tests on ephemeral ports, so the job needs nothing else.
5. The scenario lives in `testing/integration/src/phase1.test.ts` (the package convention), not `testing/integration/phase1.test.ts`.
6. The scenario is composed from the processes' own composition roots, so it exercises the real API and worker code paths: `runMigrate` and `runSeed` (the `db:migrate` and `db:seed` commands), `buildApiRuntime` (the web process's API with real Better Auth test sign-in and the producer-side job runtime) and `startWorker` with role `all` (every queue handler on BullMQ-on-Postgres). They are exported through new `exports` entries of `apps/worker` and `apps/web`. Configuration is a YAML file named by `GM_CONFIG_FILE`, and secrets are environment values, as in a deployment. The existing suites (`migrate`, `source-read-only`, `endpoint-migration`) keep driving the executor directly and are not duplicated.
7. Step 3 triggers analysis explicitly through `POST /migrations/{id}/analyze` for Migrations with no or a stale Analysis (TST-020 allows "the background feeder or an explicit analyze"), so the test does not depend on the feeder's schedule.

## Alternatives

- Keep the files in the unit project too: `pnpm test` stays slow and every integration file runs twice in CI.
- Run the tier inside the `checks` job: one job to read, but a failure in the slow tier hides lint and unit results, and the job time grows.
- Call the executor and processors directly, as the other integration files do: faster, but it would not cover sign-in, the HTTP API, job routing or the queue.
