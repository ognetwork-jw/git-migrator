# ADR-0082: Plan aggregation

- Status: agent-decided
- Date: 2026-10-08

## Context

LIF-020 step 5 lists Plan contents but not their identity, ordering, the shape of Steps, or how the LIF-040 table (which is not derivable from `dependsOn`) reaches the engine.

## Decision

- **Identity and merging.** Plan items are keyed by (kind, facet, code, `paramsHash`), the ManualTask identity of LIF-020 step 6. Findings that collide on it are merged (paths unioned, sorted), never emitted twice. `params` are stored in JCS key order so that output does not depend on object key order.
- **Order is a pure function of the inputs.** Steps first (template order), then blockers, pre tasks, post tasks, warnings. Within a group: facet-less items, then facets in registry dependency order, then code, then `paramsHash` (code-unit order). `PlanItem.order` is the dense position across the whole Plan.
- **Steps** come from a `StepTemplate`: `REPOSITORY_STEP_TEMPLATE` (LIF-040 table) and `ENDPOINT_STEP_TEMPLATE` (LIF-081) are exported; fixed entries may carry a `when` flag (`liftProtection`, `changeRequests`, `overlays`, `sourceReadOnly`) supplied by the caller. A `facet.<key>.apply` step exists only for a translated, in-scope facet whose target capability is writable. Fail-closed checks: a writable facet that no step covers (and that is not in `appliedElsewhere`) is a `PlanError`; a facet step placed before the step of a facet it depends on is a `PlanError`.
- **Fidelity** of an item is the fidelity of the decisions at its paths when they agree, else absent; `accept-lossy` tasks therefore carry `lossy`.
- **Extra findings** (naming, existing target, dependency blockers) enter through `extraFindings` with the same merging and ordering. When `facetKey` is set the code must be declared by that facet with the same kind (completion and `verifiable` come from the declaration; the engine-owned accept-lossy code is rejected); facet-less ones are manual tasks.
- **`targetCaps` is required** (a `PlanError` when absent), because without it no facet could get an apply step and the Plan would silently omit them.
- **Readiness** of the Analysis alone is computed with `deriveReadiness` (every task open); run-origin blockers are combined by the caller.

## Alternatives

- Hard-code facet steps from `dependsOn`: the LIF-040 order (webhooks after branch rules) is not derivable.

## Affected requirements

LIF-004, LIF-020, LIF-040, LIF-081, ADP-040.
