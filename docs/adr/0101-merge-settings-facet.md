# ADR-0101: merge-settings facet semantics

- Status: agent-decided
- Date: 2026-10-08
- Task: T-050
- Affects: FAC-MRG-001, FAC-MRG-002, FAC-005

## Context

FAC-MRG-002 and ADR-0035 leave "the mapping of `squash_fast_forward`" to T-050, and do not say how the facet learns that a field is unreadable or where the Route default lives in `TranslateContext`.

## Decision

- **Facets are provider-neutral (GLO-002), so they see canonical strategies only** (`merge-commit`, `squash`, `rebase`, `fast-forward-only`). The reader in the Bitbucket adapter (T-032) must map the source's strategies: `merge_commit` to `merge-commit`, `squash` and `squash_fast_forward` to `squash`, `rebase_fast_forward` and `rebase_merge` to `rebase`, `fast_forward` to `fast-forward-only`. `squash_fast_forward` is a squash commit followed by a fast-forward, which yields the same linear history as the target's squash merge, so it is **not lossy**: no extra policy key. Follow-up for T-032.
- **Translation:** `fast-forward-only` maps to `rebase` as a `lossy` decision at `/allowed` with policy key `merge-settings.ff-only-as-rebase` (the pre task `merge-settings.accept-lossy` comes from the engine). Duplicates collapse (`fast-forward-only` plus `rebase` gives one `rebase`). The other three strategies and `deleteBranchOnMerge` are exact.
- **Unreadable fields (FAC-MRG-002):** the facet treats a field as unreadable when `ctx.sourceCaps.fields['/allowed']` or `['/deleteBranchOnMerge']` has kind `unreadable`; the source value is then ignored and `desired` takes the Route default, with a decision `{ fidelity: 'unreadable', defaulted: true }` (the engine records `unreadable_defaulted`; no task, no finding).
- **Route default** is read from `ctx.route.defaults.mergeSettings` (the runtime form of `routes[].defaults.mergeSettings`). If absent, the built-in default applies (`merge-commit`, `squash`, `rebase` allowed; `deleteBranchOnMerge: true`). If present but invalid, `translate` throws (the engine reports `translate_failed`) instead of guessing. A default containing `fast-forward-only` is mapped to `rebase` without a task, since the Route owner chose it explicitly.
- An empty `allowed` set is passed through; rejecting a target with no merge method enabled is the adapter's job (no finding code exists for it in the spec).

## Alternatives

- Treat `squash_fast_forward` as lossy `merge-settings.squash-ff-as-squash`: rejected, the resulting history shape is the same, and it would add a policy key to the spec for no user benefit.
- Silently fall back to the built-in default when the Route default is malformed: rejected, it would hide a configuration error.
