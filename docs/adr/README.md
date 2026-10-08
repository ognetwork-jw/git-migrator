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
| [0028](0028-dependency-rule-checker.md) | Custom dependency-rule checker for ARC-012 | accepted (spec updated) |
| [0029](0029-spec-coverage-modes.md) | spec:coverage runs report-only until the end of the project | accepted (spec updated) |
| [0030](0030-coverage-placeholders.md) | Coverage thresholds, placeholders and module resolution | accepted (spec updated) |
| [0035](0035-merge-settings-from-main-branch.md) | Bitbucket merge settings are read from the main branch (FAC-MRG-002) | accepted (spec updated) |
| [0036](0036-unverified-bitbucket-items.md) | Bitbucket facts the published docs cannot settle | accepted (spec updated) |
| [0040](0040-force-push-fail-closed.md) | Force-push exemptions follow the spec pairing and fail closed on GitHub | accepted (spec updated) |
| [0041](0041-blocks-creations-follows-push-restriction.md) | `blocksCreations` follows `restrictsPushes` | accepted (spec updated) |
| [0045](0045-ai-main-integration-branch.md) | Agents integrate into `ai-main`; the human merges into `main` | accepted (user decision) |
| [0046](0046-hook-test-harness.md) | Hooks are tested by running them in bash against real temporary repositories | accepted (no spec change needed) |
| [0047](0047-proc-012-guard-rules.md) | PROC-012 guard rules under ADR-0045, and the fail-closed policy | accepted (no spec change needed) |
| [0048](0048-proc-013-014-stop-hooks.md) | Scope, triggers and loop guard of the SubagentStop and Stop hooks | accepted (no spec change needed) |
| [0049](0049-ci-pinning-and-gitleaks.md) | CI jobs, action pinning and the gitleaks scan | accepted (no spec change needed) |
| [0055](0055-core-pure-sha256-and-jcs.md) | Pure SHA-256 in `core`, and a strict RFC 8785 serializer | accepted (no spec change needed) |
| [0056](0056-field-path-and-pattern-syntax.md) | Field path escaping and Expected Difference pattern semantics | accepted (no spec change needed) |
| [0057](0057-collection-normalization.md) | Declaring and normalizing keyed collections | accepted (no spec change needed) |
| [0058](0058-lifecycle-edge-cases.md) | Lifecycle state machine edge cases | accepted (spec updated) |
| [0059](0059-readiness-and-policy-resolution.md) | Readiness inputs and lossy-policy resolution in `core` | accepted (no spec change needed) |
| [0060](0060-fake-bitbucket-behavior.md) | Fake Bitbucket behavior choices where the spec is silent | accepted (no spec change needed) |
| [0061](0061-bitbucket-response-validation.md) | How fake Bitbucket responses are validated against the OpenAPI document | accepted (no spec change needed) |
| [0070](0070-fake-git-url-layout-and-auth.md) | Fake git server URL layout and authentication | accepted (no spec change needed) |
| [0071](0071-fake-git-rejection-mechanisms.md) | How the fake target rejects oversized blobs and pushes | accepted (no spec change needed) |
| [0072](0072-fake-git-seeding.md) | Seeding fake git repositories with `git fast-import` | accepted (no spec change needed) |
| [0080](0080-facet-engine-contract.md) | Facet engine contract in `core`: structural types, registry validation, enforced purity | accepted (no spec change needed) |
| [0081](0081-expected-differences-in-the-engine.md) | Expected Difference generation and subtraction (LIF-063 masking, `unreadable_defaulted`, migration-scoped accepts) | accepted (no spec change needed) |
| [0082](0082-plan-aggregation.md) | Plan aggregation: identity, deterministic order, step templates | accepted (no spec change needed) |
| [0085](0085-principal-entries.md) | Principal lists are keyed collections of `{ principal }` | accepted (spec updated) |
| [0086](0086-scoped-collection-key.md) | `variables` and `secrets` carry a derived `key` field | accepted (spec updated) |
| [0087](0087-org-facet-schemas-and-strictness.md) | Endpoint-level secrets/variables/webhooks schemas; strict objects | accepted (spec updated) |
| [0088](0088-parse-validation-and-webhook-keys.md) | Parse-time key validation, webhook keys, URL and text rules, schema versions | accepted (spec updated) |
| [0095](0095-naming-semantics.md) | Naming pipeline semantics, validation and collision keys | agent-decided |

New ADRs continue from 0028. Implementor decisions use `status: agent-decided` (PROC-005).
