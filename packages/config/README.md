# @git-migrator/config

Runtime configuration: the YAML file of DEP-040, its Zod schema with defaults, the `GM_*` environment overrides (ARC-030) and a readable report when the configuration is invalid. Secrets are not configuration. They come from secretspec environment variables (ADR-0024).

Status: implemented by T-004. Decisions made where the spec was silent are in [ADR-0050](../../docs/adr/0050-config-overrides-and-errors.md) and [ADR-0051](../../docs/adr/0051-config-schema-decisions.md).

Declared internal dependencies (ARC-012, checked by `pnpm lint`): none.

## Usage

Entrypoints call one function at startup:

```ts
import { loadConfigOrExit } from '@git-migrator/config';

const config = loadConfigOrExit(); // exits with status 78 and a report on stderr if invalid
```

- `GM_CONFIG_FILE` names the YAML file (Kubernetes mounts it at `/etc/git-migrator/config.yaml`). When it is unset, the configuration is the defaults plus any `GM_*` overrides, which is what local development uses.
- `loadConfig()` throws a `ConfigError` instead of exiting, for code and tests that want to handle the error. `resolveConfig({ text, env })` does the same work without touching the file system.
- The result is typed as `Config`. Durations (`analysisStaleAfter`, `runRequiresAnalysisWithin`) are milliseconds. Cron schedules stay as strings.

## Order of resolution

1. Parse the YAML document. A syntax error, a duplicate key or a top level that is not a mapping is reported.
2. Apply the `GM_*` overrides listed below. Values are coerced to the type the key expects: plain decimal numbers (`/^-?\d+(\.\d+)?$/`) and `true`/`false`. Other text, including `0x2000` and `1e3`, is kept for the schema to judge.
3. Validate the result with the Zod schema. Every object is strict, so an unknown key is an error. Defaults fill every missing key.

URL settings must be http(s) and must not carry a username, password, query string or fragment.

`auth.entra.tenantId` must be the directory's tenant GUID (a domain such as `contoso.com` is refused), because it is compared with the token's `tid` claim; it is trimmed and lowercased, and empty means unset (AUTH-002).

`environment` defaults to `development`. If the file and `GM_ENVIRONMENT` do not set it, and the file enables test sign-in or sets an explicit http public URL, the loader writes a warning to standard error. The chart must set `GM_ENVIRONMENT` (ADR-0051).

Cross-field rules are checked in the same pass: endpoint and route ids are unique, a route's source and target are defined endpoints and differ, naming templates only use variables their pipeline initializes, and in `production` the public URL is https, an Entra tenant is set and test sign-in is off (AUTH-012).

## Environment overrides (ARC-030)

Each scalar key can be set by one variable: `GM_` followed by each key segment in SCREAMING_SNAKE_CASE, joined with underscores. For example `quota.safetyFactor` is `GM_QUOTA_SAFETY_FACTOR`, and `worker.standard.concurrency.runs` is `GM_WORKER_STANDARD_CONCURRENCY_RUNS`.

Rules:

- An unset or empty variable is ignored, so an empty value in a manifest does not blank a key.
- A variable that matches no key is ignored. That covers the other `GM_*` variables of the runtime, such as `GM_CONFIG_FILE`, `GM_WORKER_ROLE` and `GM_SCRATCH_DIR`.
- Lists (`endpoints`, `routes`, `auth.roleMappings`) and maps (`endpoints[].quota.overrides`) can only be set in the file.
- When an override causes a problem, the report names the variable, for example `publicUrl: must be an http or https URL (set by GM_PUBLIC_URL)`.

Overridable keys (generated from the schema by `envOverrideKeys()`):

| Key path | Environment variable |
|---|---|
| `environment` | `GM_ENVIRONMENT` |
| `publicUrl` | `GM_PUBLIC_URL` |
| `auth.entra.tenantId` | `GM_AUTH_ENTRA_TENANT_ID` |
| `auth.testSignIn.enabled` | `GM_AUTH_TEST_SIGN_IN_ENABLED` |
| `git.maxPushBytes` | `GM_GIT_MAX_PUSH_BYTES` |
| `git.maxConcurrentLfsTransfers` | `GM_GIT_MAX_CONCURRENT_LFS_TRANSFERS` |
| `sizeClass.largeThresholdBytes` | `GM_SIZE_CLASS_LARGE_THRESHOLD_BYTES` |
| `quota.safetyFactor` | `GM_QUOTA_SAFETY_FACTOR` |
| `quota.backgroundShare` | `GM_QUOTA_BACKGROUND_SHARE` |
| `github.maxConcurrentRequests` | `GM_GITHUB_MAX_CONCURRENT_REQUESTS` |
| `schedules.inventory` | `GM_SCHEDULES_INVENTORY` |
| `schedules.analysisFeeder` | `GM_SCHEDULES_ANALYSIS_FEEDER` |
| `schedules.analysisStaleAfter` | `GM_SCHEDULES_ANALYSIS_STALE_AFTER` |
| `schedules.runRequiresAnalysisWithin` | `GM_SCHEDULES_RUN_REQUIRES_ANALYSIS_WITHIN` |
| `schedules.drift` | `GM_SCHEDULES_DRIFT` |
| `schedules.endpointParity` | `GM_SCHEDULES_ENDPOINT_PARITY` |
| `schedules.prune` | `GM_SCHEDULES_PRUNE` |
| `schedules.runReaper` | `GM_SCHEDULES_RUN_REAPER` |
| `schedules.scratchCleanup` | `GM_SCHEDULES_SCRATCH_CLEANUP` |
| `schedules.driftReadsSource` | `GM_SCHEDULES_DRIFT_READS_SOURCE` |
| `postgres.host` | `GM_POSTGRES_HOST` |
| `postgres.port` | `GM_POSTGRES_PORT` |
| `postgres.database` | `GM_POSTGRES_DATABASE` |
| `postgres.user` | `GM_POSTGRES_USER` |
| `postgres.sslmode` | `GM_POSTGRES_SSLMODE` |
| `postgres.auth` | `GM_POSTGRES_AUTH` |
| `postgres.pool.app` | `GM_POSTGRES_POOL_APP` |
| `worker.standard.concurrency.runs` | `GM_WORKER_STANDARD_CONCURRENCY_RUNS` |
| `worker.standard.concurrency.analysis` | `GM_WORKER_STANDARD_CONCURRENCY_ANALYSIS` |
| `worker.standard.concurrency.inventory` | `GM_WORKER_STANDARD_CONCURRENCY_INVENTORY` |
| `worker.standard.concurrency.parity` | `GM_WORKER_STANDARD_CONCURRENCY_PARITY` |
| `worker.large.concurrency.runs` | `GM_WORKER_LARGE_CONCURRENCY_RUNS` |
| `observability.logLevel` | `GM_OBSERVABILITY_LOG_LEVEL` |
| `observability.otlpEndpoint` | `GM_OBSERVABILITY_OTLP_ENDPOINT` |
| `observability.serviceName` | `GM_OBSERVABILITY_SERVICE_NAME` |
| `metrics.port` | `GM_METRICS_PORT` |
| `secretspec.profile` | `GM_SECRETSPEC_PROFILE` |

## Errors

An invalid configuration produces one report listing every problem found, with its key path:

```text
Invalid git-migrator configuration: 2 problems.
  - publicUrl: must be an http or https URL (set by GM_PUBLIC_URL)
  - endpoints[0].options.appId: must not be negative
Fix the configuration or the GM_* variables named above, then start the process again.
```

`loadConfigOrExit` writes this report to standard error and exits with status 78 (EX_CONFIG). Other errors are rethrown.

## Layout

- `src/schema.ts`: the DEP-040 schema, defaults and cross-field rules. The `Config` type is inferred from it.
- `src/env.ts`: override key derivation from the schema, and the override application.
- `src/load.ts`: YAML parsing, resolution and file loading.
- `src/errors.ts`: `ConfigError`, issue type and report format.
- `src/exit.ts`: `loadConfigOrExit`.
- `src/cron.ts`, `src/duration.ts`: validators for schedule values.
