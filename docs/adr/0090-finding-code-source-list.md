# ADR-0090: One source list of Finding codes, with the FAC-006 generic codes

- Status: agent-decided
- Date: 2026-10-08

## Context

FAC-002 requires guidance for every Finding code a Facet emits. The codes live in `docs/spec/05-facets.md` in three forms: the per-facet "**Findings:**" lines, codes named in prose (for example the three `extras.*-not-migrated` warnings, `org-secrets.set-value`, and the `<facet>.unmapped-principal` and `<facet>.pending-invitation` tasks that FAC-006 defines for every facet with principals), and policy keys (`<facet>.<name>` in "lossy `x.y`" text), which FAC-005 keeps in a separate namespace from finding codes. The Facet implementations (T-050 to T-057) do not exist yet, and T-012 may not be merged, so the guidance package cannot import codes from them.

## Decision

- `packages/guidance/src/codes.ts` is the single source list. Each row gives the code, facet, severity (`blocker`, `pre`, `post`, `warning`), the `(v)` verifiable flag and the spec section.
- Policy keys are not finding codes. Each lossy policy key is covered by its facet's `<facet>.accept-lossy` pre task, which is listed.
- The FAC-006 generic codes are listed for the facets whose documents contain principals: `access-control`, `branch-rules`, `code-ownership` and `teams`. Each gets `<facet>.unmapped-principal` (pre) and `<facet>.pending-invitation` (post, v). `access-control` and `branch-rules.unmapped-principal` are also named explicitly in the spec.
- `members` is not given the generic codes. Its own findings (`members.review-identity-mapping`, `members.pending-acceptance`) already cover the same two cases.
- `org-variables`, `org-secrets` and `org-webhooks` reuse the repository codes they name (`org-secrets.set-value`; `webhooks.*` for organization webhooks, per FAC-END). No `org-webhooks.*` codes are invented.
- The LIF-031 blockers are in the same list, as lifecycle codes (facet `lifecycle`), not facet codes: `naming.invalid`, `naming.collision` and `target.exists-nonempty` (all named in the LIF-031 bullets of `06-migration-lifecycle.md`), and `target.owned-by-other-migration` (added by T-013; now named in the LIF-031 bullets, commit 6358986, so no longer pending; ADR-0095 is the orchestrator's addendum record). They are blockers, so they need guidance like any other.
- `target.exists-foreign-adopted` is excluded. LIF-031 says it is information only (an empty existing target is adopted automatically), so it is not a blocker and has no guidance entry. The LIF-031 test lists it as an exemption with that reason. Adding it to `codes.ts` would fail the test.
- The LIF-031 check derives its expected set from the backticked names in the LIF-031 bullets of the lifecycle spec, not from `codes.ts`. A blocker named in the spec but missing from the list fails the test. That is how `naming.invalid` was missed in round 2.
- `org-secrets.set-value` is a code of its own because the spec names it, with its own guidance (organization-scoped `gh secret set`).

## Alternatives

- Generate the list from the spec at build time. Rejected: prose extraction is fragile, and a source list that the tests check against the spec is easier to review.
- Also treat policy keys as codes. Rejected: FAC-005 says policy keys are a separate namespace, and their tasks are already covered by `<facet>.accept-lossy`.
- Give `members` the generic codes too. Rejected: it would duplicate `members.review-identity-mapping` and `members.pending-acceptance` with different wording.

## Affected requirements

FAC-002, FAC-005, FAC-006, UI-040.
