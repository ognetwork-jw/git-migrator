# ADR-0467: Facet drivers revert their own records (`FacetDriver.undo`)

- Status: agent-decided
- Date: 2026-10-09
- Task: T-089
- Affects: ADP-011, ADP-012, LIF-077, LIF-045, FAC-BRR-002, FAC-WEB-003, FAC-ACL-002, FAC-ENV, FAC-VAR-002, FAC-DKY-002, FAC-SET-001, FAC-MRG-001

## Context

The adapter contract (04) has `undo` for the source lock only (`SourceLock.undo`). Rollback of an adopted target (LIF-077: delete created rules, hooks, keys, grants, variables and environments) needs the same for the target's Facets, and the T-033 follow-up said rollback of adopted targets "needs a driver undo or `apply(before)`". `apply` cannot do it: it changes only what differs between a desired and a current document and never deletes target-only items, except branch rules, which it deletes when the desired document lacks them. A `MutationRecord`'s `before`, `after` and `resourceRef` are "sufficient to undo" (ADP-012), but only the adapter knows how.

## Decision

- **`FacetDriver<T>.undo?(ctx, target, record): Promise<void | {left: string}>`** (the return type is amended by Round 2) is optional and reverts ONE record this driver yielded: a `create` is deleted, an `update` is written back to `before`, a `delete` is made again from `before`. It is idempotent (a resource that is already gone, or an update that is already back, is not an error: the record may be an unconfirmed intent, ADR-0342, or a second attempt after a crash) and it touches only the resource the record names. A record of a kind the driver did not yield is refused with `invalid`. The Run engine calls it one record at a time, newest first, and marks each undone after the call (ADR-0465). A Facet whose driver has no `undo` fails the rollback Step `rollback.undo-unsupported`.
- **GitHub drivers implement it** for every Facet that writes: `repository-settings` and `merge-settings` (only the fields the apply changed are written back; `before` holds exactly those), `webhooks` and `org-webhooks` (a created hook is deleted; an update removes only the delivery events the apply added that no remaining canonical event needs, restores `active` and TLS verification, and never touches an event with no canonical name), `deploy-keys`, `environments` (a created one is deleted; an updated one gets its deployment policy and branch policies back, and an environment that is gone is not created again), `variables` and `org-variables`, `access-control` (grants of teams and collaborators; the role of an updated one), `branch-rules` and `teams`. For branch rules a `create` is deleted by id (a rule made again under the pattern since is not ours and stays), and an `update` or a `delete` (the lift of step 3a) are written to the record's own rule only (this replaces the first design, which went through the driver's `apply`; superseded by Round 2). Membership and team records revert newest first (membership, then team). The records of `code-ownership` and Change Requests are not Facet records: the Change Request writer's `close` reverts them.
- **Limits.** `undo` restores what the record holds. A webhook's event list is restored in the provider's own terms (the canonical `before` is a covering set), a rule's bypass list that the provider refused (`exemptionsDropped`) stays as it is, and a variable or key someone changed after the framework wrote it is reverted to the framework's `before`, not to a later value; the ledger is the framework's, not a history of the target.
- **The fake GitHub gains `DELETE /orgs/{org}/teams/{slug}`** (child teams go with the team, as on the real service). The trimmed OpenAPI description carries only `GET` for that path, so the fake's reply to it is not validated against the description; `docs/providers/github.md` lists the endpoint.

## Alternatives

- `apply(before)`: cannot delete what the framework created (see Context).
- One generic reverter in the Run engine from `resourceRef` alone: `resourceRef` is adapter-defined, and the engine must not know provider endpoints (GLO-002, ARC-012).
- A required `undo`: read-only drivers (`git-refs`, `members`, `secrets`, `pipelines`) have nothing to revert.

## Affected requirements

ADP-011, ADP-012, LIF-077, LIF-045, FAC-BRR-002, FAC-WEB-003, FAC-ACL-002, FAC-ENV, FAC-VAR-002, FAC-DKY-002, FAC-SET-001, FAC-MRG-001.

## Round 2 (review findings)

- **`undo` may leave a record.** It returns `void` when the record is reverted (or the resource is already as the record wants), or `{left: reason}` when the resource is no longer provably the one the record names. The Run engine keeps such a record undoable and reports it (ADR-0465).
- **Branch rules: only the record's own rule is written.** An `update` writes `managedInput(before)` to the rule with the record's id, a lifted rule is created again, a `create` is deleted by id; none goes through `apply`, because `managedInput` does not round-trip what the framework does not manage (admin enforcement, creation blocking, status checks) and `apply` would rewrite the other rules. A rule that is gone or replaced is left.
- **Teams are named by provider id.** The team record stores the team's id, the membership record the team's id. The undo finds the team by id in the organization's team list: absent means gone (a hand-made team on the slug is not touched); present under another slug means renamed and is left; a team with child teams is left (deleting it would delete them); only then is it deleted. A record that names no id: superseded by Round 3.
- **Environments restore the real policy.** The record keeps the provider's `deployment_branch_policy` (protected branches, custom or all) in `before` and the branch policy names this apply added in `after.addedBranches`; the undo puts the policy back and removes only those names.
- **Access grants** resolve a collaborator through members and outside collaborators; one that cannot be resolved is left, not counted as reverted (superseded by Round 3).

## Round 3 (review findings)

- **Identity grants resolve through the repository too.** An identity is matched by provider id among the organization's members, its outside collaborators and the repository's direct collaborators (a user who left the organization keeps a direct grant). Nobody by that id means the grant is gone and the record is undone; it is no longer `left`, because nothing an operator could do would ever resolve it.
- **A team or membership record without a provider id** (written before the id was recorded) is looked up by slug: no team holds the slug, the record is undone; a team holds it, the record is `left`, because the team cannot be proven the framework's.
- **One team list per Run.** The organization's team list is read once per driver context (one rollback Step) and forgotten after a team is deleted.

## Round 4 (review findings)

- **What an undo leaves is structured.** `UndoLeft.left` is `{kind, name}` (`UndoLeftEntry`), with the kinds in `UNDO_LEFT_KINDS` (adapter-sdk): `group-unproven`, `group-renamed`, `group-has-children`, `group-changed`, `branch-rule-replaced` and `branch-rule-exists` from the drivers, and `group-in-use`, `group-membership-in-use` and `repository-earlier` from the rollback Step. The name is what an operator finds the resource by: the Group's slug as it is now, the rule's pattern, the repository's name. No sentence is built in code: guidance renders each kind through the message `entry.details.<kind>` of `packages/guidance/src/messages/en.json`, in the glossary's terms (GLO-002), through a new `entries` parameter kind.
- **The team list is not trusted for the delete.** It is still read once per Run to find the team by id, but just before each team DELETE the team itself (`GET /orgs/{org}/teams/{slug}`: the same id and slug) and its child teams (`GET /orgs/{org}/teams/{slug}/teams`: none) are read again. A team that changed meanwhile is left (`group-changed`) and one that gained a child team is left (`group-has-children`); neither counts as undone. The fake GitHub gains the child-team listing; the trimmed OpenAPI description does not carry that path, so its reply is not validated, and `docs/providers/github.md` lists it.

## Round 5 (review findings)

- **Every write to a team reads the team first.** A membership undo and a team access-grant undo read `GET /orgs/{org}/teams/{slug}` just before the write and require the record's team id there; another team on the slug (the team was renamed and another made on its slug since the list was read) leaves the record (`group-changed`) and forgets the cached list. A hand-made team that took the slug keeps its members and grants.
