# ADR-0106: code-ownership facet decisions

- Status: accepted (spec updated)
- Date: 2026-10-08

## Context

FAC-COD says what is lossy and which findings exist, but not: how "less access" is judged, what happens to an owner entry left without owners, which principals resolution outcomes apply to a group lacking a team, where file rendering lives, or the path/params of the findings.

## Decision

- **Lossy keys.** Every entry that keeps at least one principal in `desired` gets a `lossy` decision `code-ownership.default-reviewers-as-codeowners` at `/owners[pattern=...]` (semantics differ: reviewers are added, owners are requested); an entry left empty is not lossy, it is just dropped. An owner is omitted with a `lossy` decision `code-ownership.owner-insufficient-access` at `/owners[pattern=...]/principals[principal=kind:id]` (source principal) when it lacks write access in the translated `access-control` document (`ctx.deps['access-control'].desired`).
- **Access check.** Sufficient means a direct grant of `write` or more, or, for an identity, membership of a team that holds such a grant (membership read from `ctx.deps.teams.desired`, matching the group id to the team slug; hence `dependsOn: ['access-control', 'teams']`). A group owner needs its own grant. If a team grant could cover the owner but the teams document is unavailable, the owner is kept and warning `code-ownership.team-membership-unknown` is emitted (new agent-decided code with guidance; not yet named in the spec, so `spec-crosscheck.test.ts` lists it as an exemption). If the access-control result is absent the check cannot be made and no owner is dropped.
- **Unknown membership.** Because the access-control document can list a team whose membership was skipped or unreadable, the result is `unknown` (owner kept, `code-ownership.team-membership-unknown`) whenever a granting team's desired membership cannot be trusted. It is trusted only when all of these hold: the team is in the teams document; a source team maps to it (found by resolving each source team's slug as a group through `ctx.groups` and picking the one whose mapped target id equals the grant's group id, so a slug renamed by the naming pipeline, e.g. `Dev_Team` to `dev-team`, is still matched); that source team has members; and every source member missing from the desired team is explained by its resolution (`excluded`, `pending_invite`, `unmapped` or `team_missing`). A source member that resolves to `mapped` but whose target is absent from the desired team means membership was skipped, so `unknown`. A source team without members is indistinguishable from unreadable membership and is treated fail-safe (`unknown`), as is a desired team with no mapped source team. A desired team that is empty because every source member resolved away is known. A team that holds the owner wins over any unknown team. Only granting teams whose membership is known and lack the owner give `insufficient`.
- **Principal comparison.** Group ids are compared case-insensitively everywhere in this facet: grant group id against team slug, the direct-grant lookup for a group owner, the mapped source team against the grant, and de-duplication of group owners in `desired`. Identities are compared exactly (identity ids are opaque provider ids). Contract for T-056: the resolved group id must equal the team's planned target slug (ignoring case). Nested teams are not representable in the canonical `teams` document and are not considered.
- **Known limitation.** Workspace owners and admins are implicit and excluded from the grants (FAC-ACL-001), so a default reviewer who is one of them is judged to have no access and is omitted. The spec states the rule without an exception, so it is implemented as written; the lossy acceptance task makes the omission visible.
- **Empty entries.** An entry with no remaining owners is left out of `desired`: in a code-owners file a pattern with no owners removes ownership instead of leaving it unset.
- **FAC-006.** `excluded`: omitted, no finding. `pending_invite`: post `code-ownership.pending-invitation`. `unmapped`: pre `code-ownership.unmapped-principal`. `team_missing`: blocker `code-ownership.team-missing` (params `{ team }`, guidance "create or map the team"), the generic per-facet team code that the orchestrator folds into FAC-006. Params of the other codes as in ADR-0105.
- **Change Request.** When `desired` has owners, a post task `code-ownership.review-and-merge` (paths `['/owners']`, params `{ branch: 'git-migrator/codeowners' }`) is emitted. It is satisfied when the target holds owners and no parity diff lies under `/owners`. Rendering the file and opening the Change Request (LIF-047) belong to the target adapter and the lifecycle, not to this provider-neutral facet.
- `pending-invitation` verification: see ADR-0105.

## Alternatives

- Treat any non-`read` role as sufficient: GitHub requires write for effective code owners (FAC-COD).
- Report a missing team as `unmapped-principal`: wrong remediation (superseded by the generic `<facet>.team-missing`).
- Keep an empty entry: produces a file line that clears ownership.

## Affected requirements

FAC-COD, FAC-005, FAC-006, LIF-047, LIF-061.
