# ADR-0367: The capability matrix page pivots the matrix, lists non-exact fields per pair, and reads the lossy policies from Route.policies

- Status: accepted (spec updated)
- Date: 2026-10-09
- Task: T-091
- Affects: UI-033, API-020, FAC-005, ADP-040

## Context

UI-033: "Matrix: Facet rows, fidelity per field for each Route's source → target, plus the policies that accept lossy fields". `GET /api/v1/capability-matrix` (T-062) returns rows per Facet with one cell per ordered pair of adapters, and each cell has the per-field list. It does not return the policies. The policies live on each Route (`Route.policies`, FAC-005), which the RPC reads.

## Decision

- Columns are the ordered pairs found in the matrix. Each Facet row shows the cell's fidelity as text and a color, plus read and write flags.
- A field table below lists, for one chosen pair, the fields whose fidelity is not exact, with the Facet, source and target kinds and fidelity. Exact fields are left out, so the table is short.
- The policies section lists, for each Route, the policy keys in `acceptLossy`, read through the RPC (ADR-0360). A lossy field is accepted only when its policy key is listed, as FAC-005 says.
- The matrix is a static ceiling (ADR-0260); the page says so.

## Alternatives

- Add the policies to the matrix response: changes the T-062 contract for one page. Rejected.
- Fidelity as color only: UI-001 requires text as well. Rejected.
