# 11 — Data

## Schemas (DATA-001)

| Postgres schema | Owner | Migration tool |
|---|---|---|
| `app` | ZenStack (`packages/db/schema.zmodel`, `datasource.schemas = ['app']`, `defaultSchema = 'app'`) | ZenStack CLI (`zen migrate deploy`) |
| `auth` | Better Auth | Better Auth CLI migrate, against a connection with `search_path=auth` |
| `bullmq` | BullMQ PostgreSQL backend | BullMQ's built-in migrator, invoked explicitly |

**DATA-002** No cross-schema foreign keys. `app.actor.auth_user_id` references `auth.user.id` logically (ADR-0008).

**DATA-003** One database (`git_migrator`) and one login role for the application. In production the migrate Job uses the same role. The role needs `CREATE` on the database (to create schemas) and ownership of the three schemas.

## Connection (DATA-010)

- The connection string is assembled at startup from config `postgres.{host, port, database, user, sslmode}` and the secret `POSTGRES_PASSWORD` (Q63). `sslmode=require` is the default in production, `disable` in dev.
- Pools:
  - ZenStack client: `postgres.pool.app`, default 10 per process.
  - Better Auth: 5, web only.
  - BullMQ: one shared backend per process (JOB-014).
  - LISTEN: 1 dedicated connection on web.
  - Quota ledger: shares the app pool.

  BullMQ uses one shared backend per process (JOB-014). T-028 measures the real per-process total and records the formula in `docs/deployment.md`. The default deployment (web × 2, worker-standard × 2, worker-large × 1) MUST stay under 80% of the server's `max_connections`, and the chart docs state the requirement.
- **DATA-011 Required indexes.** Each is created in a ZenStack-managed migration, as raw SQL where ZModel can't express it:
  - `run (migration_id) WHERE status IN ('queued','running')`: unique partial index (DOM-010).
  - `migration (route_id) WHERE scope = 'endpoint'`: unique partial index.
  - `migration (route_id, status, readiness)`, `migration (wave_id)`, a GIN index on `migration (blocker_codes)`.
  - `repository (endpoint_id, namespace_id)` and a trigram index on `repository (full_path)` (`pg_trgm`) for search.
  - `facet_snapshot (repository_id, facet_key, side, fetched_at desc)`.
  - `quota_event (bucket_key, at)`.
  - `audit_event (at desc)`, `audit_event (subject_type, subject_id)`.
  - `expected_difference (route_id, migration_id, facet_key) WHERE revoked_at IS NULL`.

## Retention (DATA-020)

| Data | Retention |
|---|---|
| `RawResponse` | 30 days (`maintenance.prune`) |
| `QuotaEvent` | 2 × longest window |
| `FacetSnapshot` | Keep the latest 5 per (repository or endpoint, facet, side), plus every Snapshot referenced by an Analysis that is referenced by a Run or is a Migration's latest. Pruned hourly by `maintenance.prune` (JOB-046). |
| `Analysis`, `PlanItem` | Keep the latest 10 per Migration, plus any referenced by a Run |
| `Run`, `RunStep`, `RunLog`, `Mutation`, `AuditEvent`, `ParityResult` (latest per facet), everything else | Indefinitely |

## Migrations process (DATA-030)

The `migrate` entrypoint (Helm pre-install/pre-upgrade hook Job, and `pnpm db:migrate` in dev) runs, in order:

1. `CREATE SCHEMA IF NOT EXISTS app, auth, bullmq`, and `CREATE EXTENSION IF NOT EXISTS pg_trgm`. Azure Flexible Server requires `pg_trgm` in `azure.extensions`; the deployment docs say so.
2. ZenStack migrations (`app`).
3. Better Auth migrations (`auth`).
4. BullMQ backend migrations (`bullmq`).
5. Config sync: upsert Endpoints and Routes from config (with `configHash`), and mark missing ones `retired`. Create the system Expected Differences (FAC-GIT-007). If a Route's `configHash` changed, mark its Analyses stale.

Each step is idempotent. The Job exits non-zero on the first failure.

**DATA-031** Migrations are forward-only. Destructive changes (drop or rename) need a two-release expand/contract sequence, documented in the migration's comment.

## Seed (DATA-040)

`pnpm db:seed` (dev and test only) creates:

- test Actors (AUTH-012);
- a webhook allowlist sample and a Wave sample for the configured Route;
- in the `test` profile, the provider-fake fixture world (TST-012).
