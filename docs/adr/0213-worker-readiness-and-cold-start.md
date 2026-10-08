# ADR-0213: Worker readiness probe and cold start

- Status: accepted (spec updated)
- Date: 2026-10-08
- Task: T-028
- Affects: DEV-010, DEV-030, DEP-030, DEP-002

## Context

ADR-0137 gave the devenv `worker` process a `pgrep -f src/dev-worker.ts` probe, because the T-002 placeholder listened on no port. T-028 replaces that file with the real worker, which has the health server of DEP-030 on port 8081. The real worker also needs a migrated database: started on a fresh or still-starting database it used to exit with an uncaught error, and `node --watch` never restarts a process that exited.

## Decision

- `devenv.nix` `processes.worker.ready` is an HTTP probe on `127.0.0.1:8081/readyz` (`period = 2`, `timeout = 120`). This amends ADR-0137 item 2 (the web probe is unchanged).
- The devenv worker command runs `pnpm db:migrate` first, retried every 2 s, at most 60 times (Postgres up, password set), then the process fails, then `exec`s `pnpm --filter @git-migrator/worker dev -- --role all`. Migrate is idempotent.
- The worker starts its health server first. `/healthz` is 200 from the start, `/readyz` is 503 until the queue workers run. It then waits for the database and for the `app` and `bullmq` schemas with exponential backoff (1 s up to 10 s), logging one structured line per attempt, and exits with one logged error after 3 minutes. With `NODE_ENV=development` (devenv and Compose `dev`) it waits for ever and logs every 30 s, so a slow `db:migrate` never kills a `node --watch` process. SIGTERM during start-up aborts the wait, closes what has started and exits 0.
- The dev databases (devenv and Compose) have no TLS, while `postgres.sslmode` defaults to `require` for production. The devenv worker command exports `GM_POSTGRES_SSLMODE=disable` before `pnpm db:migrate`, and Compose `dev` sets `GM_POSTGRES_SSLMODE: disable` and `GM_POSTGRES_HOST: postgres`. Only these dev configurations change; the production default stays `require`.
- Compose `dev` still runs `pnpm dev`; its comment says to run `docker compose exec dev pnpm db:migrate`, and the worker waits for it meanwhile.
- On shutdown `/readyz` turns 503 first, `/healthz` stays 200 while jobs drain, and the health server closes last.
- **No forced exit after start-up (amended in round 4).** A SIGTERM that arrives while start-up is in progress arms a 30 s timer, so a stage that cannot be interrupted does not hang the pod; the timer is cleared as soon as `startWorker` settles. A SIGTERM after start-up only drains: in-flight jobs finish their current step (and hand their Run off), and the process exits 0 when the drain ends, with no timer of its own. The pod's `terminationGracePeriodSeconds` (120 s standard, 600 s large) is the only bound, so the process never cuts a step short before the platform does. A second signal is ignored. The life cycle is `runWorkerProcess` in `apps/worker/src/worker.ts`.

## Alternatives

- A fixed 30 s forced exit after SIGTERM (the first version): kills Runs mid-step well inside the grace period, and three deploys during long steps abandon a Run.
- A backstop per role, longer than the grace period: the kubelet's SIGKILL at the end of the grace period already is that backstop.

- Keep the `pgrep` probe against `src/worker.ts`: reports ready while the worker is still waiting for the database.
- Let the worker run migrations itself: the migrate Job owns schema changes (DATA-030).

## Affected requirements

DEV-010, DEV-030, DEP-030, DEP-002.
