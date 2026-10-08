# ADR-0291: Helm chart naming, configuration merge and helm:check

- Status: accepted (spec updated)
- Date: 2026-10-08
- Task: T-090
- Affects: DEP-030, DEP-031, DEP-033, DEP-040, DEP-020

## Context

The spec fixes the templates, hooks, probes and values surface but not resource naming, the precedence between `values.config` and the top-level values, which settings are mandatory, the Kubernetes version for `kubeconform`, or how `pnpm helm:check` finds its tools.

## Decision

1. **Names.** Resources are named from the release name (`fullnameOverride` replaces it): `<release>-web`, `<release>-worker-standard`, `<release>-worker-large`, `<release>-config`, `<release>-config-migrate`, ServiceAccounts `<release>` and `<release>-migrate`, Job `<release>-migrate`. This matches the hook names in DEP-030. With `serviceAccount.create: false` no ServiceAccount is rendered and every pod uses `serviceAccount.name` (or `default`).
2. **Configuration merge (DEP-040).** `values.config` is merged over `{environment: production}`; `publicUrl` defaults to `https://<ingress.host>`; then `postgres`, `worker.{standard,large}.concurrency`, `observability`, `metrics.port` and `secretspec.profile` from the top-level values are merged on top and win. The result is one file shared by all workloads and by the hook copy.
3. **Required values** fail the render with a message: `image.repository`, `postgres.host`, `ingress.host` (when the Ingress is enabled), and `azure.keyVaultName` plus `azure.workloadIdentityClientId` unless `secretspec.provider` is set. The chart defaults therefore do not render alone; the `ci/*.yaml` files do.
4. **Additions to the values surface:** `fullnameOverride`, `terminationGracePeriodSeconds` per workload (30, 120, 600), `worker.service.enabled` (the optional worker Service), `worker.large.pdb`. Security contexts are not configurable (DEP-010).
5. **NetworkPolicy** (off by default) limits ingress only: the web port is open to any source unless `networkPolicy.ingressFrom` lists peers, in which case only those may connect (the ingress controller's namespace is unknown to the chart); metrics and worker health are limited to pods in the namespace. **PodDisruptionBudgets** take one of `minAvailable` and `maxUnavailable`; the defaults set one per workload, so the other needs the default set to null, and the chart fails when both or neither are set. The web container has a 5 s `preStop` sleep so routing catches up before the server stops accepting. Egress is not restricted, because Key Vault, Postgres and the providers have no stable addresses.
6. **Probes.** Web startup allows 3 minutes, workers 5 minutes (database wait, ADR-0213).
7. **Validation.** `pnpm helm:check` (`tools/helm-check.ts`) runs `helm lint --strict`, `helm template --kube-version` and `kubeconform -strict -kubernetes-version` for every `ci/*.yaml`, then helm-unittest (the standalone binary or the `helm unittest` plugin). The Kubernetes version is the constant `KUBERNETES_VERSION` (1.34.0, the AKS default when this was written); bump it with the AKS default. Missing `helm` or `kubeconform` is an error. A missing helm-unittest is a warning locally and an error when `CI` is set or `--require-unittest` is passed, because devenv (DEV-001) does not provide it.
8. The suites in `tests/` carry requirement IDs in their test names, but `pnpm spec:coverage` reads only TypeScript tests, so `tools/deployment.test.ts` repeats the structural checks for the same IDs.

## Alternatives

- Fixed resource names (`git-migrator-web`): two releases in one namespace would clash.
- `values.config` winning over the top-level values: the same setting would silently have two sources of truth in `values.yaml`.
- Adding helm-unittest to `devenv.nix`: outside this task's files, and the spec lists devenv packages.

## Affected requirements

DEP-020, DEP-030, DEP-031, DEP-033, DEP-040.
