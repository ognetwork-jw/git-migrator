# deploy

- `docker/Dockerfile`: the image (stages `secretspec-cli`, `base`, `dev`, `build`, `runtime`; DEP-001). `docker/entrypoint.sh` is its entrypoint (DEP-002). `docker/smoke.sh <image>` runs the read-only UID 10001 smoke test that CI runs.
- `helm/git-migrator`: the chart (DEP-030). `ci/*.yaml` are the value files `pnpm helm:check` renders; `tests/*_test.yaml` are the helm-unittest suites.

Operations (Azure prerequisites, Key Vault secret names, workload identity, Postgres extensions, connection counts, releases) are in [docs/deployment.md](../docs/deployment.md). Decisions: ADR-0290 to ADR-0292.

```sh
pnpm helm:check                         # lint, template + kubeconform, helm-unittest
docker build -f deploy/docker/Dockerfile -t git-migrator:local .
deploy/docker/smoke.sh git-migrator:local
```

`helm:check` needs `helm` and `kubeconform` (devenv provides both) and, for the unit tests, the `helm-unittest` binary or the `helm unittest` plugin; CI installs it.
