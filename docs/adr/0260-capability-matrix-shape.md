# ADR-0260: Capability matrix shape, registry ownership and the dynamic overlay

- Status: accepted (spec updated)
- Date: 2026-10-08
- Task: T-058
- Affects: ADP-014, ADP-032, API-020 (capability-matrix), ADP-040, ARC-012

## Context

API-020 says `GET /capability-matrix` returns "Facet x source -> target fidelity from registry capabilities" and ADP-032 says the `registry` registers pair overrides. Neither fixes the response shape, how fidelity is derived from `FieldSupport`, which package owns the composition, or how read-time capabilities (ADP-011, `FacetRead.capabilities`) relate to the matrix.

## Decision

1. **Ownership.** `packages/registry` owns the composition (ARC-012 already lets it depend on core, canonical, facets, adapter-sdk and any adapter). `ProviderRegistry` wraps the core `FacetRegistry` (Facet definitions and overrides) and adds adapters. `createBuiltinRegistry()` is the one place that names the v1 Facets, adapters and the pipelines override. A composition error (duplicate adapter, capabilities for an unregistered Facet, an override naming an unregistered adapter or Facet, a missing Facet dependency, a cycle) throws `RegistryError` at construction.
2. **Shape.** `{ adapters, rows }`; one row per Facet in dependency order; one cell per ordered pair of distinct adapters with `fidelity`, `read` (source can read), `write` (target has a driver `apply`), `override` (ADP-032) and per-field `{ path, source, target, fidelity }`. The API route (a later task) serialises this object unchanged.
3. **Derivation.** Per field, from the two sides' static `FieldSupport` (an undeclared field is `supported`): `unsupported` on either side, or a `readOnly` target, gives `unsupported`; an `unreadable` source gives `unreadable`; a `constrained` side gives `lossy`; otherwise `exact`. An `unreadable` target means write-only and stays `exact`. A cell is the worst field (`exact < translated < lossy < unreadable < unsupported`). A side that does not declare the Facet gives `unsupported`; a source with `read: false` gives at least `unreadable`. `translated` is never produced: it is chosen by `translate` (ADP-040), not provable from capabilities. `write` is reported beside the fidelity, not folded into it, because several Facets are delivered without a driver write (`git-refs` by push, `pipelines` and `code-ownership` by Change Request, `members` by invitation, `secrets` by post task).
4. **Detect-only Facets** (`inScope: false`, `extras`) ignore the target's declarations, since they are never written (FAC-EXT-001).
5. **Dynamic overlay (for the analysis, T-061).** The matrix uses static capabilities only. Per repository, the analysis calls `effectiveFieldSupport(staticFields, read.capabilities)` (a dynamic path replaces the static entry, ADR-0231 section 3) and then `fieldFidelity(source, target)` on the merged fields, so a read-time `/forking: unsupported` makes that repository's cell `unsupported` without changing the global matrix. `computeCell` can be reused for a per-repository cell by passing the merged `FacetCapability`.

6. **Static ceiling.** The output carries `ceiling: 'static'`. Every cell is the worst case the declared capabilities allow for the pair, never `translated`, and a per-repository analysis can be worse (read-time capabilities, data-dependent findings). A consumer must not read `exact` as a guarantee.
7. **Monotone overlay.** `effectiveFieldSupport` keeps the worse of the static and the dynamic entry per path (supported < constrained < unreadable/readOnly < unsupported), so a read can add a limit but never lift one. Call it once per side.
8. **Immutability and checks.** `registry.facets` is a frozen read-only view; adapter capabilities are copied at construction. An override must name two different registered adapters and a Facet that at least one of them declares.

## Alternatives

- Fold `write: false` into fidelity: rejected, it would show `git-refs` as `unsupported` although FAC-GIT-003 says exact.
- Put the composition in `core`: rejected, `core` is pure and may not depend on adapters or facets.
- Compute the matrix per Route: rejected, API-020 has no Route parameter; Routes pick one cell.
