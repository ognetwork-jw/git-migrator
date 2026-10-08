# ADR-0111: Principal findings of branch-rules

- Status: agent-decided
- Date: 2026-10-08
- Task: T-052
- Affects: FAC-006, FAC-002, FAC-BRR-002, LIF-061

## Context

FAC-006 names the blocker `access-control.team-missing` for a group without a created team, but the registry only accepts finding codes prefixed with the emitting facet's key. The finding params are unspecified, and a `pending_invite` resolution carries no target principal.

## Decision

- branch-rules declares the blocker `branch-rules.team-missing` (guidance added with the same wording as `access-control.team-missing`; the guidance cross-check treats it as a FAC-006 generic code).
- One finding per principal across all rules, with every affected path. Params: `unmapped-principal` and `pending-invitation` use `{ facet: 'branch-rules', principal: '<kind>:<source id>' }`; `team-missing` uses `{ team: '<group id>' }`. The UI may replace ids with display names.
- Principals in lists that are dropped (a merge list that differs from the push list, deletion exemptions, exemptions the target cannot hold) are not resolved, so they raise no findings.
- A push list that ends up empty after omissions stays `[]` ("nobody"), never `null`: fail closed.
- `isTaskSatisfied` for `pending-invitation` returns false: the desired document omits the principal, so parity cannot show the grant, and `PrincipalResolution.pending_invite` has no target principal to look for. The next Analysis, after the invitation is accepted, resolves the principal and the task disappears.
- Write access (ADR-0040): when the translated `access-control` document is in `deps`, a resolved principal needs the role `write`, `maintain` or `admin` there. Exempt actors without it are dropped under lossy `exemptions-dropped`; push-list actors without it are left out, with a note on the `translated` decision (the allowance only narrows, which fails safe). Org owners and the framework App are not grants, so a list naming them loses them; they can always push anyway (ADR-0041). Without usable `access-control` data (facet unsupported or absent) the actors are kept.
- `dependsOn` follows the facet index (`git-refs`, `access-control`). `code-ownership` is deliberately a soft dependency: `requireCodeOwnerApproval` is translated either way and takes effect once the code-ownership Change Request lands a CODEOWNERS file.
- `isTaskSatisfied` for `configure-status-checks` is true when the target rule named by `params.pattern` requires any builds.

## Alternatives

Reuse `access-control.team-missing` from branch-rules: rejected, the registry rejects it.
