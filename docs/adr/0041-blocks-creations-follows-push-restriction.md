# ADR-0041: `blocksCreations` follows `restrictsPushes`

- Status: accepted (spec updated)
- Date: 2026-10-08
- Task: T-031
- Affects: FAC-BRR-002 (`restrictPushes` row), FAC-BRR-001

## Context

FAC-BRR-002 maps `restrictPushes` to `restrictsPushes` plus `pushAllowances`. GraphQL (and the UI, "Restrict pushes that create matching branches") has a separate `blocksCreations` flag. The spec is silent on it. With `restrictsPushes: true` and `blocksCreations: false`, anyone with write access can still create a new branch whose name matches the pattern, which defeats a "only these principals may write" restriction.

## Decision

When `restrictPushes` is non-null (a list, possibly empty), set `blocksCreations: true`. When it is null, set `blocksCreations: false`. On read, `blocksCreations` is ignored for the canonical value (the canonical shape has no separate field) but a rule with `restrictsPushes: true` and `blocksCreations: false` is read as `restrictPushes` as usual, so such a rule compares equal on `restrictPushes` and is not reported as drift on that field alone.

The installation App has Administration permission, and people and apps with admin permission can always push or create matching branches, so framework pushes (resync) are not blocked.

## Alternatives

- Leave `blocksCreations` false. Rejected: weaker than the source restriction.
- Add a canonical `restrictCreations` field. Rejected: spec change, no source-side data for it.

## Consequences

Stricter than the minimum on GitHub. If the Bitbucket side is later shown not to restrict creation, revisit this ADR. The fake must model `blocksCreations`.
