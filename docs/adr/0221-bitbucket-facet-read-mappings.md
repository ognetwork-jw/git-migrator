# ADR-0221: Bitbucket Facet read mappings the spec leaves open

- Status: agent-decided
- Date: 2026-10-08
- Task: T-032
- Affects: FAC-ACL-001, FAC-BRR-001, FAC-WEB-001, FAC-DKY-001, FAC-MRG-002, FAC-EXT-001, FAC-VAR-001, FAC-PIP-001, ADP-013

## Decision

- **access-control.** Project permission `create-repo` maps to `write` (it ranks above write and below admin). Workspace owners (permission `owner` from `GET /2.0/workspaces/{ws}/permissions`) are implicit and excluded; if that list cannot be read (403/404) nobody is excluded and warning `access-control.workspace-owners-unknown` is returned. Groups with a workspace default repository permission (from `/1.0/groups`) contribute that role to every repository; without the groups endpoint they contribute nothing.
- **members.** Role `admin` for owners, else `member`; unknown roles give warning `members.roles-unknown`.
- **branch-rules.** Restrictions are grouped by canonical pattern (`*` becomes `**`); several restrictions of one kind on one canonical pattern combine strictest-first (allow lists intersect, counts take the maximum, flags OR). `enforcement` is `enforced` when an `enforce_merge_checks` restriction exists for the pattern or the rule has no merge-check part, else `advisory`. `branching_model` restrictions use the effective model's prefix (`feature/` gives `feature/**`) or the development or production branch name; an unresolvable type is skipped and listed in warning `branch-rules.branching-model`. The adapter emits the declared warning codes `branch-rules.unknown-kind` (per restriction) and `branch-rules.branching-model` (once).
- **webhooks and org-webhooks.** Events outside FAC-WEB-001 are dropped by the reader with warning `webhooks.unmapped-events`; URLs the canonical model rejects (not http(s), credentials) are dropped with `webhooks.invalid-url` (a count, never the URL). Hooks with equal normalized URLs are merged as `mergeDuplicateWebhooks` does, with warning `webhooks.duplicate-url`. The merge is implemented in the adapter because ARC-012 forbids adapters importing `facets`; both follow ADR-0141. `verifyTls` is `!skip_cert_verification`.
- **merge-settings.** A readable but empty strategy set is `unreadable` at `/allowed` (the target would reject "no merge method"); a missing main branch skips the branch call.
- **deploy-keys.** A key on both repository and project appears once; unparsable keys are skipped (warning `deploy-keys.unparsable-skipped`). A 403 on project keys fails the read (the scope is required, provider doc).
- **Failure policy.** Only the reads the spec makes optional (groups endpoint, merge fields, wiki, issue and download counts, workspace owners, pipelines config 404) degrade to `unreadable`. Any other 4xx fails the read with the SDK error so a missing scope is visible.
- **pipelines.** `translation` is `{ supported: true, unsupported: [] }` at read time; `translate` computes it.
- **Shared fetches.** Repository, environments and variables are memoized for 30 s per connection, project data for 10 minutes (the call budget counts it once per batch).
- **teams fallback.** Without the groups endpoint, group names come from project and repository `permissions-config/groups` (all projects, all repositories, uncaptured), with every team's `members` unreadable.

## Alternatives

Importing `facets` into the adapter: forbidden by ARC-012. Treating `create-repo` as `read`: loses a write grant the user can see in the source.
