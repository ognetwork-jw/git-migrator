# ADR-0112: Branch-rules normalization and comparison

- Status: agent-decided
- Date: 2026-10-08
- Task: T-052
- Affects: FAC-BRR-001, FAC-BRR-002, ADP-021, LIF-060

## Context

The target reports no exemption lists unless the matching block flag is set, has no separate merge restriction, and holds named status checks rather than a count.

## Decision

- `normalize`: removes duplicate principals; empties `forcePushExempt` when `blockForcePush` is false and `deletionExempt` when `blockDeletion` is false (they mean nothing then, and ADR-0040 ignores the bypass list); turns a `changeRequest` that requires nothing into `null`. `null` and `[]` for push lists stay distinct (everyone vs nobody).
- `desired.restrictMerges` is always `null`, `desired.enforcement` always `enforced`, `deletionExempt` always `[]` (the target cannot represent them). `blocksCreations` (ADR-0041) is derived by the adapter from `restrictPushes !== null`; the facet only preserves the null/list distinction.
- `restrictMerges` equal to `restrictPushes` (as sets) is `translated`, not lossy: the one target list expresses both.
- `requireNoChangesRequested`: the target reader derives it from "reviews required" (T-033 contract). `desired` therefore holds `true` whenever the rule requires reviews (`minApprovals >= 1` after the cap, `requireCodeOwnerApproval`, `dismissStaleApprovals` or the source flag) and `false` otherwise, and a `translated` decision is recorded when reviews are required.
- `minPassingBuilds > 0` stays in `desired` with an `unsupported` decision and a post task. `compare` treats it as "none or some": it differs only when exactly one side is above 0, so the user may pick any number of checks. The diff, and so the Verified gate, remains until checks exist.
- Force-push exemptions are unavailable when the target capability for `/rules/forcePushExempt` is `unsupported` or `readOnly`; absent capabilities count as available (the runtime fallback of ADR-0040 belongs to T-033).
- The warnings `branch-rules.unknown-kind` and `branch-rules.branching-model` are declared but not emitted by `translate`: the canonical document carries no trace of them. They need a signal from the source reader (ADP-013).
