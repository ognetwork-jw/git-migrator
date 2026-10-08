# @git-migrator/registry

Build-time composition of adapters, facets and pair overrides (ADP-032, ARC-010).

- `createBuiltinRegistry()` registers every built-in Facet, both adapters and the pipelines pair override. Composition errors throw `RegistryError` at construction.
- `ProviderRegistry` wraps the core `FacetRegistry` (`registry.facets`) and adds adapters (`adapter(type)`), pair overrides (`override(source, target, facet)`) and `capabilityMatrix()`.
- `capabilityMatrix()` is the body of `GET /capability-matrix` (API-020): one row per Facet, one cell per ordered pair of distinct adapters, with the worst fidelity the static capabilities prove, `read`/`write`/`override` flags and per-field fidelity. `translated` is never produced because only `translate` can tell it from `exact`.
- Read-time capabilities (`FacetRead.capabilities`, ADP-011) are not in the matrix. The analysis overlays them per repository with `effectiveFieldSupport` and `fieldFidelity` (T-061).

The snapshot `src/__snapshots__/capability-matrix.txt` reflects the adapters' declared capabilities. They are aligned to the mapping tables in `docs/spec/05-facets.md`, and `src/builtin.test.ts` checks every table row (ADR-0261). Update the snapshot with `pnpm exec vitest run --project unit packages/registry -u` and review the diff.

`merge-settings` `/allowed` and `/deleteBranchOnMerge` stay dynamic: the reader reports them per repository through `FacetRead.unreadable` / `FacetRead.capabilities` (FAC-MRG-002), so they are not in the static matrix.

Cells are a static worst-case ceiling (`ceiling: 'static'` in the output): they come from declared capabilities only, never say `translated`, and a per-repository analysis can be worse. Do not read `exact` as a guarantee.

Some declared paths are matrix markers rather than schema paths (for example `/secrets/value`, which the canonical `secrets` schema does not have, and `/owners`, `/variables/name`, `/hooks/events`, which stand for a whole concern). They let the matrix show a source that never returns a value or a lossy mapping. `src/builtin.test.ts` pins the source-side markers and ADR-0261 states the rule.

Decisions: ADR-0260, ADR-0261. Dependencies are checked by `pnpm lint` (ARC-012).
