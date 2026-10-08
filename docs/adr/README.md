# Architecture Decision Records

| ADR | Title | Status |
|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | accepted |
| [0002](0002-versions.md) | Dependency versions | accepted |
| [0003](0003-canonical-model.md) | Canonical model with pair overrides | accepted |
| [0004](0004-vocabulary.md) | Provider-neutral vocabulary; Actor vs Identity | accepted |
| [0005](0005-monorepo-build-time-adapters.md) | Monorepo, build-time adapters | accepted |
| [0006](0006-bullmq-postgres.md) | BullMQ on PostgreSQL | accepted |
| [0007](0007-api-shape.md) | ZenStack RPC + Hono custom endpoints | accepted |
| [0008](0008-postgres-schemas.md) | Separate Postgres schemas, no cross-schema foreign keys | accepted |
| [0009](0009-snapshot-storage.md) | Typed JSON for snapshots, relational for everything else | accepted |
| [0010](0010-deploy-time-endpoints.md) | Endpoints and Routes defined at deploy time | accepted |
| [0011](0011-flatten-namespaces.md) | Flatten Bitbucket projects into repository names and settings | accepted |
| [0012](0012-no-blob-storage.md) | No blob storage in v1 | accepted |
| [0013](0013-task-phases.md) | Pre- and post-run manual tasks | accepted |
| [0014](0014-branch-protection-not-rulesets.md) | Classic branch protection via GraphQL, not rulesets | accepted |
| [0015](0015-local-quota.md) | Local quota tracking | accepted |
| [0016](0016-change-requests-for-files.md) | In-repo changes only via Change Requests; post-cutover containment | accepted |
| [0017](0017-route-policies.md) | Route policies pre-accept lossy translations | accepted |
| [0018](0018-webhook-allowlist.md) | Webhooks auto-created only when allowlisted | accepted |
| [0019](0019-secrets-post-tasks.md) | Secrets are never set to placeholders | accepted |
| [0020](0020-source-read-only.md) | Source read-only on Bitbucket | accepted |
| [0021](0021-role-mapping.md) | Identity-provider claims mapped to in-app roles | accepted |
| [0022](0022-test-sign-in.md) | Test sign-in for automated and e2e runs | accepted |
| [0023](0023-provider-fakes.md) | HTTP-level provider fakes instead of Gitea or Forgejo | accepted |
| [0024](0024-secrets-runtime.md) | secretspec + Key Vault via workload identity | accepted |
| [0025](0025-single-image.md) | Single image, three entrypoints | accepted |
| [0026](0026-review-loop.md) | Review loop with fixup commits | accepted |
| [0027](0027-model-tiers.md) | Cheapest appropriate model per subagent | accepted |
| [0028](0028-dependency-rule-checker.md) | Custom dependency-rule checker for ARC-012 | agent-decided |
| [0029](0029-spec-coverage-modes.md) | spec:coverage runs report-only until the end of the project | agent-decided |
| [0030](0030-coverage-placeholders.md) | Coverage thresholds, placeholders and module resolution | agent-decided |
| [0035](0035-merge-settings-from-main-branch.md) | Bitbucket merge settings are read from the main branch (FAC-MRG-002) | accepted (spec updated) |
| [0036](0036-unverified-bitbucket-items.md) | Bitbucket facts the published docs cannot settle | accepted (spec updated) |
| [0040](0040-force-push-fail-closed.md) | Force-push exemptions follow the spec pairing and fail closed on GitHub | accepted (spec updated) |
| [0041](0041-blocks-creations-follows-push-restriction.md) | `blocksCreations` follows `restrictsPushes` | accepted (spec updated) |
| [0045](0045-ai-main-integration-branch.md) | Agents integrate into `ai-main`; the human merges into `main` | accepted (user decision) |

New ADRs continue from 0028. Implementor decisions use `status: agent-decided` (PROC-005).
