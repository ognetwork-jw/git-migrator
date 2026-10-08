# 13 — Deployment

## Image (DEP-001)

`deploy/docker/Dockerfile` is multi-stage:

1. **`base`:** `node:24-slim`, plus `git`, `git-lfs`, `ca-certificates`, `tini` and a pinned `secretspec` release binary, verified by checksum.
2. **`dev`:** `base` + pnpm. Used by Compose.
3. **`build`:** `pnpm install --frozen-lockfile`, `pnpm generate`, `pnpm turbo run build`. Then `pnpm deploy --prod` for the worker, and the Next.js standalone output for web.
4. **`runtime`:** `base` + built artifacts under `/app`, plus `/app/bin/entrypoint.sh`.
   - The image creates user `gm` with UID and GID 10001 and sets `USER 10001`.
   - `ENTRYPOINT ["tini","--","/app/bin/entrypoint.sh"]`.
   - `git config --system` sets `init.defaultBranch=main`, `core.askPass` unset (ADP-071), and `lfs.concurrenttransfers=8`.

**DEP-002** `entrypoint.sh <web|worker|migrate> [args]`:

```sh
#!/bin/sh
set -eu
cmd="$1"; shift
if [ -n "${GM_SECRETSPEC_PROVIDER:-}" ]; then
  exec secretspec run --profile "${GM_SECRETSPEC_PROFILE:-production}" \
       --provider "$GM_SECRETSPEC_PROVIDER" -- node "/app/dist/$cmd.js" "$@"
else
  exec node "/app/dist/$cmd.js" "$@"
fi
```

The script is POSIX `sh` (dash in `node:24-slim`).

- For `web`, `/app/dist/web.js` starts the Next.js standalone server.
- `worker --role <standard|large|all>` selects the queues to consume.
- `migrate` runs DATA-030.

**DEP-003 Read-only root filesystem.** The process writes only to mounted volumes:

| Path | Used for | Volume |
|---|---|---|
| `/tmp` | general temp | `emptyDir` 256Mi |
| `/app/apps/web/.next/cache` | Next.js cache (web only) | `emptyDir` 512Mi |
| `/scratch` | git working directories (workers only) | `emptyDir` (standard) or generic ephemeral PVC (large) |
| `/home/gm` | `HOME` for git and git-lfs config and credential files | `emptyDir` 16Mi |

`HOME=/home/gm`, `GM_SCRATCH_DIR=/scratch`, `TMPDIR=/tmp`.

## Kubernetes security (DEP-010)

Every pod and container:

```yaml
# pod spec
securityContext:
  runAsNonRoot: true
  runAsUser: 10001
  runAsGroup: 10001
  fsGroup: 10001
  seccompProfile: { type: RuntimeDefault }
automountServiceAccountToken: false   # workload identity injects its own projected token
# each container's securityContext
securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities: { drop: ["ALL"] }
```

## Azure (DEP-020)

- **Key Vault access** (Q63 option a) uses Azure Workload Identity.
  - The ServiceAccount has annotation `azure.workload.identity/client-id: <values.azure.workloadIdentityClientId>`.
  - Pods carry the label `azure.workload.identity/use: "true"`.
  - `GM_SECRETSPEC_PROVIDER=akv://<vault>?auth=workload_identity`.
  - The identity needs the **Key Vault Secrets User** role.
- **Secret names in Key Vault** follow secretspec's AKV storage convention for project `git-migrator`, profile `production`. `docs/deployment.md` (written by T-090) includes the exact names that `secretspec set … --provider akv://<vault>` produces, and a one-time population script.
- **Postgres:** Azure Database for PostgreSQL Flexible Server. Host, user and database come from values; the password comes from Key Vault (`POSTGRES_PASSWORD`).
  - Allow-list `PG_TRGM` in `azure.extensions`.
  - `sslmode=require`.
  - Entra authentication for Postgres is supported later via the `postgres.auth: entra` value, which uses the workload identity token as the password. It is optional and off by default.
- **Blob Storage:** not used in v1 (ADR-0012).

## Helm chart (DEP-030)

Chart `deploy/helm/git-migrator`. Templates:

- Deployments: `web`, `worker-standard`, `worker-large`.
- Job: `migrate`, with hook `pre-install,pre-upgrade`, `hook-weight: "0"`, `hook-delete-policy: before-hook-creation,hook-succeeded`, and `backoffLimit: 1`.
- The migrate Job needs its configuration and identity before regular resources exist on first install. The chart therefore renders a **hook copy** of the runtime ConfigMap (`<release>-config-migrate`) and of the ServiceAccount (`<release>-migrate`). Both are annotated `pre-install,pre-upgrade` with `hook-weight: "-10"` and `hook-delete-policy: before-hook-creation`. The workload-identity annotation is applied to both ServiceAccounts, and the federated credential must trust both subjects (`docs/deployment.md`). Regular Deployments use the regular ConfigMap and ServiceAccount, and carry a `checksum/config` pod annotation so config changes roll the pods.
- `ConfigMap` (runtime config file, DEP-040), `ServiceAccount`, `Service` (web: http 3000, metrics 9464), `Ingress`.
- Optional: `HorizontalPodAutoscaler` (web), `PodDisruptionBudget` (each Deployment), `NetworkPolicy`.
- Workers: an optional `Service` and metrics port for scraping.
- `worker-standard` mounts `/scratch` as an `emptyDir` with `sizeLimit` from values. `worker-large` uses a generic ephemeral volume (`volumes[].ephemeral.volumeClaimTemplate`) with `storageClassName` and size from values.
- Probes:
  - web: `startupProbe` and `readinessProbe` → `/api/readyz`; `livenessProbe` → `/api/healthz`.
  - workers: an HTTP health server on port 8081 (`/healthz`, `/readyz`, which reports ready after queue workers start).
- `terminationGracePeriodSeconds`: web 30, worker-standard 120, worker-large 600. On SIGTERM, a worker stops taking new jobs. In-flight Runs finish their current step, release the lease and re-enqueue themselves (LIF-046). Other jobs are short and finish normally, then `worker.close()` is called.

### Values surface (DEP-031)

```yaml
image: { registry: ghcr.io, repository: <org>/git-migrator, tag: "", pullPolicy: IfNotPresent }
imagePullSecrets: []
serviceAccount: { create: true, name: "", annotations: {} }
azure: { workloadIdentityClientId: "", keyVaultName: "" }
secretspec: { profile: production, provider: "" }          # default akv://{{keyVaultName}}?auth=workload_identity
postgres: { host: "", port: 5432, database: git_migrator, user: git_migrator, sslmode: require,
            auth: password, pool: { app: 10 } }
web:
  replicas: 2
  resources: { requests: { cpu: 250m, memory: 512Mi }, limits: { cpu: "1", memory: 1Gi } }
  nodeSelector: {}
  tolerations: []
  affinity: {}
  hpa: { enabled: false, minReplicas: 2, maxReplicas: 4, targetCPUUtilizationPercentage: 70 }
  pdb: { enabled: false, minAvailable: 1 }
worker:
  standard:
    replicas: 2
    concurrency: { runs: 4, analysis: 8, inventory: 2, parity: 4 }
    scratch: { sizeLimit: 15Gi }
    resources: { requests: { cpu: 500m, memory: 1Gi, ephemeral-storage: 16Gi }, limits: { cpu: "2", memory: 2Gi, ephemeral-storage: 20Gi } }
    nodeSelector: {}
    tolerations: []
    affinity: {}
    pdb: { enabled: false, maxUnavailable: 1 }
  large:
    replicas: 1
    concurrency: { runs: 1 }
    scratch: { size: 60Gi, storageClassName: "" }
    resources: { requests: { cpu: "1", memory: 2Gi }, limits: { cpu: "2", memory: 4Gi } }
    nodeSelector: {}
    tolerations: []
    affinity: {}
migrateJob:
  resources: { requests: { cpu: 100m, memory: 256Mi }, limits: { cpu: 500m, memory: 512Mi } }
ingress:
  enabled: true
  className: nginx
  host: ""
  clusterIssuer: ""          # → cert-manager.io/cluster-issuer
  tls: { enabled: true, secretName: "" }
  annotations: {}            # merged after chart defaults (SSE: DEP-032)
metrics: { enabled: true, port: 9464 }
networkPolicy: { enabled: false }
observability: { logLevel: info, otlpEndpoint: "", serviceName: git-migrator }
config: {}                   # rendered verbatim into the runtime config file (DEP-040)
```

**DEP-032 Ingress defaults** for SSE: `nginx.ingress.kubernetes.io/proxy-buffering: "off"`, `proxy-read-timeout: "3600"`, `proxy-send-timeout: "3600"`, `proxy-body-size: "5m"`. Plus `cert-manager.io/cluster-issuer: {{ .Values.ingress.clusterIssuer }}` when it's set.

**DEP-033** `helm lint`, `helm template` with `ci/*.yaml` value files, and `kubeconform -strict -kubernetes-version <current AKS default>` all pass in CI. A chart unit-test suite (`helm-unittest`) asserts the security context, read-only filesystem, volumes and resources for every workload.

## Runtime configuration file (DEP-040)

The chart renders this file into the ConfigMaps from `values.config`, **merged with** the top-level values the app needs: `postgres` (except secrets), `worker.*.concurrency`, `observability`, `metrics.port` and `secretspec.profile`. Each worker Deployment also sets `GM_WORKER_ROLE` (`standard` or `large`). The file is mounted at `/etc/git-migrator/config.yaml` (`GM_CONFIG_FILE`) and validated by the `config` package. Keys below are the `values.config` part:

```yaml
environment: production                  # GM_ENVIRONMENT
publicUrl: https://git-migrator.example.com
auth:
  entra: { tenantId: "" }
  roleMappings: [ ... ]                  # AUTH-010
  testSignIn: { enabled: false }
endpoints:
  - id: bitbucket-main
    provider: bitbucket-cloud
    baseUrl: https://api.bitbucket.org
    gitBaseUrl: https://bitbucket.org
    options: { workspace: acme }
    credentialsSecret: BITBUCKET_CREDENTIALS     # secretspec key
    quota: { overrides: {} }                       # JOB-043
    atlassianAdmin: { orgId: "", apiKeySecret: ATLASSIAN_ADMIN_API_KEY }   # optional
  - id: github-main
    provider: github
    baseUrl: https://api.github.com
    gitBaseUrl: https://github.com
    options: { org: acme, appId: 0, installationId: 0 }
    credentialsSecret: GITHUB_APP_PRIVATE_KEY
routes:
  - id: bitbucket-to-github
    source: bitbucket-main
    target: github-main
    targetNamespace: acme
    sourcePostAction: read-only
    policies:
      acceptLossy: [branch-rules.advisory-enforced, environments.category-dropped]
      webhookAllowlistEnabled: true
      identityMatch: { autoConfirmEmail: true }
    defaults:
      mergeSettings: { allowed: [merge-commit, squash, rebase], deleteBranchOnMerge: true }
      naming:
        steps:
          - { var: namespace, op: projectKey }
          - { var: namespace, op: lowercase }
          - { var: repository, op: slug }
          - { var: repository, op: kebab }
        template: "{namespace}-{repository}"
      teamNaming:
        steps:
          - { var: group, op: slug }
          - { var: group, op: kebab }
        template: "{group}"
git: { maxPushBytes: 1610612736, maxConcurrentLfsTransfers: 8 }
sizeClass: { largeThresholdBytes: 5368709120 }
quota: { safetyFactor: 0.95, backgroundShare: 0.9 }
github: { maxConcurrentRequests: 10 }
schedules: { inventory: "0 */6 * * *", analysisFeeder: "* * * * *", analysisStaleAfter: 7d,
             runRequiresAnalysisWithin: 24h, drift: "17 3 * * *", endpointParity: "47 3 * * *",
             prune: "*/10 * * * *", runReaper: "* * * * *", scratchCleanup: "35 * * * *",
             driftReadsSource: false }
```

Loading rules (ADR-0050, ADR-0051):

- The example is a template: `roleMappings: [ ... ]` and the empty `tenantId` are placeholders and are rejected as written; production requires a non-empty Entra tenant. `appId: 0`, `installationId: 0` and `orgId: ""` are accepted placeholders that the adapter treats as unset.
- Every scalar leaf can be overridden by an environment variable named `GM_` plus the key path in SCREAMING_SNAKE_CASE (`quota.safetyFactor` → `GM_QUOTA_SAFETY_FACTOR`). Lists and maps cannot. Overrides apply after the file and before validation; an empty variable is ignored; unknown `GM_*` variables are ignored. Decimal literals become numbers and `true`/`false` booleans.
- Every object is strict (unknown keys are errors). URL settings must be http(s) without credentials, query or fragment. Unspecified keys default to the values in the spec text that uses them (ADR-0051 lists them); `environment` defaults to `development`, with a warning when production-only guards depend on that default.
- A missing `GM_CONFIG_FILE` means defaults plus overrides. An invalid configuration exits with status 78 (`EX_CONFIG`) after reporting every problem, one line each with its path and the overriding variable.

## Observability (DEP-050)

- **Logs:** pino JSON to stdout. Fields include `level`, `time`, `msg`, `component`, `runId`, `migrationId`, `jobId` and `traceId`. Secrets are redacted with pino `redact` paths. This is the first-day signal (Q42). A second layer scrubs every log call (messages, fields, errors and their causes) for credentials: header values, credential schemes, token shapes, base64 `user:secret` pairs, URL userinfo and sensitive key-value pairs, including percent-encoded forms; input is capped at 64 KiB and scanning is linear (ADR-0052).
- **Traces:** the OpenTelemetry Node SDK, exporting only when `observability.otlpEndpoint` is set. HTTP server, outgoing HTTP, pg and BullMQ jobs are instrumented. The SDK always starts (so logs carry `traceId`); without an endpoint spans are discarded. Only traces are exported through OpenTelemetry; `OTEL_*` exporter variables are ignored (ADR-0054).
- **Metrics:** `prom-client` on port 9464 path `/metrics`. Includes the default Node metrics plus:
  - `gm_provider_requests_total{provider,endpoint,bucket,status}`
  - `gm_provider_request_duration_seconds{provider,endpoint,bucket,status}`
  - `gm_quota_used{bucket,pool}`, `gm_quota_limit{bucket}`
  - `gm_runs_total{kind,status}`, `gm_run_duration_seconds{kind}`
  - `gm_migrations{route,status,readiness}`
  - `gm_queue_jobs{queue,state}`

  Application code writes metrics only through typed recorders; the metrics server is a plain HTTP server serving only `GET /metrics` (ADR-0053).

## CI/CD (DEP-060)

GitHub Actions workflows:

- **`ci.yml`** (pull requests and pushes to `main`):
  - `pnpm install --frozen-lockfile`, `lint`, `typecheck`, `test` (with coverage thresholds, TST-005), `test:integration` (Postgres service container plus fakes), `test:e2e` (Playwright, fakes), `helm:check` + helm-unittest, and a Docker build (no push).
  - A dependency-rules check (ARC-012).
- **`devenv.yml`:** `cachix/install-nix-action` + devenv, running `devenv test`, on pull requests that touch `devenv.*`, plus nightly.
- **`release.yml`** (tags `v*`): build and push a multi-arch (`linux/amd64`, `linux/arm64`) image to `ghcr.io/<owner>/git-migrator`, then package and push the chart as an OCI artifact to `ghcr.io/<owner>/charts`. The chart `appVersion` equals the tag.
- **Not in CI:** the live e2e test (Q65).
