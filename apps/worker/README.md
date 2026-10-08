# @git-migrator/worker

Process entrypoints: worker roles, scheduler leader, migrate.

Status: `src/worker.ts` (T-028) and `src/migrate.ts` and `src/db-commands.ts` (T-010, T-020, T-028) are implemented.

## `worker --role <standard|large|all>` (DEP-002)

`src/worker.ts` starts the queue Workers of the role (`@git-migrator/jobs`), the health server on port 8081 (`/healthz`, `/readyz`), the metrics server (`metrics.port`), a pod-local scratch cleaner, and, for `standard` and `all`, the scheduler leader election that registers the job schedulers from config (ARC-023, JOB-050). `maintenance.prune` calls `QuotaService.prune()`; `MetricRecorders` is the quota metrics sink. The handle also carries the adapter host environment (quota and lease gates, raw capture, telemetry). SIGTERM and SIGINT stop gracefully. `pnpm dev` runs it with `--role all`.

## `migrate` (DATA-030)

`src/migrate.ts` runs `runMigrate` and exits non-zero on the first failure. In order: schemas and `pg_trgm`, ZenStack migrations (`app`), Better Auth migrations (`auth`, `@git-migrator/auth`), BullMQ backend migrations (`bullmq`, `@git-migrator/jobs`), then config sync. `db-cli.ts` also runs `seed` and `reset`. `seed` creates the Better Auth users of the seeded test Actors when `auth.testSignIn.enabled` is true, with the password from `GM_TEST_USER_PASSWORD` (AUTH-012); it refuses to run in production.

Connection budgets per process are in `docs/deployment.md`.

Declared internal dependencies (ARC-012, checked by `pnpm lint`): @git-migrator/auth, @git-migrator/jobs, @git-migrator/config, @git-migrator/observability, @git-migrator/db, @git-migrator/registry, @git-migrator/quota.
