# ADR-0150: members and teams facets, and the contract with the facets that read them

- Status: accepted (spec updated)
- Date: 2026-10-08
- Task: T-056
- Affects: FAC-END (members, teams), FAC-006, FAC-ACL-004, FAC-COD, AUTH-050, AUTH-060, AUTH-061, LIF-030, LIF-060, LIF-063, FAC-002

## Context

FAC-END describes `members` and `teams` in a few lines. It leaves open: where a team's target slug comes from while the team does not exist yet, how "already an org member" is judged in `translate`, what an unreadable membership does to parity, what the facet knows about invitation candidates, which findings carry which completion mode, whether parity counts target-only members and teams, and what happens when the naming pipeline yields no slug. Siblings read the `teams` result: `access-control` declares `dependsOn: ['members', 'teams']`, and `code-ownership` (T-051, ADR-0106) reads `ctx.deps.teams` (`source` and `desired`).

## Decision

### Contract for facets that read `ctx.deps.teams` (and `ctx.deps.members`)

- A desired team's `slug` equals the group's **resolved target id**, which is the planned slug of the naming pipeline (`routes[].defaults.teamNaming`, LIF-030). The slug is, in order: the target id of the group when the group resolves as `mapped` (a created team); `ctx.routeIndex.plannedSlugs[<source group slug>]` (the GroupMapping `plannedSlug`, a plain `Record<string, string>` the Analysis job fills; absent means none); the Route's `teamNaming` pipeline over the variable `group` (`slug`, `name`); the default pipeline (kebab-case of the group slug). So a team that is created later has exactly the id the group resolver then returns, and a reader that matches slugs case-insensitively (code-ownership) finds it. The source team (`deps.teams.source`) keeps the source group slug.
- **Skipped members are left out of the desired membership**: excluded, pending-invitation, unmapped and non-member principals. Non-member means a resolved target identity that is not in `ctx.routeIndex.targetOrgMembers`, a plain-JSON array of the target identity ids already in the organization (filled by the Analysis job, from the target `members` read). Being in the translated `members` document is **not** enough: that document also holds confirmed principals who are not in the organization yet, and a team write for them would invite them outside an approved batch (AUTH-061). When the list is absent nobody is added (fail closed); a malformed list throws. A team with at least one skipped member has fewer desired members than its source team, which is how a reader tells skipped from missing.
- **`teams.set-membership` is raised only when source membership is unreadable**, i.e. `sourceCaps.fields['/teams/members']` is `unreadable`. Then every team gets an `unreadable` decision at `/teams[slug=<src>]/members`, an empty desired membership, and one post task (params `{ team: <desired slug> }`). Skipped members never raise it.
- `members` desired holds mapped principals that are in `targetOrgMembers` only; `teams` and `members` use only plain-JSON context (ADR-0140): `routeIndex.plannedSlugs`, `routeIndex.invitationCandidates` (below), `route.defaults.teamNaming`, `route.webhookAllowlist`.

### members

- A source member resolves through the Route's identity mappings (FAC-006). `mapped` is translated (target principal, same role) **only if the target identity is in `targetOrgMembers`**; a confirmed principal that is not in the organization yet is never written as a member: it is omitted with an `unsupported` decision and counted as an invitation candidate for `members.approve-invitations` (the invitation route, AUTH-060), not a membership write. Two sources mapped to one target keep the higher role; `excluded` is omitted without a finding; `pending_invite`, `suggested` and `unmapped` are omitted with an `unsupported` decision at the source path. The decision is covered by the finding on the same path. Roles are copied: the canonical role is the vocabulary (the adapter maps the provider's permission into it).
- `members.review-identity-mapping` (pre, completion `resolution`): one task for all suggested or unmapped members (`params.count`, paths of the members). `members.approve-invitations` (post, completion `resolution`): one task for the unmapped members that are **invitation candidates** (`params.count`). `members.pending-acceptance` (post, completion `parity`): one task for the pending members (`params.count`). `resolution` means the task is cleared by changing the mappings or sending a batch, which re-runs the Analysis (LIF-006).
- The facet sees neither emails nor Invitation Batches, so invitation candidates come from `ctx.routeIndex.invitationCandidates`: the source identity ids of unmapped identities with a known email that are not in a sent batch and not deselected (AUTH-060). Absent means none. A malformed list throws. Follow-up for the Analysis job (T-0xx): fill the index.
- **Verifying `pending-acceptance`.** The resolver reports `pending_invite` without the target identity (ADR-0105). The task is satisfied when `params.targetPrincipals` (`kind:id` list) are all target members; `translate` cannot set the param today, so the task stays open until a later Analysis no longer emits it (the mapping is then `confirmed`, and the task is dismissed as obsolete, LIF-020). Follow-up shared with ADR-0105: let `pending_invite` carry the provisional target principal.

### teams

- A team's `name` is the group name. Teams whose planned slugs collide case-insensitively are **all** omitted and raise blocker `teams.slug-collision` (params `{ team, groups }`, one finding per collision, paths of the source teams), because choosing one would be a silent guess. A pipeline that yields no slug (or an empty one) omits the team and raises the new blocker `teams.slug-invalid` (params `{ team: <source slug> }`); the pipeline is the Route's configuration, so the fix is there or in the group mapping. A malformed `teamNaming` or `plannedSlugs` throws (a configuration error, not a finding).
- Member outcomes as in members, with the `targetOrgMembers` gate above. A `plannedSlugs` entry must match the target's slug rules (`^[a-z0-9]+(-[a-z0-9]+)*$`), otherwise the team raises `teams.slug-invalid` (it does not fall back to the pipeline). The unmapped and pending tasks are **one per principal** (paths of every team the principal appears in), because a task is identified by code, facet and params (LIF-020): per-team findings with equal params would collapse. `team_missing` for a member (a nested group) is treated as `unmapped`, so it is never dropped silently; there is no `teams.team-missing` code, since team members are identities.
- Decisions use source paths (the slug can change, and omitted members have no desired path). A changed slug is a `translated` decision at `/teams[slug=<src>]/slug`; a changed member principal is `translated` at the member's source path.
- `teams.set-membership` is satisfied when the target team exists (slug compared case-insensitively) and has at least one member: the expected members are unknown, so this is the strongest check available. Known limitation: a team that was already non-empty on the target satisfies it before the intended members are set. `teams.pending-invitation` follows ADR-0105 (`params.targetPrincipal`).

### Parity of the endpoint facets

- `compare` of `members`, `teams` and the three `org-*` facets reports only leaves present in `desired`: **what exists only on the target is not a difference.** The endpoint is an organization that existed before the migration with its own members, teams, variables, secrets and hooks, and git-migrator never removes any of them (AUTH-061 for people). A missing entry, or a different value on a matched entry, is still a difference. This deliberately narrows the 05-facets sentence that parity ignores members with `identity_excluded` Expected Differences: those EDs still mask a missing-member diff, but a member present on the target and absent from `desired` is never reported at all, ED or not. Consequence: an unreadable source membership (empty desired membership) cannot produce permanent parity noise.

### Guidance

- New code `teams.slug-invalid` (blocker) has guidance and is in `AGENT_DECIDED_CODES` of `spec-crosscheck.test.ts`. The guidance coverage test is `testing/integration/src/facets-members-teams-org-guidance.test.ts` (ARC-012: no facets to guidance dependency; ADR-0103).

## Alternatives

- Resolve the planned slug only through the group resolver: it answers `team_missing` before the team exists, so no slug could be planned.
- Treat any mapped principal as an org member: a team write for a non-member invites them (AUTH-061).
- Compare the full target documents: pre-existing org members and teams would block `verified` forever.
- Make `teams.set-membership` fire for any skipped member: the spec restricts it to unreadable membership, and skipped members already have their own tasks.

## Affected requirements

FAC-END, FAC-006, FAC-ACL-004, FAC-002, AUTH-050, AUTH-060, AUTH-061, LIF-006, LIF-020, LIF-030, LIF-060, LIF-063.
