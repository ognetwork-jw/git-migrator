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
| [0050](0050-config-overrides-and-errors.md) | Configuration environment overrides and error reporting | accepted (spec updated) |
| [0051](0051-config-schema-decisions.md) | Configuration schema decisions where DEP-040 is silent | accepted (spec updated) |
| [0052](0052-log-redaction.md) | Log redaction: keys, values and arguments | accepted (spec updated) |
| [0053](0053-metrics-registry.md) | Prometheus registry, metric labels and the metrics server | accepted (spec updated) |
| [0054](0054-tracing-export-policy.md) | Tracing starts without export; OTLP export only when configured | accepted (spec updated) |
| [0055](0055-core-pure-sha256-and-jcs.md) | Pure SHA-256 in `core`, and a strict RFC 8785 serializer | accepted (no spec change needed) |
| [0056](0056-field-path-and-pattern-syntax.md) | Field path escaping and Expected Difference pattern semantics | accepted (no spec change needed) |
| [0057](0057-collection-normalization.md) | Declaring and normalizing keyed collections | accepted (no spec change needed) |
| [0058](0058-lifecycle-edge-cases.md) | Lifecycle state machine edge cases | accepted (spec updated) |
| [0059](0059-readiness-and-policy-resolution.md) | Readiness inputs and lossy-policy resolution in `core` | accepted (no spec change needed) |
| [0060](0060-fake-bitbucket-behavior.md) | Fake Bitbucket behavior choices where the spec is silent | accepted (no spec change needed) |
| [0061](0061-bitbucket-response-validation.md) | How fake Bitbucket responses are validated against the OpenAPI document | accepted (no spec change needed) |
| [0065](0065-secretspec-manifest.md) | secretspec 0.21.1 manifest syntax and profile inheritance | accepted (no spec change needed) |
| [0066](0066-devenv-environment.md) | devenv environment | accepted (spec updated) |
| [0067](0067-docker-image.md) | Docker image stages and secretspec installation | accepted (spec updated) |
| [0068](0068-compose-and-placeholders.md) | Compose services and placeholder processes | accepted (spec updated) |
| [0069](0069-fixture-key-and-test-env.md) | Committed fake GitHub App key and `.env.test` | accepted (no spec change needed) |
| [0070](0070-fake-git-url-layout-and-auth.md) | Fake git server URL layout and authentication | accepted (no spec change needed) |
| [0071](0071-fake-git-rejection-mechanisms.md) | How the fake target rejects oversized blobs and pushes | accepted (no spec change needed) |
| [0072](0072-fake-git-seeding.md) | Seeding fake git repositories with `git fast-import` | accepted (no spec change needed) |
| [0075](0075-fake-github-structure.md) | Fake GitHub structure, control plane and git server wiring | accepted (no spec change needed) |
| [0076](0076-fake-github-unspecified-behavior.md) | Fake GitHub behavior where the provider doc and OpenAPI description are silent | accepted (no spec change needed) |
| [0077](0077-fake-github-rate-limit-model.md) | Fake GitHub rate limit model | accepted (no spec change needed) |
| [0080](0080-facet-engine-contract.md) | Facet engine contract in `core`: structural types, registry validation, enforced purity | accepted (no spec change needed) |
| [0081](0081-expected-differences-in-the-engine.md) | Expected Difference generation and subtraction (LIF-063 masking, `unreadable_defaulted`, migration-scoped accepts) | accepted (no spec change needed) |
| [0082](0082-plan-aggregation.md) | Plan aggregation: identity, deterministic order, step templates | accepted (no spec change needed) |
| [0085](0085-principal-entries.md) | Principal lists are keyed collections of `{ principal }` | accepted (spec updated) |
| [0086](0086-scoped-collection-key.md) | `variables` and `secrets` carry a derived `key` field | accepted (spec updated) |
| [0087](0087-org-facet-schemas-and-strictness.md) | Endpoint-level secrets/variables/webhooks schemas; strict objects | accepted (spec updated) |
| [0088](0088-parse-validation-and-webhook-keys.md) | Parse-time key validation, webhook keys, URL and text rules, schema versions | accepted (spec updated) |
| [0090](0090-finding-code-source-list.md) | One source list of Finding codes, with the FAC-006 generic codes | accepted (spec updated) |
| [0091](0091-spec-cross-check-method.md) | How the finding-code list is cross-checked against the facets spec | accepted (spec updated) |
| [0092](0092-guidance-template-syntax.md) | Guidance template syntax, typed parameters and escaping | accepted (spec updated) |
| [0093](0093-guidance-messages-and-i18n.md) | Where guidance messages live, and how next-intl renders them | accepted (spec updated) |
| [0094](0094-guidance-severity-links-and-unverified-urls.md) | Guidance severity model, and links that could not be verified | accepted (spec updated) |
| [0095](0095-naming-semantics.md) | Naming pipeline semantics, validation and collision keys | accepted (spec updated) |
| [0100](0100-git-refs-facet.md) | git-refs facet semantics | accepted (spec updated) |
| [0101](0101-merge-settings-facet.md) | merge-settings facet semantics | accepted (spec updated) |
| [0102](0102-repository-settings-facet.md) | repository-settings facet semantics | accepted (spec updated) |
| [0103](0103-facets-guidance-test-edge.md) | Guidance coverage test for the git/settings facets lives in testing/integration | accepted (no spec change needed) |
| [0105](0105-access-control-facet.md) | access-control facet: role merging, principal outcomes, finding paths, pending-invitation verification | accepted (spec updated) |
| [0106](0106-code-ownership-facet.md) | code-ownership facet: lossy keys, access check, empty entries, Change Request task | accepted (spec updated) |
| [0107](0107-facet-guidance-coverage-test-location.md) | Facet guidance coverage is asserted from `testing/integration` | accepted (no spec change needed) |
| [0110](0110-branch-rule-pattern-and-desired-syntax.md) | Branch-rule patterns in `desired` use the target dialect | accepted (spec updated) |
| [0111](0111-branch-rules-principal-findings.md) | Principal findings of branch-rules | accepted (no spec change needed) |
| [0112](0112-branch-rules-normalization-and-compare.md) | Branch-rules normalization and comparison | accepted (no spec change needed) |
| [0113](0113-branch-rule-overlap.md) | Overlapping branch-rule patterns and merged restrictions | accepted (spec updated) |
| [0130](0130-fixture-world-structure.md) | Fixture world structure, async fixtures and expectation derivation | accepted (no spec change needed) |
| [0140](0140-facet-context-plain-json.md) | The facet translate context must be plain JSON | accepted (no spec change needed) |
| [0141](0141-webhooks-facet.md) | webhooks facet semantics | accepted (spec updated) |
| [0142](0142-deploy-keys-facet.md) | deploy-keys facet semantics | accepted (no spec change needed) |
| [0145](0145-environments-variables-secrets-facets.md) | environments, variables and secrets facet semantics | accepted (spec updated) |
| [0155](0155-change-requests-facet.md) | change-requests facet: blocker parameters, list cap and desired state | accepted (no spec change needed) |
| [0156](0156-extras-facet.md) | extras facet: detect-only warnings and desired state | accepted (no spec change needed) |
| [0150](0150-endpoint-facets-members-teams.md) | members and teams facets: planned slug contract, skipped members, invitation candidates, target-only parity | accepted (spec updated) |
| [0151](0151-org-variables-secrets-facets.md) | org-variables and org-secrets facets: names, lossy key, one set-value task | accepted (spec updated) |
| [0152](0152-org-webhooks-facet.md) | org-webhooks facet: FAC-WEB rules under org codes and policy key | accepted (spec updated) |
| [0120](0120-zenstack-verification-and-dependencies.md) | ZenStack 3.9.7 verified (multi-schema, field `@deny`, `uuid(7)`); extra dependencies | accepted (no spec change needed) |
| [0121](0121-schema-decisions.md) | Domain model details: `Route.retiredAt`, endpoint-scope Migration, timestamptz, plain Json | accepted (spec updated) |
| [0122](0122-policy-decisions.md) | Access policy decisions: roles, hash and body denial, field-level narrowing | accepted (spec updated) |
| [0123](0123-migrations-tests-and-entrypoint.md) | Raw-SQL indexes, database tests in the unit tier, migrate entrypoint location | accepted (no spec change needed) |
| [0160](0160-pipelines-facet.md) | pipelines facet and where the pair override lives | accepted (spec updated) |
| [0161](0161-pipelines-translation-safety.md) | Safety rules of the generated workflows | accepted (spec updated) |
| [0162](0162-pipelines-translation-structure.md) | Shape of the generated workflows | accepted (spec updated) |
| [0163](0163-pipelines-corpus-and-test-layout.md) | Where the pipelines corpus and its tests live | accepted (no spec change needed) |
| [0180](0180-quota-service-design.md) | Quota service design: neutral feedback, near-limit clamp, secondary-hit counter, metrics sink | accepted (spec updated) |
| [0170](0170-auth-claims-session-and-tenant.md) | Entra claims read in `validateUserInfo`, request-scoped hand-off to Actor sync, tenant check, denial surface | accepted (spec updated) |
| [0171](0171-auth-provisioning-test-users-and-migration.md) | Actor linking, test sign-in users, production guard, programmatic Better Auth migration | accepted (spec updated) |

New ADRs continue from 0028. Implementor decisions use `status: agent-decided` (PROC-005). T-002 uses 0065–0069.
