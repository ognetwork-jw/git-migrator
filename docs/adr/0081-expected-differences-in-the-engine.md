# ADR-0081: Expected Difference generation and subtraction

- Status: accepted (no spec change needed)
- Date: 2026-10-08

## Context

LIF-060 step 4 says "subtract diffs whose path matches an active Expected Difference", but the LIF-063 table says `lossy_accepted`, `unreadable_defaulted` and `overlay` do **not** mask diffs (`desired` already holds the value). ADP-040 and FAC-MRG-002 name `unreadable_defaulted` without saying which decision produces it, and LIF-006 says a done accept task creates a Migration-scoped `lossy_accepted` record without saying how the next Analysis sees it.

## Decision

- **Subtraction follows the LIF-063 table:** only `framework_mutation`, `identity_excluded` and `manual_accepted` subtract (`MASKING_REASONS`). A diff under a `lossy_accepted`, `unreadable_defaulted` or `overlay` record stays: it means the target was changed after the migration. Revoked records and records of other facets never apply. Masked diffs are returned (with the reason and pattern) so the UI can show them.
- **`unreadable_defaulted`:** a decision with `fidelity: 'unreadable'` and `defaulted: true` means `desired` holds the Route default. The engine drafts an `unreadable_defaulted` record for its path (note = the decision's note) and the facet emits no task. Without `defaulted`, an unreadable decision gets no record; the facet's post task (usually completion `parity`) applies (ADP-040).
- **Caller contract and Migration filter.** The caller passes the Route's records and the Migration's own, plus `migrationId`. A record applies only if active and Route-wide (`migrationId` null) or equal to the call's `migrationId`; other Migrations' records never apply, and without a `migrationId` only Route-wide ones do. Records may carry an `id`, returned with each masked diff (`expectedDifferenceId`) for `ParityResult.excluded`.
- **`framework_mutation` masks target extras only (LIF-063):** a diff is masked only when `desired` is `undefined` (present on the target only). `identity_excluded` and `manual_accepted` mask any diff under their pattern. Masking records are matched in a fixed order (reason precedence framework_mutation, identity_excluded, manual_accepted; then pattern; then id), so credit never depends on input order. Patterns are compiled once per call.
- **Accept task identity (orchestrator decision, review round 1).** Acceptance stays per path: a migration-scoped `lossy_accepted` record covers the paths it names. The `<facet>.accept-lossy` task's params are `{ policyKey, paths }` where `paths` are the sorted paths not yet covered, so a new uncovered path under an already-accepted key yields a new `paramsHash` and therefore a new open task; the old done task becomes obsolete.
- **Fail closed on uncovered decisions.** An `unsupported` decision, or an `unreadable` one without `defaulted`, must have a finding whose path equals, contains or lies beneath its path (or is the root); otherwise the harness throws `uncovered_decision`.
- **Snapshot of the context.** Policies, route, route index and capabilities are deep-frozen copies and `acceptLossy` is read from the snapshot, so a facet cannot self-accept by mutating its context.
- **`lossy_accepted` memory:** a lossy decision is `accepted: 'migration'` when an active, **Migration-scoped** (`migrationId` set) `lossy_accepted` record of the same facet has `note` equal to the decision's policy key and a pattern matching its path. Route-wide records do not count (they are re-derived from the current policies, so removing a policy re-raises the task). When a Route policy also accepts, `policy` wins and the Route record is drafted, so the Route-level audit trail stays complete.
- **Drafts** are deduplicated per (facet, path pattern, reason). Paths are written with `patternForPath`, so a literal `*` never becomes a wildcard.
- `compareFacet` returns `unverifiable` when the target could not be read (`actual === null`), `null` for `compareMode: 'none'` (no ParityResult), sorts diffs by path, rejects duplicate or malformed diff paths. `diffDocuments` is a structural default for facets without special rules; an empty collection/object equals an absent one, `null` does not.
- `satisfiedTasks` implements the LIF-061 pre-step: only tasks whose code has completion `parity` are asked to `isTaskSatisfied`.

## Alternatives

- Mask every reason: would hide real drift on a field that was accepted as lossy.
- Let Route-wide records accept a decision: a removed policy would leave the decision silently accepted.

## Affected requirements

LIF-006, LIF-060, LIF-061, LIF-063, ADP-040, FAC-005, FAC-MRG-002.
