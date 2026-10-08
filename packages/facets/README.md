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

Each module exports its `FacetDefinition` (`gitRefsDefinition`, `mergeSettingsDefinition`, `repositorySettingsDefinition`), built from the schema in `@git-migrator/canonical` and the contract in `@git-migrator/core`. Facets are pure and provider-neutral: they see canonical documents and capabilities, never provider payloads.

Tests for each facet check every row of its mapping table in `docs/spec/05-facets.md`, and `testing/integration/src/facets-git-settings-guidance.test.ts` calls `assertGuidanceCoverage` with the declared finding codes (ADR-0103).

Declared internal dependencies (ARC-012, checked by `pnpm lint`): @git-migrator/core, @git-migrator/canonical.

## access-control, code-ownership (T-051)

- `src/access-control/` and `src/code-ownership/` export `accessControl` and `codeOwnership` (`FacetDefinition`s) and their `*_FINDING_CODES`.
- `src/access-control/principals.ts` holds the FAC-006 helpers (`resolvePrincipal`, `principalPath`, `principalIsGranted`) that any principal-bearing facet can reuse.
- Tests build their resolvers with `src/test-support.ts`. Guidance coverage (FAC-002) is asserted from `testing/integration` (ADR-0107).
- Decisions: ADR-0105, ADR-0106.
