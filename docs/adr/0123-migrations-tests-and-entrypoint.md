# ADR-0123: Migrations, database tests and the migrate entrypoint

- Status: agent-decided
- Date: 2026-10-08
- Task: T-010
- Affects: DATA-011, DATA-030, DATA-031, DATA-040, TST-001, DEV-040, ARC-012

## Context

DATA-011 wants some indexes as raw SQL "where ZModel can't express it". DATA-030 describes the `migrate` entrypoint, and the dependency rules (ARC-012) keep `db` from importing `config`.

## Decision

1. **Which indexes are raw.** ZModel expresses the plain, composite, descending and GIN indexes, and the `gin_trgm_ops` trigram index (`@@index([fullPath(ops: raw("gin_trgm_ops"))], type: Gin)`), so those are declared in `schema.zmodel` and created by the generated `..._init` migration, which is prefixed by hand with `CREATE EXTENSION IF NOT EXISTS pg_trgm` (the shadow database and a bare `zen migrate deploy` need it; step 1 creates it too, idempotently). ZModel cannot express **partial** indexes, so `..._raw_indexes` creates the two partial unique indexes (DOM-010, DOM-014) and the partial `expected_difference` index. Prisma's diff ignores partial indexes, CHECK constraints and triggers; a test runs `zen migrate dev --create-only` against a migrated database and asserts the proposed migration is empty. A third migration, `..._integrity_constraints`, adds the CHECK that ties `Migration.scope` to `sourceRepositoryId` and the `updated_at` triggers (ADR-0122).
2. **Migration directory names** are fixed (`20261008000001_init`, `20261008000002_raw_indexes`) instead of wall-clock stamps, so the order is stable across branches. New migrations are generated with `pnpm --filter @git-migrator/db migrate:dev --name x` (`--create-only`) and reviewed before commit (DATA-031: forward-only; a test rejects drop and rename statements).
3. **`_prisma_migrations`** lives in schema `public` (Prisma's choice with `schemas = ['app']`), so the "owner of the three schemas" role also needs to create tables in `public` (the default on PostgreSQL 16 for the database owner).
4. **Where the migrate entrypoint lives.** `packages/db` exports the steps (`ensureSchemas`, `applyAppMigrations`, `syncConfig`, `seedDev`). `apps/worker/src/db-commands.ts` composes them with config (apps may depend on anything) and `db-cli.ts` is the thin `pnpm db:migrate | db:seed | db:reset | generate` runner. Steps 3 (Better Auth, T-020) and 4 (BullMQ, T-028) are added between steps 2 and 5 by those tasks. `db:seed` and `db:reset` run only when `environment` is `development`, `test` or `e2e` **and** was set explicitly (GM_ENVIRONMENT, or an `environment:` key in the config file), because a defaulted value reads as `development` (ADR-0051). `db:reset` also needs `--yes`. The CLI runs under plain `node` (type stripping only), so the generated client is generated with `importWithFileExtension = '.ts'` and everything it imports must avoid parameter properties, enums and namespaces (`packages/core/src/naming.ts` was changed accordingly); a test spawns the real CLI. `applyAppMigrations` copies the schema and migrations to a temporary directory and runs the ZenStack CLI there, because the CLI writes a temporary Prisma schema next to the schema file and the package is read-only in the container (DEP-003). The CLI runs in its own process group; SIGTERM and SIGINT are forwarded to that group (handlers are installed before the copy is made), the copy is removed once the group has exited, and the call rejects, so a Kubernetes pod stop leaves neither a directory nor an orphaned Prisma engine.
5. **Database tests run in the unit tier** (`packages/db/src/*.test.ts`, `apps/worker/src/db-commands.test.ts`), because the integration tier (`testing/integration`) is T-075 and a requirement ID only counts for a test that runs. Each file creates a database named `gm_t010_<random>` (or `gm_test_<random>`) with `createTestDatabase()` from `@git-migrator/db/testing`, migrates it and drops it afterwards. The admin connection is `GM_TEST_DATABASE_URL`, default `postgresql://git_migrator:git_migrator@127.0.0.1:5432/postgres` (the devenv/Compose role, which needs `CREATEDB`). CI therefore needs a PostgreSQL 16 service; `.github/workflows/ci.yml` gets one.
6. **Generated code is committed** (`packages/db/src/generated`), because the root `pnpm test` and CI run without a generate step. A test regenerates into a temporary directory and compares, so it cannot go stale. Biome and coverage skip the directory.
7. **`createDb` swallows idle-client `error` events** on a pool it creates; an unhandled event from a server-side disconnect would otherwise crash the process.
8. **The TST-012 test-profile fixture-world seed** is not part of `seedDev`; it lands with T-043/T-075.

## Alternatives

- PGlite for the tests: no service in CI, but `zen migrate` needs a real server, so the migration path would go untested.
- Putting the entrypoint in `packages/db` and reading config there: forbidden by ARC-012.
