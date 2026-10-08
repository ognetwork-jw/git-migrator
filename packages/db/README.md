# @git-migrator/db

The ZModel schema (`schema.zmodel`), its generated client, the migrations, the privileged client factory and the database steps of the `migrate` entrypoint. It implements [03-domain-model](../../docs/spec/03-domain-model.md), [11-data](../../docs/spec/11-data.md) and the policies of AUTH-020/API-012. Decisions: ADR-0120 to ADR-0123.

Internal dependencies (ARC-012): `@git-migrator/core`, `@git-migrator/canonical`. It cannot import `config`; callers pass plain values.

## Clients (AUTH-021, DOM-005)

```ts
const handle = createDb({ connectionString, poolMax: 10 });
handle.privileged;            // no policies: server code only, behind a custom endpoint or job
handle.forActor(actor);       // policies enforced for this Actor: the only client the RPC mount may get
```

Never hand `privileged` to the RPC handler. The value `forActor` returns is not a ZenStack client but a frozen, null-prototype facade (`PolicyDb`) with the model delegates, a read-only deep-frozen `$schema` and `$transaction` only (an allow-list; the `$transaction` callback receives the same facade). `$schema` is there because the ZenStack RPC handler reads it to validate model names; it is a frozen copy, so a holder cannot edit policy definitions. Delegate calls return opaque thenables, and the array form of `$transaction` (used by the RPC transaction route) accepts only operations that facade issued; a forged `{ then, cb }` is rejected. Delegate arguments must be plain data (objects, arrays, primitives, exact `Date`, `Decimal`, `Uint8Array`): a function, a Proxy, a class instance, a forged prototype, a key named `$expr` (which would give raw SQL beneath the policies), a cycle or nesting beyond 64 levels is refused before any SQL runs, and ZenStack receives only a fresh deep clone, so editing the arguments after the call changes nothing (ADR-0200). Errors from a facade are sanitized: the reason, model, policy reason code and database error code are kept; `sql`, `sqlParams`, `dbErrorMessage` and `cause` are dropped, and so are those of a non-ORM error that carries them. See ADR-0122 item 9 and ADR-0200. `src/rpc.test.ts` drives `RPCApiHandler` with these clients. The query builders (`$qb`, `$qbRaw`, `kysely`, `kyselyRaw`), `withExecutor`, the options, `$setAuth`, `$use`, `$unuse*` and raw SQL do not exist on it, so a holder cannot go around the policies. Every allow rule also requires an enabled Actor. Every model denies create, update and delete through `forActor` except the writes in API-012. `Migration` and `ManualTask` are narrowed to `waveId` and `note` by field-level `@deny('update', true)` on every other scalar field, `createdAt` and `updatedAt` included; give a new field the same attribute (a test fails otherwise). Their `updated_at` is set by a database trigger, not `@updatedAt`, because the ORM would otherwise write the denied column on every update.

## Changing the schema

1. Edit `schema.zmodel`, then `pnpm generate` (writes `src/generated`, which is committed; a test checks it is current).
2. `DATABASE_URL=postgresql://… pnpm --filter @git-migrator/db migrate:dev --name <name>` creates a migration without applying it. Review the SQL. Migrations are forward-only (DATA-031): destructive changes need a two-release expand/contract sequence described in a comment in the migration.
3. Partial indexes, CHECK constraints and triggers cannot be written in ZModel; add them to a hand-written migration (see `migrations/*_raw_indexes` and `*_integrity_constraints`). Prisma ignores them when diffing. Migrations are applied from a temporary copy, so nothing is written into this directory at run time.

## Commands

| Command | Action |
|---|---|
| `pnpm db:migrate` | DATA-030 steps 1, 2, 3 (Better Auth, `@git-migrator/auth`) and 5 (step 4 arrives with T-028). Needs `POSTGRES_PASSWORD` and the config file |
| `pnpm db:seed` | DATA-040: the three test Actors, a sample Wave and a webhook allowlist sample, plus their sign-in users when `auth.testSignIn.enabled` (AUTH-012). Only for an explicitly set `development`, `test` or `e2e` environment |
| `pnpm db:reset --yes` | Drops and recreates the configured database, then migrates. Only for an explicitly set `development`, `test` or `e2e` environment |
| `pnpm generate` | ZenStack generate |

## Tests

The tests need PostgreSQL 16 and create databases named `gm_t010_<random>` or `gm_test_<random>`, dropping them afterwards. The admin connection is `GM_TEST_DATABASE_URL` (default `postgresql://git_migrator:git_migrator@127.0.0.1:5432/postgres`; the role needs `CREATEDB`). Other packages use `createTestDatabase` from `@git-migrator/db/testing`.

`src/policy.test.ts` drives every model through every role: reads, plus create, update and delete, expecting a denial for everything outside API-012. The Azure Flexible Server needs `pg_trgm` in `azure.extensions` for step 1.

Arguments are also refused when an object is reached twice (shared references, as SuperJSON `referentialEqualities` can produce), when they hold more than 10,000 values or 1,000,000 string characters, or when `orderBy`, `by` or an aggregate uses a read-denied field such as `ApiKey.hash` (ADR-0202). `id` is immutable through RPC on every RPC-writable model. `createDb({ onError })` receives the raw error of a failed call for logging (reduce it to safe fields first).

## Audit of RPC mutations (AUTH-022)

`forActor` clients carry an audit plugin (`src/audit.ts`, ADR-0201). Every create, update or delete made through them writes one `AuditEvent` per row (`rpc.<model>.<action>`, a redacted field diff) in the same transaction. The `privileged` client is not audited; custom endpoints and jobs write their own events. The facade exposes no write operation of `auditEvent`.

A `rpc.wave.delete` event lists `clearedMigrationIds`, the Migrations whose `waveId` the delete cleared. A mutation without an Actor id throws and rolls back, so nothing commits unaudited (ADR-0202).

## Events (JOB-060)

`publishEvent(executor, event)` and `publishEventIn(tx, event)` run `pg_notify('gm_events', ...)` with the payload from `encodeEvent` (`@git-migrator/core`, at most 7,000 bytes); inside a transaction the notification is delivered on commit only. `createEventListener({ createClient: pgListenClient(pool) })` holds one dedicated `LISTEN gm_events` connection (not counted in `poolMax`), reconnects with backoff, probes the connection with `select 1` every 30 s (a half-open connection raises no error), bounds the connect at 10 s, and tells subscribers to resync after every successful connect. Fan-out to SSE clients is in `@git-migrator/api`.

## Staleness (LIF-021, API-012)

`markAnalysesStale(client, { routeId | ids | sourceRepositoryIds }, now)` sets `analysisStaleAt` to `now` for Migrations with an Analysis that are not yet stale (null or in the future) and returns their ids. A write to `naming_rule`, `webhook_allowlist_entry` or `overlay` marks the whole Route in the same transaction through a database trigger (`mark_route_analyses_stale`, migration `20261008000004_analysis_staleness`), whichever client wrote it (ADR-0310). `Route.avgCallsPerAnalysis` is the rolling mean of provider calls per Analysis (JOB-020, default 30).
