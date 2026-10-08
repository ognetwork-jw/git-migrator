# @git-migrator/facets

Built-in FacetDefinitions, one module per facet (`src/<facet>/index.ts`, tests beside it).

Implemented:

| Facet | Module | Task | ADR |
|---|---|---|---|
| `environments` | `src/environments` | T-054 | 0145 |
| `secrets` | `src/secrets` | T-054 | 0145 |
| `variables` | `src/variables` | T-054 | 0145 |
| `git-refs` | `src/git-refs` | T-050 | 0100 |
| `merge-settings` | `src/merge-settings` | T-050 | 0101 |
| `repository-settings` | `src/repository-settings` | T-050 | 0102 |
| `change-requests` | `src/change-requests` | T-055 | 0155 |
| `extras` | `src/extras` | T-055 | 0156 |
| `webhooks` | `src/webhooks` | T-053 | 0141 |
| `deploy-keys` | `src/deploy-keys` | T-053 | 0142 |
| `members` | `src/members` | T-056 | 0150 |
| `teams` | `src/teams` | T-056 | 0150 |
| `org-variables` | `src/org-variables` | T-056 | 0151 |
| `org-secrets` | `src/org-secrets` | T-056 | 0151 |
| `org-webhooks` | `src/org-webhooks` | T-056 | 0152 |
| `pipelines` | `src/pipelines` | T-057 | 0160 |

Each module exports its `FacetDefinition` (`gitRefsDefinition`, `mergeSettingsDefinition`, `repositorySettingsDefinition`, `webhooksDefinition`, `deployKeysDefinition`, `pipelinesDefinition`), built from the schema in `@git-migrator/canonical` and the contract in `@git-migrator/core`. Facets are pure and provider-neutral: they see canonical documents and capabilities, never provider payloads.

Tests for each facet check every row of its mapping table in `docs/spec/05-facets.md`, and `testing/integration/src/facets-git-settings-guidance.test.ts` calls `assertGuidanceCoverage` with the declared finding codes (ADR-0103).

T-053 follows the same rule in `facets-webhooks-deploykeys-guidance.test.ts`. Reader helper: `mergeDuplicateWebhooks` (adapters call it before building a `webhooks` document, ADR-0141). Inputs the Route supplies: `route.webhookAllowlist` (URL patterns) and `routeIndex.deployKeyUsage` (`Record<publicKey, number>`, plain JSON).
Endpoint-level facets (`members`, `teams`, `org-*`) share `src/endpoint-support.ts`. Their parity ignores what exists only on the target (ADR-0150). `teams` plans each team slug from the group mapping or the Route's `teamNaming` pipeline and relies on `routeIndex.plannedSlugs` / `routeIndex.invitationCandidates` / `routeIndex.targetOrgMembers` (plain JSON, filled by the Analysis job). Their guidance coverage test is `testing/integration/src/facets-members-teams-org-guidance.test.ts`.

Declared internal dependencies (ARC-012, checked by `pnpm lint`): @git-migrator/core, @git-migrator/canonical.

## access-control, code-ownership (T-051)

- `src/access-control/` and `src/code-ownership/` export `accessControl` and `codeOwnership` (`FacetDefinition`s) and their `*_FINDING_CODES`.
- `src/access-control/principals.ts` holds the FAC-006 helpers (`resolvePrincipal`, `principalPath`, `principalIsGranted`) that any principal-bearing facet can reuse.
- Tests build their resolvers with `src/test-support.ts`. Guidance coverage (FAC-002) is asserted from `testing/integration` (ADR-0107).
- Decisions: ADR-0105, ADR-0106.

## branch-rules

`src/branch-rules/` implements the branch-rules Facet (FAC-BRR): `normalize`, `translate` (findings, policy keys, FAC-006 principal codes), `compare` and `isTaskSatisfied`. Rules are created in `branchRuleApplyOrder` (from `@git-migrator/canonical`), and a wildcard rule folded under another wildcard rule raises `branch-rules.overlap-unresolved` because the target applies the older wildcard rule. Decisions: ADR-0110 to ADR-0113.

## pipelines (T-057)

`pipelines` is the neutral half of FAC-PIP: normalization, one-directional path parity, the finding declarations and a fail-closed default translation. The translation that generates workflows is a pair override, which holds provider vocabulary and therefore lives in an adapter package (ADR-0160). Its corpus of pipeline samples with golden workflows is in `test/pipelines/` (data only, ADR-0163).
