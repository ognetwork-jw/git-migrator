# ADR-0002: Dependency versions

- Status: accepted
- Date: 2026-10-08

## Context

The spec says "latest stable" for most dependencies (ARC-001) and requires exact pins (ARC-002). T-001 chose the versions below on 2026-10-08, from `npm view <pkg> version` (the `latest` dist-tag), and verified the open questions that later tasks depend on.

## Decision

### Runtime and package manager

| Item | Version | Notes |
|---|---|---|
| Node.js | 24 (LTS), local 24.21.0 | `engines.node = 24.x`, `.nvmrc` and `.node-version` contain `24`. |
| pnpm | `12.10.1` | Pinned through `packageManager` in the root `package.json`. |

### Installed by T-001 (exact pins in the root `package.json`)

| Package | Version | Notes |
|---|---|---|
| `typescript` | `7.0.2` | The native-compiler major. `tsc -b` with project references works. |
| `turbo` | `2.11.7` | |
| `@biomejs/biome` | `2.5.15` | Lint and format. |
| `vitest` | `5.0.3` | |
| `@vitest/coverage-v8` | `5.0.3` | Must match `vitest`. |
| `oxc-parser` | `0.153.0` | Parses TS/TSX for the repository tools (`tools/ast.ts`); TypeScript 7 has no JavaScript API. Native binding, no JS dependency of ours. See ADR-0028. |
| `re2js` | `2.8.6` | Added by T-013 to `packages/core` only (not the root). Pure-JavaScript RE2 port: linear-time regex for naming `replace` steps (ADR-0095). |
| `@types/node` | `24.19.1` | Deliberately the `24.x` line, to match the Node 24 runtime. `latest` is 26.6.4, which would describe APIs Node 24 lacks. |
| `yaml` | `2.9.1` | Added by T-002 (review round 1). Parses `compose.yaml` and `devenv.yaml` in `tools/dev-environment.test.ts`. The version `packages/config` pins later (see "Intended pins"). |
| `smol-toml` | `1.9.0` | Added by T-002 (review round 1). Parses `secretspec.toml` in `tools/dev-environment.test.ts`. ADR-0065. |

### Installed by T-004 (exact pins in `packages/observability/package.json`)

Packages that the intended-pins table below did not name, needed for DEP-050 tracing. Their versions are the ones that `@opentelemetry/sdk-node@0.223.0` and `@opentelemetry/instrumentation-pg@0.75.0` declare as compatible (`@opentelemetry/instrumentation` `0.223.0`, `@opentelemetry/api` `1.9.1`).

| Package | Version | Notes |
|---|---|---|
| `@opentelemetry/exporter-trace-otlp-http` | `0.223.0` | OTLP/HTTP trace exporter, used only when `observability.otlpEndpoint` is set (ADR-0054). Same release line as `sdk-node`. |
| `@opentelemetry/instrumentation-http` | `0.223.0` | HTTP server and outgoing HTTP instrumentation (DEP-050). Same release line as `sdk-node`. |
| `@opentelemetry/instrumentation-pg` | `0.75.0` | PostgreSQL instrumentation (DEP-050). Its own version line; it depends on `@opentelemetry/instrumentation` `^0.223.0`. |

The OTLP log exporter in `@opentelemetry/sdk-node` depends on `protobufjs`, whose install script pnpm 12 ignores by default. `pnpm-workspace.yaml` records `allowBuilds: { protobufjs: false }`, so `pnpm install --frozen-lockfile` passes. This tree exports traces over OTLP/HTTP JSON only and never uses protobuf, so the script is not needed. The `false` is deliberate: do not change it to `true` (see ADR-0054).

BullMQ instrumentation is not installed here. DEP-050 names it, but the BullMQ tracing package is an optional peer of `bullmq` and belongs with the job runtime (T-028), see ADR-0054.

### Intended pins for later tasks

Each later task adds these to the `package.json` that needs them, with exactly these versions (no `^`/`~`), unless it records a new ADR.

| Package | Version | Used by |
|---|---|---|
| `next` | `16.4.0` | `apps/web` |
| `react`, `react-dom` | `19.3.0` | `apps/web` |
| `hono` | `4.13.13` | `packages/api`, `testing/provider-fakes` |
| `@hono/node-server` | `2.1.4` | fakes, worker health endpoints |
| `zod` | `4.6.5` | everywhere (ZenStack requires `^4`) |
| `@zenstackhq/cli`, `@zenstackhq/schema`, `@zenstackhq/orm`, `@zenstackhq/server`, `@zenstackhq/tanstack-query`, `@zenstackhq/plugin-policy` | `3.9.7` | `packages/db`, `packages/api`, `apps/web`. All ZenStack packages MUST share one version. |
| `pg` | `8.23.1` | `packages/db`, `packages/jobs` (peer of ZenStack ORM and BullMQ) |
| `@types/pg` | `8.23.1` | |
| `better-auth` | `1.7.7` | `packages/auth` |
| `bullmq` | `6.3.11` | `packages/jobs` |
| `antd` | `6.6.5` | `apps/web` |
| `tailwindcss` | `4.3.3` | `apps/web` |
| `@tanstack/react-query` | `5.104.1` | `apps/web` |
| `next-intl` | `4.14.9` | `apps/web` |
| `pino` | `10.4.0` | `packages/observability` |
| `@opentelemetry/api` | `1.9.1` | `packages/observability` |
| `@opentelemetry/sdk-node` | `0.223.0` | `packages/observability` |
| `prom-client` | `15.1.3` | `packages/observability` |
| `yaml` | `2.9.1` | `packages/config` |
| `@playwright/test` | `1.64.0` | `testing/e2e` |
| `tsx` | `4.23.15` | local process runner, if needed |

If a version above no longer resolves, or two of them have an incompatible peer range, the task that adds it picks the nearest compatible release and records it in its own ADR.

### Verification of ZenStack 3.9.7 (T-010 prerequisite, DOM-003, ADR-0008)

Checked by generating a scratch project with `@zenstackhq/cli@3.9.7` (`zen generate`) and by reading `@zenstackhq/language`, `@zenstackhq/orm` and `@zenstackhq/plugin-policy` at 3.9.7:

| Feature | Supported? | Evidence |
|---|---|---|
| Multi-schema (`schemas = [...]`, `defaultSchema`, `@@schema('x')` on models and enums) | **Yes**, PostgreSQL only | `defaultSchema` and `schemas` are validated in the datasource; `@@schema(map: String)` is in the stdlib. The generated `schema.ts` carries `provider.defaultSchema` and a `@@schema` attribute per model. A model without `@@schema` falls into the default schema; `defaultSchema` must appear in `schemas`. |
| Field-level `@deny` (as in `@deny('update', true)`) | **Yes**, through `plugin policy` (`@zenstackhq/plugin-policy`) | Declared with `plugin policy { provider = '@zenstackhq/plugin-policy' }`. It is not part of the core stdlib, so `packages/db` must depend on that plugin. Generation succeeds and emits the `@deny` attribute on the field. |
| `@default(uuid(7))` | **Yes** | Accepted by the language (`uuid(version, format)`); the ORM generates `uuid.v7()` when the argument is `7`. |

Conclusion for T-010: none of the fallbacks in its task text (RPC-layer hook, application-generated UUIDv7) is needed. T-010 must still prove enforcement with policy tests; this ADR only records that the syntax and generator support it.

### Verification of BullMQ 6.3.11 PostgreSQL backend (ADR-0006)

- The PostgreSQL backend **exists inside the `bullmq` package itself** (there is no separate `@bullmq/postgres` package; that name does not exist on npm). `bullmq@6.3.11` exports `createPostgresBackend`, `PostgresQueueBackend`, `PostgresConnection`, `runMigrations`, `assertSchemaCompatibility`, `DEFAULT_SCHEMA` and `quoteSchemaName` from `dist/esm/postgres`.
- It needs the `pg` driver as an optional peer dependency (`pg >= 8.0.0`). `ioredis`, `redis` and `bullmq-otel` are optional peers too; Redis is not needed.
- The backend lives in a configurable PostgreSQL schema (pool config accepts `schema`), which supports the `bullmq` schema of ADR-0008. It runs its own migrations (`runMigrations`) under an advisory lock and requires PostgreSQL 13 or newer (`MINIMUM_POSTGRES_VERSION = 13`, recommended 14), which the PostgreSQL 16+ baseline of ARC-001 satisfies.
- Wiring: inject `createPostgresBackend` into the queue classes or call `setDefaultBackendFactory(createPostgresBackend)`.

## Consequences

- Upgrades after bootstrap are deliberate changes with their own ADR.
- `@types/node` follows the Node major, not `latest`.
- `packages/db` needs `@zenstackhq/plugin-policy` in addition to the five packages named in ARC-001.
- A unit test (`tools/bootstrap.test.ts`) checks that every dependency in the repository is pinned exactly and that the versions in the "Installed by T-001" table match the root `package.json`. The "Intended pins" are not machine-checked; each later task verifies its own.
