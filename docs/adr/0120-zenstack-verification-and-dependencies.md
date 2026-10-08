# ADR-0120: ZenStack 3.9.7 verification and the extra dependencies of `packages/db`

- Status: accepted (no spec change needed)
- Date: 2026-10-08
- Task: T-010
- Affects: DOM-003, DOM-011, AUTH-021, ARC-001, ARC-002, DATA-030

## Context

T-010 must first confirm that the pinned ZenStack (3.9.7, ADR-0002) supports multi-schema, field-level `@deny` and `uuid(7)`, and otherwise fall back to an RPC-layer hook and application-generated UUIDv7. ADR-0002 already recorded a generation-level check by T-001; T-010 repeated it against a running database.

## Decision

**Verified, not assumed.** With `@zenstackhq/cli@3.9.7`, `@zenstackhq/orm@3.9.7` and `@zenstackhq/plugin-policy@3.9.7`, against PostgreSQL 16:

| Feature | Result | Evidence |
|---|---|---|
| Multi-schema | Works | `datasource.schemas = ['app']`, `defaultSchema = 'app'`, `@@schema('app')` on every model and enum. `zen migrate` emits `CREATE SCHEMA IF NOT EXISTS "app"` and schema-qualified DDL. The ORM qualifies every table (`"app"."run"`), so no `search_path` is needed. |
| Field-level `@deny('update', true)` | Works, **enforced at run time** | `policy.test.ts`: an operator's update of any `Migration` field except `waveId` is rejected with "some rows cannot be updated due to field policies", through scalar fields, `updateMany`, `upsert`, `set` on arrays and relation `connect`. |
| `@default(uuid(7))` | Works | The generated schema carries `uuid(7)` and the ORM generates a UUIDv7 client-side (ids sort by creation time). There is no database default, so raw SQL inserts must supply an id. |

None of the fallbacks is needed.

**Dependencies added beyond ARC-001's five ZenStack packages** (all exact pins, per ARC-002):

- `@zenstackhq/plugin-policy@3.9.7` (already required by ADR-0002) provides `@@allow`, `@@deny` and the field-level forms. `auth()` resolves to `Actor` through `@@auth`.
- `kysely@0.29.6`: ZenStack's ORM takes a Kysely `Dialect`, and `PostgresDialect` lives in `kysely`. It is the version `@zenstackhq/orm` already resolves (`~0.29.0`).
- `pg@8.23.1` and `@types/pg@8.23.1` (ADR-0002) in `packages/db` and `apps/worker`.
- `zod@4.6.5` (ADR-0002); ZenStack requires it.
- **`prisma` and `@prisma/engines` build scripts are allowed** in `pnpm-workspace.yaml` (`allowBuilds: true`). `zen migrate deploy` and `zen migrate dev` drive the Prisma schema engine, and pnpm 12 otherwise fails `pnpm install` with `ERR_PNPM_IGNORED_BUILDS`. The postinstall downloads the engine binary, so the image build (T-090) must run `pnpm install` with network access, or copy the engine. This is the opposite of the deliberate `protobufjs: false` of ADR-0054, because here the script is needed.

## Alternatives

- A hand-written migration runner with `pg` (no Prisma engine at run time). Rejected: DATA-001 names `zen migrate deploy`, and Prisma's diffing gives the `--create-only` developer workflow for free.

## Consequences

- `zen migrate` needs `DATABASE_URL`; `applyAppMigrations` passes it in the child's environment, never in argv.
- The production image must contain `@zenstackhq/cli`, `prisma` and its engine for the `migrate` entrypoint (T-090).
