# ADR-0100: git-refs facet semantics

- Status: agent-decided
- Date: 2026-10-08
- Task: T-050
- Affects: FAC-GIT-001, FAC-GIT-002, FAC-GIT-003, FAC-GIT-004, FAC-GIT-005, FAC-GIT-006, FAC-GIT-007

## Context

05-facets.md defines the git-refs schema and findings but leaves several facet-level details open: how `defaultBranch` is spelled, what `desired` holds for `ignoredRefs` and `lfs`, and which findings `translate` raises versus `git.prepare`.

## Decision

- **`normalize`** moves refs outside `refs/heads/*` and `refs/tags/*` into `ignoredRefs` (FAC-GIT-002), derives `kind` from the ref namespace, keeps `peeled` on tags only, and reduces `defaultBranch` to the short branch name (a symref value `refs/heads/main` becomes `main`), so the two sides compare regardless of how the adapter spells it.
- **`translate`** is the identity on `defaultBranch` and `refs` (a mirror push keeps every SHA). `desired.ignoredRefs` is `[]` and `desired.lfs` is `{}`: neither is migrated through this facet. Warnings: `git-refs.hidden-refs-skipped` (params `refs`, path `/ignoredRefs`) when `ignoredRefs` is non-empty, `git-refs.empty-repository` (path `/refs`) when the source has no branches or tags. No decisions: the facet is exact (FAC-GIT-003).
- **`compare`** diffs only `defaultBranch` and `refs` (FAC-GIT-002). `ignoredRefs` and `lfs` are outside parity here; LFS is verified through the batch API (FAC-GIT-005). Framework branches (`refs/heads/git-migrator/*`) appear as target-only diffs and are masked by the system Expected Difference of FAC-GIT-007, which the engine applies.
- **Blob findings** (`git-refs.blob-too-large`, `git-refs.blob-large`) are declared but raised by `git.prepare` (FAC-GIT-004), not by `translate`, since blob sizes are not part of the canonical document.
- **Post-cutover containment (FAC-GIT-006)** needs the target's compare API (asynchronous I/O) and the `sourceReadOnlyApplied` flag, neither of which `compare(desired, actual, ctx)` receives. The facet's `compare` implements strict parity; the drift check (a T-07x job) applies the containment rule on top. Reported as a follow-up.
- No policy keys, hence no `git-refs.accept-lossy`.

## Alternatives

- Keep `ignoredRefs` in `desired`: rejected, it would make a never-migrated ref look like a difference if anyone compared it.
- A `unsupported` decision for ignored refs: rejected, FAC-GIT-003 says the fidelity is exact and the warning is the specified outcome.
