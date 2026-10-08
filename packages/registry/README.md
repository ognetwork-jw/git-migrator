# @git-migrator/registry

Build-time composition of adapters, facets and pair overrides (ADP-032, ARC-010).

- `createBuiltinRegistry()` registers every built-in Facet, both adapters and the pipelines pair override. Composition errors throw `RegistryError` at construction.
- `ProviderRegistry` wraps the core `FacetRegistry` (`registry.facets`) and adds adapters (`adapter(type)`), pair overrides (`override(source, target, facet)`) and `capabilityMatrix()`.
- `capabilityMatrix()` is the body of `GET /capability-matrix` (API-020): one row per Facet, one cell per ordered pair of distinct adapters, with the worst fidelity the static capabilities prove, `read`/`write`/`override` flags and per-field fidelity. `translated` is never produced because only `translate` can tell it from `exact`.
- Read-time capabilities (`FacetRead.capabilities`, ADP-011) are not in the matrix. The analysis overlays them per repository with `effectiveFieldSupport` and `fieldFidelity` (T-061).

The snapshot `src/__snapshots__/capability-matrix.txt` reflects the adapters' declared capabilities. Where they differ from the mapping tables in `docs/spec/05-facets.md`, see ADR-0261. Update the snapshot with `pnpm exec vitest run --project unit packages/registry -u` and review the diff.

Decisions: ADR-0260, ADR-0261. Dependencies are checked by `pnpm lint` (ARC-012).
