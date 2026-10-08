# ADR-0137: devenv test waits on readiness probes; Postgres is probed over the socket

- Status: agent-decided
- Date: 2026-10-08

## Context

The first CI run of `devenv test` (job 113332239938, devenv 2.4.0) started Postgres, the one-shot `postgres-password`, web and worker, then printed nothing for 55 minutes until it was cancelled. `enterTest` never ran. The job-level `timeout-minutes: 60` did not stop the step.

Findings from the devenv v2.4.0 source and a local reproduction (devenv 2.4.0 from nixpkgs, non-root user):

1. With devenv 2.x the process manager is `native`. `devenv test` builds the test script, then starts the processes (`start_processes`, `ClientRunMode::ReturnAfterStart`) and runs the test script only after that returns (`devenv/src/devenv/mod.rs`, `Devenv::test`).
2. Starting the processes runs the process task graph to completion (`Tasks::run_with_parent_activity`). A process task finishes when its process is launched, except when the process has a readiness probe. `ProcessConfig::has_readiness_probe` is true for a `ready` block, a TCP `listen`, or any `ports`. Such a task waits for the phase `Ready`, `GaveUp`, `Exited`, `Stopped` or `NotStarted` (`devenv-tasks/src/tasks.rs`). A process without a probe never blocks, and a one-shot that exits does not either.
3. `services.postgres` sets a `ready.exec` probe (`pg_isready -d template1 && psql -c "SELECT 1" template1`) and `ports.main`, so Postgres is always waited on. `ready.timeout` defaults to null, so the wait has no deadline.
4. The Postgres module exports `PGHOST=127.0.0.1`, so the probe's `psql` connects over TCP. ADR-0066 sets `--auth-host=scram-sha-256`, and the OS superuser has no password. The probe fails with `fe_sendauth: no password supplied` for ever, and `devenv test` never reaches `enterTest`. Reproduced locally: all processes up, no `enterTest`, and the same `psql` command fails by hand.
5. `process-compose-wait` and `wait_for_processes` in devenv's `tests.nix` are only defined (not called) for the native manager. They are not the cause.

## Decision

1. Override the Postgres probe: `processes.postgres.ready.exec = lib.mkForce ...` runs `psql -h "$DEVENV_RUNTIME/postgres" -p "${PGPORT:-5432}" -d template1 -c 'SELECT 1'` over the Unix socket (trust, ADR-0066), after the `.devenv_initialized` marker exists. `timeout = 150` bounds the wait; on expiry the phase becomes `GaveUp`, devenv proceeds, and `enterTest` fails with a clear message.
2. `web` gets an HTTP readiness probe (`GET http://127.0.0.1:3000/`, `period = 2`, `timeout = 120`). `worker` listens on no port, so its probe is `pgrep -f src/dev-worker.ts` (same period and timeout).
3. `postgres-password` stays a one-shot process with `restart.on = "never"` and no probe. devenv does not wait on it (finding 2), so it neither blocks nor counts as ready.
4. `enterTest` no longer polls `pg_isready` and the web port (the probes cover both). It keeps one bounded wait (150 s) for what no probe covers: `git_migrator` logs in over TCP with its scram password (`PGPASSWORD` from `secretspec run`, never in argv) and `rolcreatedb` is true. It then makes one `curl` check of the web placeholder before the checks.
5. The checks run as `pnpm lint`, `pnpm typecheck` and `pnpm test`, one after another, as `ci.yml` does. The first CI run with working readiness probes (job 113367802463) ran them as one `pnpm turbo run lint typecheck test` graph; on the hosted runner that overloaded the CPU, and two timing-budget tests in `packages/observability` (DEP-050) missed their budgets (1099 ms against 1000 ms, and a 6 s timeout). Running the three in sequence matches the load the main CI job puts on the same runner type.
5. CREATEDB. `initialDatabases` creates the role without `CREATEDB`, and T-010's tests (ADR-0123, `GM_TEST_DATABASE_URL`, default role `git_migrator`) create throw-away databases. `set-postgres-password` now runs `ALTER ROLE git_migrator WITH LOGIN CREATEDB PASSWORD ...`. The `enterTest` wait in item 4 proves it.
6. The `Run devenv test` workflow step has `timeout-minutes: 30`, so a hang fails that step instead of waiting for the job limit.

## Alternatives

- Set `PGHOST` to the socket directory for the processes: rejected. It changes every client in the shell, and the app is meant to connect over TCP.
- Put the password into the probe (`PGPASSWORD`): rejected. The password comes from `secretspec run` and must not enter Nix evaluation (ADR-0066).
- Use trust for TCP in CI: rejected. It would make CI differ from the documented environment (DEV-010).
- Turn `postgres-password` into a task or `enterShell` step: rejected. It needs the final server, which only exists after the process starts.
- Keep `enterTest` polling instead of probes: rejected. The hang happens before `enterTest`.

## Unverified

- A full green `devenv test` run on a GitHub runner; the local reproduction used the nixpkgs channel instead of `devenv-nixpkgs/rolling` and no devenv cache.

Affected requirement IDs: DEV-001, DEV-010, DEP-060, ADR-0123 (database tests).
