# @git-migrator/facets

Built-in FacetDefinitions, one module per facet (`src/<facet>/index.ts`, tests beside it).

Implemented:

| Facet | Module | Task | ADR |
|---|---|---|---|
| `git-refs` | `src/git-refs` | T-050 | 0100 |
| `merge-settings` | `src/merge-settings` | T-050 | 0101 |
| `repository-settings` | `src/repository-settings` | T-050 | 0102 |

Each module exports its `FacetDefinition` (`gitRefsDefinition`, `mergeSettingsDefinition`, `repositorySettingsDefinition`), built from the schema in `@git-migrator/canonical` and the contract in `@git-migrator/core`. Facets are pure and provider-neutral: they see canonical documents and capabilities, never provider payloads.

Tests for each facet check every row of its mapping table in `docs/spec/05-facets.md`, and `testing/integration/src/facets-git-settings-guidance.test.ts` calls `assertGuidanceCoverage` with the declared finding codes (ADR-0103).

Declared internal dependencies (ARC-012, checked by `pnpm lint`): @git-migrator/core, @git-migrator/canonical.
