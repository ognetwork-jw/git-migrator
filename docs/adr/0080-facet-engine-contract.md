# ADR-0080: Facet engine contract in `core`

- Status: accepted (no spec change needed)
- Date: 2026-10-08

## Context

ADP-030 to ADP-032 give the `FacetDefinition` shape but name types owned by other packages (`z.ZodType`, `IdentityResolver`, `GroupResolver`, `RouteRuntime`, `RouteIndex`, `FacetCapability`) and leave open how purity (ADP-031) is enforced, what `CompareContext` holds, and how a registry validates definitions. `core` must stay dependency-free (ARC-012).

## Decision

- **Structural types.** `schema` is `DocumentParser<T>` (`{ parse(data): T }`; a Zod type satisfies it). Resolvers are minimal interfaces over the FAC-006 outcomes (`mapped | excluded | pending_invite | unmapped | team_missing`); `RouteRuntime` and `RouteIndex` are opaque read-only records. `FacetCapability`/`FieldSupport` are declared in `core` as in ADP-014. `FacetDefinition` gains optional `sets` (primitive-set paths, needed by ADP-021 beside `collections`). `CompareContext` is `{ targetCaps, route, routeIndex }` (the spec leaves it undefined). `FieldDecision` gains optional `defaulted` (see ADR-0081).
- **Registry validation at `register`:** kebab-case unique key; finding codes are `<facet>.<name>`, kind in blocker/pre/post/warning, `completion` only on tasks, `accept` only on `<facet>.accept-lossy`, `parity` requires `isTaskSatisfied`; policy keys are `<facet>.<name>`, distinct from finding codes, and a facet with policy keys must declare `<facet>.accept-lossy` as a `pre` task with completion `accept`; collection declarations are checked. `ordered()` validates the set (missing dependency, cycle, endpoint facet depending on a repository facet) and returns dependencies first with ties broken by key, so order never depends on registration order. `unknownPolicyKeys` lets config loading flag typos in `acceptLossy`.
- **Purity (ADP-031) is enforced, not trusted.** `translate` and `compare` receive deep-frozen copies (mutation throws), a thenable/non-object return is rejected, and every thrown error is wrapped in `FacetEngineError` (`translate_failed`). Source and result pass `schema.parse`, the facet's `normalize` and ADP-021 normalization, so `desired` is always canonical.
- **The engine owns acceptance.** A facet's `accepted` values are ignored and recomputed (FAC-005); `<facet>.accept-lossy` may not be returned by `translate`; every returned finding code must be declared with the matching kind; `verifiable` is derived from completion `parity` and a contradicting value is an error; `lossy` decisions need a policy key of the facet, other fidelities must not carry one; duplicate decision/diff paths, malformed paths and non-canonicalizable params are errors. A detect-only facet (`inScope: false`) returning blockers, tasks or lossy decisions is an error (failing closed rather than dropping a blocker).
- **Dependencies.** `translateAll` translates in registry order and passes each facet the `{source, desired}` of the dependencies it declares that were translated; a dependency without a source document is absent from `deps` and the dependent decides (typically a blocker). Facets without a source are reported as `skipped`.
- **ADP-032.** At most one override per `(source, target, facet)`; it replaces `translate` only, and its output goes through the same validation.

## Alternatives

- Depend on `zod` in `core`: breaks the "no internal dependencies / pure" rule for little gain.
- Trust facets to be pure and to set `accepted`: the review loop would have to catch every violation by reading code.

## Affected requirements

ADP-030, ADP-031, ADP-032, ADP-021, ADP-014, FAC-005, FAC-006, LIF-006.
