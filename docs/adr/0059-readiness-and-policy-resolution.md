# ADR-0059: Readiness inputs and lossy-policy resolution in `core`

- Status: accepted (no spec change needed)
- Date: 2026-10-08

## Context

LIF-004 defines readiness in prose; FAC-005 and ADP-040 describe how lossy decisions become tasks or Expected Differences, while T-012 owns the engine that calls them.

## Decision

- **Readiness** (`deriveReadiness`): `blocked` if the latest Analysis has any blocker or any run-origin blocker is open; else `needs_attention` if any `pre` task is `open` (any origin); else `ready`. Post tasks never matter. `counts` mirror `Migration.readinessCounts` (`blockers`, open `preTasks`, open `postTasks`, `warnings`), and `blockerCodes` is the sorted unique union. **No Analysis** (never analyzed, or pruned, DOM-004) gives `readiness: null`, except that open run-origin blockers still give `blocked`, so pruning cannot weaken a block. Dismissed run blockers are not passed in (they are removed from `Migration.runBlockers`).
- **Route policies** (`resolveRoutePolicies`): untrusted config is validated; unknown fields and malformed keys are errors. Absent `acceptLossy` takes the spec's default pair of keys; an explicit `[]` is respected; booleans default to `true`. Policy keys are `<facet>.<name>` in kebab case; the facet part must equal the decision's facet.
- **Lossy resolution** (`applyLossyPolicies`): `accepted` is recomputed from the policies; only an existing `'migration'` acceptance survives. Accepted keys give `accepted: 'policy'` and one `lossy_accepted` difference per (facet, path), the first policy key winning on a collision; unaccepted keys give one `<facet>.accept-lossy` task per key (sorted) carrying `params.policyKey` and the sorted unique paths. A lossy decision without a key of its own facet, or with a malformed path, is a facet bug and throws `PolicyError`. Decision paths are canonicalized so a literal `*` can never become a wildcard Expected Difference. `unsupported` and `unreadable` findings are facet-defined (their codes are not known to `core`), reported via `fidelityEffect`.

## Alternatives

- Treat "no Analysis" as `ready` or `blocked` outright: `ready` is unsafe, `blocked` hides never-analyzed Migrations.
- Default `acceptLossy` to `[]` in core: contradicts the spec's stated default (Helm overrides explicitly).

## Affected requirements

LIF-004, LIF-049, FAC-005, ADP-040.
