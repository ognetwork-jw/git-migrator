# ADR-0492: Live e2e stack, fixture constants and reset

- Status: agent-decided
- Date: 2026-10-09
- Task: T-095
- Affects: TST-030, TST-031, TST-032, DEV-030, DEV-040

## Context

TST-030 to TST-032 say that the live test signs in with test sign-in under config profile `e2e` and secretspec profile `e2e`, and that `pnpm e2e:live:reset` uses "the app's own rollback and undo code paths when the app DB has the records, and direct provider calls otherwise". They do not say how the app is started for the live run, which values come from the configuration, or where the app DB comes from. The draft `docs/e2e-setup.md` also asked for a project key in the configuration, which the configuration schema has no field for.

## Decision

1. **Stack.** `pnpm test:e2e:live` builds the web app and runs Playwright under `secretspec run --profile e2e`. The global setup starts the same worker and standalone web app as the UI tier (`harness/stack.ts`, `launchApp`), on a throw-away database in the local Postgres (`GM_TEST_DATABASE_URL`, or `git_migrator` with `POSTGRES_PASSWORD` on `127.0.0.1:5432`), with the Endpoints and Route of `GM_CONFIG_FILE` (default `live/config.e2e.yaml`, relative to `testing/e2e`; the repository-root form `testing/e2e/live/config.e2e.yaml` of TST-030 and an absolute path work too; it is resolved to an absolute path once, because the web app runs from `apps/web/.next/standalone` and a relative path would name nothing there) and `GM_ENVIRONMENT=e2e`. There are no fakes. The web app listens where `publicUrl` says, which must be `http://127.0.0.1:<port>` so sign-in cookies and origin checks agree.
2. **Fixture constants.** The Bitbucket project key (`E2E`), repository (`e2e-auto-ok`), its settings and the planned target name (`e2e-e2e-auto-ok`) are constants of the fixture (`LIVE_FIXTURE`), not configuration: they are what `docs/e2e-setup.md` tells the human to create. The configuration holds only the workspace, the organization, the App ID and the installation ID, as in the schema.
3. **Order.** The global setup checks the preconditions (TST-031) before it starts the database and the processes, so an unmet precondition is reported before anything is created. The spec checks them again as its first test, so the report shows it.
4. **Reset.** `pnpm e2e:live:reset` (a) when `GM_E2E_APP_URL` names a running app (a `pnpm dev` with a persistent database) and the Migration is known, starts its `undo_source_read_only` Run, then its `rollback` Run with the typed confirmation; (b) then, always, cleans with direct provider calls what is left, each side independent of the other's failure: deletes `{org}/e2e-e2e-auto-ok` only after reading it and finding the fixture's description and homepage (otherwise it refuses), deletes the `push` restriction on `*` that has no users or groups, and removes the `[MIGRATED → …] ` description prefix with a body that holds `description` only (LIF-070, ADR-0222). Each call tolerates "already done", so the script is idempotent and works without an app, which is the normal case because the test's own database is thrown away. An app failure is logged and the direct calls still run. It logs the workspace, repository and organization before writing, accepts only a loopback `GM_E2E_APP_URL`, scopes its Migration lookup to the source Endpoint and project, and refuses like the test does (ADR-0491).
5. **Configuration and artefacts.** The context requires exactly two Endpoints and one Route between them whose `targetNamespace` is the App's org. A live run writes logs and failure screenshots to `testing/e2e/live-artifacts/` and records no trace, since both can hold real secrets.
6. **Typecheck.** `tsconfig.tests.json` also includes `testing/e2e/harness/*.ts` and `testing/e2e/live/*.ts`, so the global setups, the reset entry point and the Playwright configurations are type-checked by the root `pnpm typecheck`; before, only files reachable from a `*.spec.ts` were.
7. **Shared flow.** The browser steps moved from `phase1.spec.ts` into `harness/phase1-flow.ts` and take the operator, the password, the repository text and a wait multiplier, so the two specs cannot drift (TST-030: "the same steps as TST-021"). `harness/chromium.ts` holds the Chromium lookup that three configurations repeated.

## Alternatives

- Make the live test use a persistent database so that the reset always has app records: the starting state would then depend on earlier runs.
- Put the project key and repository name in the configuration: the schema is strict and has no such key, and the fixture is fixed by the setup guide.
- Run the reset through the database directly: bypasses the app's own code paths that TST-032 asks for.
