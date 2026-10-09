# ADR-0313: Where the T-043 table and the implementation disagreed

- Status: accepted (spec updated)
- Date: 2026-10-08
- Task: T-061
- Affects: TST-012, FAC-BRR-001, FAC-WEB-002, FAC-006, AUTH-050, LIF-004

## Context

The T-043 expectation table was derived from the spec text before the facets existed and says so: when a facet lands and disagrees, fix the data and the table together and record why. The first full Analysis of the world differed in four ways.

## Decision

1. **`branch-rules.branching-model` on every repository.** The fake Bitbucket (like a default repository) returns an effective model with four enabled branch types, and the adapter warned whenever the prefixes list was non-empty. A default model that no restriction uses tells the operator nothing. The adapter now warns only when a `branching_model` restriction used it or a production branch is configured. This is a deliberate narrowing of the FAC-BRR-001 warning, which says to inform about prefixes and dev/prod branches that GitHub lacks: prefixes alone, with nothing referring to them, are not reported any more. It is a warning only; it never gates, so readiness is unaffected. A development branch that differs from the main branch (`use_mainbranch: false`) is still reported. The table is unchanged.
2. **`data/with-grants` also raises blocker `branch-rules.team-missing`.** The push restriction names the group `platform-team`, which has no created team (FAC-006: `<facet>.team-missing` for every facet that holds the principal). The table and `world-spec.ts` gain the finding.
3. **`ops/hooks` raised `webhooks.set-secret` next to `recreate-manually`** for the non-allowlisted hook. FAC-WEB-002 says such a hook appears only as the recreate task (open T-053 review finding). The facet (and `org-webhooks`, which shares the code) no longer emits `set-secret` for a hook that is not created. The table is unchanged.
4. **Email matching needs the Atlassian Admin enrichment** (AUTH-050 step 1), which the Bitbucket adapter does not build yet (T-060 follow-up). The integration test supplies emails to the source Identities through a decorator on `EndpointConnection`, like the inventory test, so `alice` is matched by email. Without them `data/with-grants` would also report `alice` as unmapped.

## Alternatives

- Add the branching-model warning to all fifteen rows: noise that hides the rows' purpose.
- Fix the table to include the duplicate webhook task: contradicts FAC-WEB-002.

## Affected requirements

TST-012, FAC-BRR-001, FAC-WEB-002, FAC-006, AUTH-050.
