# @git-migrator/worker

Process entrypoints: worker roles, scheduler, migrate.

Status: `src/db-commands.ts` implements the `migrate`, `seed` and `reset` commands (T-010, T-020); the worker roles come with later tasks (see `docs/spec/15-work-breakdown.md`).

`migrate` runs DATA-030 in order: schemas and `pg_trgm`, ZenStack migrations (`app`), Better Auth migrations (`auth`, `@git-migrator/auth`), then config sync. `seed` also creates the Better Auth users of the seeded test Actors when `auth.testSignIn.enabled` is true, with the password from `GM_TEST_USER_PASSWORD` (AUTH-012); it refuses to run in production.

Declared internal dependencies (ARC-012, checked by `pnpm lint`): @git-migrator/auth, @git-migrator/jobs, @git-migrator/config, @git-migrator/observability, @git-migrator/db, @git-migrator/registry.
