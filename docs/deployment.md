# Deployment

How to run git-migrator on Azure Kubernetes Service (AKS) with the Helm chart in `deploy/helm/git-migrator` (DEP-030). Secrets live in Azure Key Vault and reach the pods through secretspec and workload identity (DEP-020). Nothing secret is in the image, the chart values or the workflows.

## Image

`deploy/docker/Dockerfile` builds the image in stages (`secretspec-cli`, `base`, `dev`, `build`, `runtime`; DEP-001). The `runtime` stage is the last one, so a plain `docker build -f deploy/docker/Dockerfile .` produces it.

- Runs as user `gm`, UID and GID 10001, under `tini -g` and `/app/bin/entrypoint.sh <web|worker|migrate>` (DEP-002). With `GM_SECRETSPEC_PROVIDER` set the entrypoint wraps the process in `secretspec run`, so secrets exist only in the process environment.
- `secretspec.toml` is copied to `/app`, where `secretspec run` looks for it, and declares a `production` profile that inherits the secrets of `default` (ADR-0293). Without that profile the entrypoint stops with `'production' is not defined`.
- The root filesystem is read-only (DEP-003). The process writes only to `/tmp`, `/home/gm`, `/scratch` (workers) and `/app/apps/web/.next/cache` (web), which the chart mounts as `emptyDir` volumes (the large worker's `/scratch` is a generic ephemeral volume).
- The workspace packages are TypeScript that Node runs with type stripping, so the image keeps the workspace layout and the production `node_modules` instead of using `pnpm deploy` (ADR-0290). The ZenStack CLI that `migrate` runs is a production dependency of `@git-migrator/db`.
- `web` (`apps/web/src/web.ts`) runs the Next.js standalone build in its own process (DEP-002, ADR-0500). One server on port 3000 answers both the UI and the API (`/api/healthz`, `/api/readyz`, `/api/v1`, `/api/auth`, `/api/model`), and the metrics server listens on 9464. The build stage copies the static assets into `apps/web/.next/standalone/apps/web`. It also links that folder's `.next/cache` to `/app/apps/web/.next/cache`, which is the chart's `emptyDir`.
- Smoke test: `deploy/docker/smoke.sh <image>` starts a throw-away Postgres and runs `migrate`, `web` and `worker` through `secretspec run` (production profile, dotenv provider with fake values) with `--read-only`, UID 10001, dropped capabilities and tmpfs mounts. It checks that a missing secret stops the process, that `/` and `/signin` answer with the sign-in page's HTML and that its static assets are served, `/api/healthz`, `/api/readyz`, `/readyz`, `:9464/metrics` and the SIGTERM exit codes. CI runs it on every pull request and the release workflow runs it before pushing.

## Azure prerequisites

1. **AKS cluster** with the OIDC issuer and workload identity enabled (`az aks update --enable-oidc-issuer --enable-workload-identity`), the NGINX ingress controller (or set `ingress.className`) and cert-manager if you use `ingress.clusterIssuer`.
2. **Azure Key Vault** with the RBAC permission model. Nobody needs data-plane access except the managed identity below and the operator who populates the secrets.
3. **User-assigned managed identity** with the **Key Vault Secrets User** role on that vault. Its client id is `azure.workloadIdentityClientId`.
4. **Azure Database for PostgreSQL Flexible Server**, version 16, reachable from the cluster, with a database (`git_migrator`) and a role that owns it. Add `PG_TRGM` to `azure.extensions` (see [PostgreSQL extensions](#postgresql-extensions)). TLS is on: the chart sets `postgres.sslmode: require`.
5. **Microsoft Entra app registration** for sign-in (redirect URI `<publicUrl>/api/auth/callback/microsoft`, because `microsoft` is the sign-in provider id in `packages/auth/src/auth.ts`). The tenant id goes in `config.auth.entra.tenantId`; the client id and secret go in Key Vault.
6. **Image registry access**: the release workflow publishes to `ghcr.io/<owner>/git-migrator` and the chart to `oci://ghcr.io/<owner>/charts`. Private packages need `imagePullSecrets`.
7. A **GitHub App** and **Bitbucket credentials** for the endpoints you configure (see `docs/providers/`).

## Key Vault secrets

secretspec stores each secret under the name `secretspec--<base32(project)>--<base32(profile)>--<base32(key)>`, where each component is lowercase, unpadded Base32. Key Vault names allow only letters, digits and hyphens, which is why the components are encoded. The project is `git-migrator` and the profile is `production`.

| Key | Content | Required | Key Vault secret name |
|---|---|---|---|
| `POSTGRES_PASSWORD` | Password of the Postgres role | yes | `secretspec--m5uxillnnftxeylun5za--obzg6zdvmn2gs33o--kbhvgvchkjcvgx2qifjvgv2pkjca` |
| `BETTER_AUTH_SECRET` | Better Auth signing secret, at least 32 random bytes in base64 | yes | `secretspec--m5uxillnnftxeylun5za--obzg6zdvmn2gs33o--ijcvivcfkjpucvkujbpvgrkdkjcvi` |
| `ENTRA_CLIENT_ID` | Entra app registration client id | yes | `secretspec--m5uxillnnftxeylun5za--obzg6zdvmn2gs33o--ivhfiusbl5buyskfjzkf6ske` |
| `ENTRA_CLIENT_SECRET` | Entra app registration client secret | yes | `secretspec--m5uxillnnftxeylun5za--obzg6zdvmn2gs33o--ivhfiusbl5buyskfjzkf6u2finjekva` |
| `BITBUCKET_CREDENTIALS` | JSON array `[{id, accountId, email, apiToken}]` | yes | `secretspec--m5uxillnnftxeylun5za--obzg6zdvmn2gs33o--ijeviqsvinfukvc7injekrcfjzkesqkmkm` |
| `GITHUB_APP_PRIVATE_KEY` | PEM private key of the GitHub App | yes | `secretspec--m5uxillnnftxeylun5za--obzg6zdvmn2gs33o--i5eviscvijpucucql5ifeskwifkekx2livmq` |
| `ATLASSIAN_ADMIN_API_KEY` | Atlassian Admin API key for email enrichment | no | `secretspec--m5uxillnnftxeylun5za--obzg6zdvmn2gs33o--ifkeyqktkneucts7ifce2skol5avask7jncvs` |

The names were derived from the encoding in secretspec's Azure Key Vault provider (`secretspec/src/provider/akv.rs`) and are not read from a running vault. Confirm them once against the pinned secretspec release (0.21.1): set a secret with `secretspec set`, list the vault (`az keyvault secret list --vault-name <vault> --query '[].name'`) and compare. If the names differ, the `secretspec set` command below is still the source of truth and no chart value changes.

### One-time population

Run this from a machine whose Azure CLI session can write secrets to the vault (a data-plane role such as Key Vault Secrets Officer, held by the operator and never by the workload identity). secretspec prompts for each value, so no secret appears in shell history or argv.

```sh
VAULT=<vault-name>
b32() { printf '%s' "$1" | base32 | tr -d '=' | tr 'A-Z' 'a-z'; }
for key in POSTGRES_PASSWORD BETTER_AUTH_SECRET ENTRA_CLIENT_ID ENTRA_CLIENT_SECRET \
           BITBUCKET_CREDENTIALS GITHUB_APP_PRIVATE_KEY ATLASSIAN_ADMIN_API_KEY; do
  secretspec set "$key" --profile production --provider "akv://${VAULT}?auth=cli"
  echo "stored $key as secretspec--$(b32 git-migrator)--$(b32 production)--$(b32 "$key")"
done
secretspec check --profile production --provider "akv://${VAULT}?auth=cli"
```

The script prints the vault secret name of each key it stores; compare them with the table above and with `az keyvault secret list`. `ATLASSIAN_ADMIN_API_KEY` is optional: skip it unless you use email enrichment. `secretspec check` must report no missing required key before the first install. Endpoint credentials named in `config.endpoints[].credentialsSecret` are keys of the same manifest.

## Workload identity

1. Create the federated credentials on the managed identity. **Two** subjects are needed, because the migrate Job runs under its own hook ServiceAccount (DEP-030):

   ```sh
   ISSUER=$(az aks show -g <rg> -n <cluster> --query oidcIssuerProfile.issuerUrl -o tsv)
   for sa in <release> <release>-migrate; do
     az identity federated-credential create --name "git-migrator-${sa}" \
       --identity-name <identity> --resource-group <rg> --issuer "$ISSUER" \
       --subject "system:serviceaccount:<namespace>:${sa}" --audiences api://AzureADTokenExchange
   done
   ```

   The subjects are `system:serviceaccount:<namespace>:<release>` and `system:serviceaccount:<namespace>:<release>-migrate`. With `fullnameOverride` the release name is replaced by that value. With `serviceAccount.name` set the first subject is that name.
2. The chart annotates both ServiceAccounts with `azure.workload.identity/client-id: <azure.workloadIdentityClientId>` and labels every pod `azure.workload.identity/use: "true"`. The pods set `automountServiceAccountToken: false`; the workload identity webhook injects its own projected token.
3. `GM_SECRETSPEC_PROVIDER` defaults to `akv://<azure.keyVaultName>?auth=workload_identity`. Set `secretspec.provider` to use another vault URI.

## Install and upgrade

```sh
helm upgrade --install git-migrator oci://ghcr.io/<owner>/charts/git-migrator --version <x.y.z> \
  --namespace git-migrator --create-namespace -f my-values.yaml
```

A minimal `my-values.yaml`:

```yaml
image: { repository: <owner>/git-migrator }
azure: { workloadIdentityClientId: <client-id>, keyVaultName: <vault> }
postgres: { host: <server>.postgres.database.azure.com }
ingress: { host: git-migrator.example.com, clusterIssuer: letsencrypt }
config:
  auth:
    entra: { tenantId: <tenant-guid> }
    roleMappings: [ { method: entra, claim: roles, value: GitMigrator.Admin, role: admin } ]
  endpoints: [ ... ]
  routes: [ ... ]
```

The image tag defaults to the chart's `appVersion`, which the release workflow sets to the git tag. Every upgrade first runs the `migrate` Job (pre-install and pre-upgrade hook); if it fails the release stops and the Deployments are untouched. `values.config` is merged with the top-level values the app needs (`postgres`, `worker.*.concurrency`, `observability`, `metrics.port`, `secretspec.profile`); those win on conflict. The `environment` defaults to `production` and `publicUrl` to `https://<ingress.host>`. The config checksum annotation rolls the pods when the file changes.

### Chart notes

- **Disruption budgets** take one of `minAvailable` and `maxUnavailable`. The defaults set one per workload (`web.pdb.minAvailable: 1`, `maxUnavailable: 1` for workers), so to use the other, set the default to null: `--set web.pdb.minAvailable=null --set web.pdb.maxUnavailable=1`. Setting both fails the render.
- **NetworkPolicy** (`networkPolicy.enabled`, off by default) restricts ingress only. By default the web port 3000 is open to every source, because the ingress controller's namespace is unknown. Set `networkPolicy.ingressFrom` to a list of NetworkPolicy peers (for example `- namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: ingress-nginx } }`) to allow only those. Metrics and worker health ports stay open to pods in the release namespace.
- **Web shutdown:** the web container sleeps 5 s in `preStop` so the Service and Ingress stop routing before the server stops accepting; the drain then takes at most 20 s, inside the 30 s grace period.

`pnpm helm:check` lints and renders the chart for every `deploy/helm/git-migrator/ci/*.yaml` file, validates the output with `kubeconform -strict` against the current AKS default Kubernetes version, and runs the helm-unittest suites in `tests/`.

## Releases

Pushing a tag `v<major>.<minor>.<patch>[-prerelease]` runs `.github/workflows/release.yml`: it builds the multi-arch image (`linux/amd64`, `linux/arm64`), pushes it to `ghcr.io/<owner>/git-migrator:<tag>` with provenance and an SBOM, then packages the chart (version is the tag without `v`, `appVersion` is the tag) and pushes it to `oci://ghcr.io/<owner>/charts`. The workflow uses only `GITHUB_TOKEN`. Gates, in order: the tag is well formed; the tagged commit is an ancestor of `origin/main`; the amd64 image passes `smoke.sh` before anything is pushed (arm64 is built but not smoke-tested); an existing image tag or chart version is never overwritten; and the publishing jobs run in the GitHub environment `release`. Create that environment in the repository settings and add required reviewers, otherwise that last gate is not enforced.

## Worker database connections (JOB-014)

Each process creates one shared BullMQ `pg.Pool` (ADR-0210) and one application pool. Maximum connections per process:

```
bullmq pool     = workers + 4          (each Worker holds one LISTEN client; 4 serve queries)
application     = postgres.pool.app    (default 10)
leader election = 1                    (standard and all roles only)
total           = bullmq + application + leader
```

| Process | Workers | BullMQ pool | App pool | Leader | Total (defaults) |
|---|---|---|---|---|---|
| `worker --role standard` | 6 | 10 | 10 | 1 | 21 |
| `worker --role large` | 1 | 5 | 10 | 0 | 15 |
| `worker --role all` | 7 | 11 | 10 | 1 | 22 |
| `migrate` | 0 | 0 | 2 | 0 | 2 to 3 at a time |

The BullMQ pool is a cap: measured with the `all` role and 20 jobs processed, it held 4 connections. Size `max_connections` for the sum over all pods plus the web pods' pools.

Each web pod holds at most 20 connections at the defaults:

- the application pool (`postgres.pool.app`, default 10);
- the Better Auth pool (5, DATA-010);
- the BullMQ pool of the queue producer (no Workers, so 4);
- the one LISTEN connection of the event hub (JOB-060).

### Connection-count formula

With the chart defaults (`web.replicas: 2`, `worker.standard.replicas: 2`, `worker.large.replicas: 1`, `postgres.pool.app: 10`):

```
web              = web.replicas × (pool.app + 5 + 4 + 1)
worker-standard  = standard.replicas × (6 + 4 + pool.app + 1)
worker-large     = large.replicas × (1 + 4 + pool.app)
migrate          = up to 3 while the hook Job runs (before the new pods start)
total            = web + worker-standard + worker-large
                 = 2×20 + 2×21 + 1×15 = 97
usable           = max_connections − superuser_reserved_connections (15 on Flexible Server)
rolling          = total × 1.25 (rolling updates start new pods before old ones stop)
                 + 10 (psql sessions, monitoring, the migrate Job)
                 ≈ 132 (131.25, rounded up)
```

**The rule (DATA-010).** The default deployment must stay under 80% of the server's connections: `total < 0.8 × usable`. The connections Azure reserves for itself (`superuser_reserved_connections`) are not usable by the application, so they are subtracted first.

- **Minimum for the defaults:** `max_connections ≥ 137`, because 97 / 0.8 + 15 = 136.25.
- **Recommended:** `max_connections ≥ 147`, so that a rolling update also fits (`rolling ≤ usable`: 132 + 15). At 147 the steady state uses 73% of the usable connections.

Small Flexible Server tiers have a lower default `max_connections` than this, so check the server parameter before installing. With HPA scale-out, use `web.hpa.maxReplicas` instead of `web.replicas`, and recompute. Lowering `postgres.pool.app` is the first lever. The BullMQ pool sizes follow the worker count and are not configurable.

## PostgreSQL extensions

`migrate` (DATA-030) creates the `app`, `auth` and `bullmq` schemas and the `pg_trgm` extension (trigram indexes for path search). Azure Database for PostgreSQL Flexible Server only lets a role create extensions that are allow-listed, so before the first install:

```sh
az postgres flexible-server parameter set --resource-group <rg> --server-name <server> \
  --name azure.extensions --value PG_TRGM
```

If the parameter already has a value, append `,PG_TRGM` to it. Without the allow-list entry the migrate Job fails at its first step with `extension "pg_trgm" is not allow-listed`, and the release stops. The database role needs to own the database (it creates schemas and tables in `app`, `auth`, `bullmq` and `public`). `postgres.sslmode` defaults to `require`; do not weaken it outside development. Entra authentication for Postgres (`postgres.auth: entra`) is optional and off by default.

## Worker health

Workers serve `GET /healthz` and `GET /readyz` on port 8081 from the first moment. `/readyz` is 503 while the worker waits for the database and its `app` and `bullmq` schemas (exponential backoff up to 10 s, 3 minutes in all, then the process exits with one logged error), 200 once the queue Workers run, and 503 again as soon as shutdown begins. `/healthz` stays 200 during the drain, and the health server closes last. In development run `pnpm db:migrate` (devenv does it for you; with Compose use `docker compose exec dev pnpm db:migrate`). On SIGTERM a worker stops taking jobs, lets in-flight jobs finish, then closes its pools; set `terminationGracePeriodSeconds` to 120 (standard) and 600 (large). After start-up the worker has no forced-exit timer of its own: the grace period is the only bound. Only a SIGTERM during start-up exits after at most 30 s (ADR-0213).

## Scratch

`GM_SCRATCH_DIR` (default `/scratch`) holds `<runId>` directories. Every worker pod removes directories older than 24 h at start-up and on `schedules.scratchCleanup`.

## Scheduler leader failover

The leader holds a session advisory lock on a dedicated connection. That session sets `idle_session_timeout` (6 ping intervals, at least 30 s) and short TCP keepalives, and pings every 5 s with a 10 s query timeout. If the leader's node or network disappears without closing the socket, the server drops the session and a follower takes over in about a minute.

## Run leases

A Run's lease token is unique per claim and renewed every 30 s (valid 2 min). A worker that cannot renew for 90 s stops the Run locally. Run queues use `maxStalledCount: 0`, so the reaper is the only resume path. On SIGTERM the executor hands the Run off (`handOffRun`): the lease is released with a 2-minute grace and no resumption is counted. While a Run waits for its resume or hand-off job, the reaper checks that the job still exists: a waiting job is never counted, and a job that died counts toward the 3-resumption bound (ADR-0212).
