# ADR-0163: where the pipelines corpus and its tests live

- Status: accepted (no spec change needed)
- Date: 2026-10-08
- Task: T-057
- Affects: FAC-PIP-002, TST-006, ARC-012

## Context

The T-057 acceptance puts the corpus in `packages/facets/test/pipelines/`, but the code under test lives in the GitHub adapter package (ADR-0160), which may not depend on `facets` and may not import files from another package by relative path (`tools/check-deps.ts`).

## Decision

- The corpus is data only: `packages/facets/test/pipelines/<sample>/bitbucket-pipelines.yml`, an optional `context.json` (names of variables and secrets), the golden `expected/<workflow>.yml` files and `expected.json` (generated paths and unsupported paths with reasons). It holds 31 samples: 12 supported scenarios and 19 with unsupported constructs, including approval gates, overlapping patterns, empty pipelines and non-plain YAML. The directory names and file names inside the data are provider vocabulary by necessity (the acceptance fixes the location); no code in `packages/facets/src` names a provider. No secrets or real repositories appear in it.
- `packages/adapters/github/src/pair-overrides/bitbucket-cloud-pipelines/corpus.test.ts` finds the directory by walking up from the test file (the same technique as `packages/guidance/src/spec-crosscheck.test.ts`; no import reaches into another package), runs every sample and compares with the goldens. `UPDATE_GOLDEN=1` rewrites the goldens; the diff must be reviewed.
- Unit tests of each FAC-PIP-002 row are in `translate.test.ts`, of the findings in `index.test.ts`; the facet's own rows (normalize, parity, tasks) are in `packages/facets/src/pipelines/pipelines.test.ts`. The engine, the override and guidance together are exercised in `testing/integration/src/facets-pipelines.test.ts`, which also covers the guidance coverage rule (ADR-0103 applies; `tools/check-deps.ts` is unchanged and `facets` does not depend on `guidance`).

## Alternatives

- Put the tests in `packages/facets`: it cannot import the adapter.
- Copy the corpus into the adapter package: two copies would drift; the acceptance names one location.
