# @git-migrator/adapter-github

The GitHub provider adapter (T-033, ADP-010) and the `bitbucket-cloud` to `github` pipelines pair override (T-057).

## What is here

- `createGitHubAdapter()` / `githubAdapter` (`src/adapter.ts`): `connect(endpoint, ctx)` returns an `EndpointConnection` with inventory (namespaces, repositories, identities, teams), `repositories.create/delete/isEmpty`, `refs.setDefaultBranch/compare`, `lfs.missing` (LFS batch `download`), the Change Request writer (LIF-047), the invitation writer and seat info (AUTH-060), limits, Git access (`x-access-token` with the cached installation token) and a driver for every facet except `extras`.
- `src/auth.ts`: App JWT (RS256) and the installation token cache (refresh 5 minutes before expiry, single-flight per installation).
- `src/http.ts`: request classifier (`core`, `graphql`, `search`, `lfs`, content creation 80/min and 500/h, in-flight cap through `QuotaLeases`), `interpret` (`x-ratelimit-*` with `resource` to fixed-window feedback, secondary limits, GraphQL cost) and the token shapes. All HTTP goes through `ProviderHttpClient`; `pnpm lint` fails on direct HTTP in adapter code (ADP-060, ADR-0223).
- `src/facets/*`: one driver per facet (reads capture raw responses; writes never retry; `apply` is idempotent).
- Decisions: `docs/adr/0230-github-adapter-identity-and-connection.md`, `docs/adr/0231-github-facet-drivers.md`.

## Tests

Unit tests run the adapter against the fake GitHub (`testing/provider-fakes`) through the client's `fetch` seam; nothing reaches a real host (TST-006). `src/harness.test.ts` builds the connection.

Declared internal dependencies (ARC-012, checked by `pnpm lint`): @git-migrator/adapter-sdk, @git-migrator/canonical, @git-migrator/core.

## Pipelines pair override

`src/pair-overrides/bitbucket-cloud-pipelines` (T-057): the pair override `bitbucket-cloud` to `github` for the `pipelines` facet (FAC-PIP-002), exported as `bitbucketCloudToGithubPipelines`, plus `translatePipelinesYaml(text, names)` which returns the workflow files and the unsupported YAML paths. The context it expects and the safety rules are in ADR-0160 and ADR-0161; the corpus and goldens are in `packages/facets/test/pipelines/`. Regenerate goldens with `UPDATE_GOLDEN=1 pnpm vitest run --project unit packages/adapters/github`, then review the diff.
