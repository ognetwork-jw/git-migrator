# ADR-0091: How the finding-code list is cross-checked against the spec

- Status: agent-decided
- Date: 2026-10-08

## Context

`codes.ts` (ADR-0090) must not drift from `docs/spec/05-facets.md`, or from the LIF-031 blockers in `docs/spec/06-migration-lifecycle.md`. The spec is normative, and implementors may not edit it, so the list follows the spec.

## Decision

`packages/guidance/src/spec-crosscheck.test.ts` checks the following.

1. Every bare dotted name on a "**Findings:**" line must carry a recognised mark (`pre`, `post`, `B` or `W`), must be a listed code, and must have the same severity and `(v)` marker. A name without a mark fails.
2. Every dotted name written in backticks anywhere in `05-facets.md` must be one of three things:
   - a finding code in `codes.ts`;
   - a policy key in `KNOWN_POLICY_KEYS`, which the test pins to the exact set the spec names (FAC-005). Each policy key's facet must have a `<facet>.accept-lossy` task;
   - an entry in `NON_CODE_NAMES`, an explicit allowlist of pipeline YAML fields, CI variables, file paths, placeholders and API fields. Each entry must still appear in the spec, so stale entries fail.
   Anything else fails the test. This replaces the earlier 30-character window heuristic, which could miss a code named far from its cue word.
3. Every facet code in `codes.ts` (except the FAC-006 generic ones) must be named in the facets spec. Lifecycle codes (LIF-031) are checked against `06-migration-lifecycle.md`.
4. The FAC-006 rule text still names `<facet>.unmapped-principal` and `<facet>.pending-invitation`, and the list has them for each principal facet.
5. Every emitting facet is in the spec's facet index. Lifecycle codes are not facets and are excluded.

Two decisions follow from check 2.

- `translation.unsupported` (FAC-PIP-002) is not a finding code. It is the list of unsupported YAML paths carried inside the pipelines translation, and it is rendered as a parameter of the pipelines task. It goes on `NON_CODE_NAMES`. (Orchestrator decision.)
- `target.owned-by-other-migration` (LIF-031, added by T-013) is in `codes.ts` as a blocker that needs guidance. It is now named in the LIF-031 bullets of `06-migration-lifecycle.md` (commit 6358986), so the pending mechanism (`PENDING_SPEC_CODES`) has been removed. It was briefly pending, while the orchestrator's addendum (ADR-0095) was not yet in the spec.

LIF-031 has its own two-way check. The expected set is the backticked dotted names in the LIF-031 bullets of `06-migration-lifecycle.md`, read from that bullet block. Each name must be a lifecycle code in `codes.ts`, unless it is exempt (`target.exists-foreign-adopted`: information only, no guidance). Each lifecycle code must be named in the spec.

The spec is found by walking up from the test file, because ARC-012 (`tools/check-deps.ts`) rejects relative paths that leave the package.

## Alternatives

- A full Markdown parser for the spec. Rejected: a heavy dependency for a few backticked names.
- Only check 1. Rejected: prose-only codes would drift silently.
- Keep the window heuristic. Rejected in favour of an exhaustive classification, which has no blind spot for distance from a cue word.

## Affected requirements

FAC-002, FAC-005, FAC-006, FAC-PIP-002, LIF-031, TST-002.
