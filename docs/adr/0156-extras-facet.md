# ADR-0156: extras facet: detect-only warnings and desired state

- Status: accepted (no spec change needed)
- Date: 2026-10-08
- Task: T-055
- Affects: FAC-EXT, FAC-EXT-001, FAC-002

## Context

FAC-EXT says each non-zero item raises a warning (`extras.wiki-not-migrated`, `extras.issues-not-migrated`,
`extras.downloads-not-migrated`) and that the facet never blocks. It does not say:

- the paths and params of each warning (the guidance for issues and downloads uses `count`);
- what the desired document holds, since nothing is migrated;
- whether a non-zero `releaseCount` warns. The spec says releases are 0 because the source has no such
  concept, so no warning is defined for them;
- whether the facet needs `isTaskSatisfied`.

## Decision

- `translate` emits one warning per populated item, in this fixed order: wiki, issues, downloads.
  - `wikiPopulated: true` raises `extras.wiki-not-migrated` at `/wikiPopulated`, with no params.
  - `issueCount > 0` raises `extras.issues-not-migrated` at `/issueCount`, with `{ count }`.
  - `downloadCount > 0` raises `extras.downloads-not-migrated` at `/downloadCount`, with `{ count }`.
- `releaseCount` never warns.
- `desired` is `{ wikiPopulated: false, issueCount: 0, downloadCount: 0, releaseCount: 0 }`: none of the
  detected items is migrated.
- `inScope: false` (detect-only), `compareMode: 'none'`. The facet emits no blockers, pre or post tasks,
  and no decisions, so the engine's detect-only check passes. `compare` is declared but never called.
- No `isTaskSatisfied`: there are no parity completion codes.

## Alternatives

- Warn on `releaseCount` as well, with a new code: rejected, it would add a finding code the spec does
  not name, and releases are always 0 on the source.
- Keep `desired` equal to the source: rejected, it would suggest the detected items are migrated.
