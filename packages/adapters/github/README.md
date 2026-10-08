# @git-migrator/adapter-github

GitHub adapter.

Status: placeholder from T-001; a later task fills the adapter itself (see `docs/spec/15-work-breakdown.md`).

Implemented so far:

- `src/pair-overrides/bitbucket-cloud-pipelines` (T-057): the pair override `bitbucket-cloud` to `github` for the `pipelines` facet (FAC-PIP-002), exported as `bitbucketCloudToGithubPipelines`, plus `translatePipelinesYaml(text, names)` which returns the workflow files and the unsupported YAML paths. The context it expects and the safety rules are in ADR-0160 and ADR-0161; the corpus and goldens are in `packages/facets/test/pipelines/`. Regenerate goldens with `UPDATE_GOLDEN=1 pnpm vitest run --project unit packages/adapters/github`, then review the diff.

Declared internal dependencies (ARC-012, checked by `pnpm lint`): @git-migrator/adapter-sdk, @git-migrator/canonical, @git-migrator/core.
