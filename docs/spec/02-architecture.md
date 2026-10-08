# 02 — Architecture

## Technology stack (ARC-001)

| Concern | Choice |
|---|---|
| Language | TypeScript, `strict` plus `noUncheckedIndexedAccess`, ESM only |
| Runtime | Node.js 24 LTS |
| Package manager | pnpm (version pinned via `packageManager`) |
| Monorepo tasks | Turborepo, plus TypeScript project references |
| Web | Next.js, latest stable major, App Router, `output: 'standalone'` |
| HTTP API | Hono, mounted inside Next.js (see 09-api) |
| Validation | Zod (latest major) |
| ORM | ZenStack v3 latest stable: `@zenstackhq/cli`, `@zenstackhq/schema`, `@zenstackhq/orm`, `@zenstackhq/server`, `@zenstackhq/tanstack-query` |
| Database | PostgreSQL 16+ (Azure Database for PostgreSQL Flexible Server in production) |
| Auth | Better Auth (Microsoft Entra ID first) |
| Jobs | BullMQ ≥ 6 with its PostgreSQL backend |
| UI | Ant Design (open source, latest major) for components, Tailwind CSS (latest major) for layout, TanStack Query |
| i18n | next-intl, English only; every user-facing string lives in message files |
| Logging / telemetry | pino (JSON), OpenTelemetry SDK (traces, optional export), Prometheus metrics via `prom-client` |
| Git transport | System `git` and `git-lfs` CLIs, invoked via a typed wrapper |
| Tests | Vitest, Playwright |
| Lint / format | Biome |
| Secrets | secretspec (Azure Key Vault in production) |
| Packaging | Docker image, Helm chart |
| CI | GitHub Actions |

All dependency versions MUST be pinned exactly in `package.json`. The pnpm lockfile is committed (ARC-002). "Latest stable" means the latest stable release at the time task T-001 runs. T-001 records the chosen versions in `docs/adr/0002-versions.md`.

## Monorepo layout (ARC-010)

```
apps/
  web/                    Next.js app: UI and Hono API (route handler at app/api/[[...route]])
  worker/                 Process entrypoints: worker roles, scheduler, migrate (DB migrations)
packages/
  core/                   Pure domain: field paths, hashing, facet registry, translation engine,
                          readiness, planner, parity, expected differences, lifecycle state machine.
                          No I/O, no provider names.
  canonical/              Canonical types + Zod schemas of all built-in facets (05-facets)
  facets/                 Built-in FacetDefinitions (one module per facet; see 05-facets)
  adapter-sdk/            Adapter and FacetDriver interfaces, provider HTTP client
                          (retry, pagination, raw capture), quota client, AdapterError
  adapters/
    bitbucket-cloud/      Bitbucket Cloud adapter
    github/               GitHub adapter
  registry/               Build-time composition of adapters, facets and pair overrides
  git/                    git/git-lfs wrapper: mirror, ls-remote, blob scan, batched push, LFS
  db/                     ZModel (schema.zmodel), generated client, migrations, privileged client factory
  auth/                   Better Auth configuration, role mapping, Actor provisioning
  api/                    Hono app: routes, OpenAPI, SSE, ZenStack RPC mount
  jobs/                   Queue names, job payload schemas, enqueue helpers, job processors
  quota/                  Rate-limit buckets, sliding-window ledger, credential selection
  config/                 Runtime config loading (env + config file), Zod-validated
  observability/          Logger, tracing, metrics
  guidance/               Manual-task guidance content (structured data + markdown templates)
testing/
  provider-fakes/         Stateful HTTP fakes of the Bitbucket and GitHub APIs, plus a git http-backend server
  fixtures/               Seed data and builders
  integration/            Integration-tier tests (API + worker + fakes + Postgres)
  e2e/                    Playwright tests (integration-tier UI flow and live e2e)
deploy/
  docker/Dockerfile
  helm/git-migrator/
docs/                     spec/, adr/, process/, providers/, e2e-setup.md, followups.md
```

Package names use the scope `@git-migrator/` (for example `@git-migrator/core`). All packages are `private: true` (ARC-011).

### Dependency rules (ARC-012)

- `core` depends on nothing internal.
- `canonical` depends on `core`.
- `facets` depends on `core` and `canonical`.
- `adapter-sdk` depends on `core`, `canonical` and `quota`.
- `git` depends on `adapter-sdk` and implements its `GitClient` interface.
- Adapters depend on `adapter-sdk`, `canonical` and `core`, and never on each other, `facets`, `git` or `db`.
- `quota` depends on `db`. It is the only infrastructure package `adapter-sdk` may depend on.
- `registry` is the only package that imports concrete adapters and facets.
- `apps/*` may depend on anything.
- `tools/check-deps.ts`, run by `pnpm lint`, enforces these rules on `package.json` dependencies, TypeScript project references and parsed imports; it fails closed (ADR-0028). Where these rules are silent, its rule table allows the minimal set implied by ARC-010 (for example `git`, `quota` and `db` may use `core`/`canonical`); a task needing a new edge changes the table and records an ADR.
- Any package MAY list `@git-migrator/provider-fakes` and `@git-migrator/fixtures` as `devDependencies` and import them only from `*.test.*` files (ADR-0028).

## Runtime components (ARC-020)

```
                ┌──────────────── Kubernetes ────────────────────────────┐
 Browser ──────►│ web (Deployment)                                       │
  (SSE/HTTP)    │   Next.js UI + Hono /api: Better Auth, ZenStack RPC,   │
                │   /api/v1 custom endpoints, /api/v1/events (SSE)       │
                │        │ enqueue                 ▲ LISTEN gm_events    │
                │        ▼                         │                     │
                │   Postgres: schemas app | auth | bullmq ◄──────────────┤
                │        ▲                         │ NOTIFY gm_events    │
                │        │ consume                 │                     │
                │ worker-standard (Deployment): general + standard       │
                │   migration queues; scheduler leader                   │
                │ worker-large (Deployment): large migration queue       │
                │ migrate (Helm hook Job): app/auth/bullmq schema migrations│
                └────────────┬───────────────────────────────────────────┘
                             │ HTTPS (REST + git smart HTTP)
                 Bitbucket Cloud            GitHub
```

- **web** is stateless. It never calls provider APIs during a request, except through enqueued interactive jobs (ARC-021).
- **Workers** perform all provider I/O (ARC-022).
- Exactly one worker process acts as **scheduler leader**, elected through a Postgres advisory lock (`pg_try_advisory_lock`). The leader registers BullMQ job schedulers and runs the background analysis feeder (ARC-023).
- A single container image serves every component, selected by its entrypoint argument: `web`, `worker`, `migrate` (ARC-024).

## Request and data flow (summary)

1. **Inventory jobs** list Namespaces, Repositories, Identities and Groups on each Endpoint and upsert them (JOB-030).
2. **Analysis jobs** read every Facet of a Migration's source (and target, if it exists) into Snapshots, translate through the facet engine, and store the Analysis and its Plan (LIF-020).
3. **Runs** execute the Plan's Steps, then run a Parity Check (LIF-040, LIF-060).
4. Workers emit change notifications. The web tier relays them over SSE, and the UI invalidates its queries (JOB-060).

## Configuration (ARC-030)

Non-secret configuration comes from a YAML file, `GM_CONFIG_FILE`. In Kubernetes it is a ConfigMap rendered from Helm values. Environment variables can override individual keys (`GM_…`). Secrets come from secretspec. The `config` package validates the merged result with Zod at startup and exits with a clear message on failure. The full schema is in [13-deployment](13-deployment.md#runtime-configuration-file).
