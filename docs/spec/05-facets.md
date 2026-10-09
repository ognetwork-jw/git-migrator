# 05 — Facets

This file defines every built-in Facet: its canonical schema, how the Bitbucket Cloud (source) and GitHub (target) adapters map it, its translation fidelity, its parity rule and the findings it can emit. Provider endpoint details are in [providers/bitbucket-cloud](../providers/bitbucket-cloud.md) and [providers/github](../providers/github.md).

Schemas below are written as TypeScript types. Each Facet's Zod schema MUST match them exactly (FAC-001). Every Finding code has guidance content in `packages/guidance` (FAC-002).

**Finding notation:** `B` = blocker, `pre` = pre-run task (makes the Migration NeedsAttention), `post` = post-run task (gates Verified only), `W` = warning, `(v)` = verifiable (parity auto-completes the task).

## Route policies (FAC-005)

```ts
type RoutePolicies = {
  acceptLossy: PolicyKey[];                 // lossy decisions accepted route-wide
  webhookAllowlistEnabled: boolean;         // default true
  identityMatch: { autoConfirmEmail: boolean };   // default true
};
```

Every lossy decision carries a **policy key** (`<facet>.<name>`). Policy keys are a separate namespace from finding codes. A lossy decision whose policy key is in `acceptLossy` produces no task, and is recorded once per Route as an Expected Difference (`lossy_accepted`, note = policy key; deduplicated by Route, facet and path pattern). Unaccepted lossy decisions produce one `<facet>.accept-lossy` pre task per policy key, with `params.policyKey` and the affected paths (completion `accept`, LIF-006). In the tables below, "lossy `x.y`" names the **policy key**.

Default `acceptLossy`: `["branch-rules.advisory-enforced", "environments.category-dropped"]`. The first is Q53 option (a). These defaults are set in Helm values and can be changed per Route.

## Facet index

| Key | Scope | In scope | Depends on |
|---|---|---|---|
| `git-refs` | repository | yes | — |
| `repository-settings` | repository | yes | — |
| `merge-settings` | repository | yes | — |
| `access-control` | repository | yes | endpoint `teams`, `members` |
| `branch-rules` | repository | yes | `git-refs`, `access-control` |
| `webhooks` | repository | yes | — |
| `deploy-keys` | repository | yes | — |
| `variables` | repository | yes | `environments` |
| `secrets` | repository | yes | `environments` |
| `environments` | repository | yes | — |
| `pipelines` | repository | yes | `git-refs`, `variables`, `secrets` |
| `code-ownership` | repository | yes | `access-control` |
| `change-requests` | repository | yes (blocking only) | — |
| `extras` | repository | detect-only | — |
| `members` | endpoint | yes | — |
| `teams` | endpoint | yes | `members` |
| `org-variables` | endpoint | yes | — |
| `org-secrets` | endpoint | yes | — |
| `org-webhooks` | endpoint | yes | — |

`PrincipalRef = { kind: 'identity' | 'group'; id: string }`. Here `id` is the Provider-stable ID. In translated documents, principals refer to target IDs. Lists of principals are stored as `PrincipalEntry = { principal: PrincipalRef }` elements keyed by `principal` (rendered `kind:id` in field paths, e.g. `[principal=identity:42]`), so they are keyed collections (ADP-021, ADR-0085).

**FAC-006 Principal resolution.** Every facet that contains principals resolves each source principal through the Route's mappings:

| Mapping status | Outcome in `desired` | Finding |
|---|---|---|
| `confirmed` (identity), or group with created target team | target principal | — |
| `excluded` | omitted; an `identity_excluded` ED exists (AUTH-050) | — |
| `pending_invite` | omitted | post task `<facet>.pending-invitation` (completion `parity`) |
| `suggested` or `unmapped` | omitted | pre task `<facet>.unmapped-principal` (completion `resolution`), e.g. `access-control.unmapped-principal`, `branch-rules.unmapped-principal` |
| group without a created team | omitted | blocker `<facet>.team-missing`, e.g. `access-control.team-missing`, `code-ownership.team-missing` |

Every decision is recorded at the source principal's path, so mapped and unmapped principals never share a decision path. Group ids compare case-insensitively; identities compare exactly (ADR-0105, ADR-0106).

Only principals that appear in the repository's own documents are resolved. Workspace members referenced nowhere in the repository never affect its readiness.

---

## git-refs (FAC-GIT)

```ts
type GitRefs = {
  defaultBranch: string | null;
  refs: { name: string; kind: 'branch' | 'tag'; target: string; peeled?: string }[]; // key: name
  ignoredRefs: string[];             // full names outside refs/heads/* and refs/tags/*
  lfs: { oids?: string[]; count?: number; bytes?: number };   // filled during runs only
};
```

- **FAC-GIT-001 Read** on both sides with `git ls-remote --symref` (git-operations bucket). Annotated tags record `target` as the tag object SHA and `peeled` as the commit. `defaultBranch` comes from the symref HEAD.
- **FAC-GIT-002 Scope of parity.** `refs/heads/*` and `refs/tags/*`, plus `defaultBranch`. Every other ref goes into `ignoredRefs` and is shown as information.
- **FAC-GIT-003 Fidelity.** Exact.
- **FAC-GIT-004 Large blobs.** During `git.prepare`, every reachable blob larger than the target's `maxBlobBytes` raises blocker `git-refs.blob-too-large` with path and size params, and the Run stops before any target write. Blobs between 50 MiB and 100 MiB raise warning `git-refs.blob-large`. Findings carry `path`, `size`, `oid` and the exceeded `limit`, sorted by size; a path that cannot be represented (it contains a newline) is reported by object id (ADR-0240).
- **FAC-GIT-005 LFS parity.** After pushing, every LFS OID referenced by any ref in the mirror (`git lfs ls-files --all --long`) MUST exist on the target, checked through the LFS batch API `download` operation. Drift checks re-verify LFS only when refs changed. The Parity Check gets the object ids from the Run's own bare source mirror while the Run's scratch exists. Outside a Run it mirrors the source into a per-check scratch directory under the JOB-015 disk precheck and pre-acquired git quota. A short volume makes only this Facet `unverifiable`; it never waits. Missing objects are one diff at `/lfs/oids` (a declared set of `git-refs`, at most 100 ids), so the Facet is `different` and the diff can be accepted. An error from the batch API makes the Facet `unverifiable`, never `equal` (ADR-0395, ADR-0397).
- **FAC-GIT-006 Post-cutover containment.** Once `sourceReadOnlyApplied` is true, git parity relaxes for every Parity Check: drift checks, explicit verify Runs and the checks of resync Runs. Each source ref must exist on the target, and the target ref must equal it or descend from it (GitHub compare API: `identical` or `ahead`). Extra target refs are allowed. This permits normal development after cutover, including merging the framework's Change Requests. The facet's `compare` stays strict; the Parity Check applies containment on top of it (ADR-0100). A differing ref passes when comparing the source tip (base) with the target tip (head) gives `identical` or `ahead`. An annotated tag compares by its peeled commit, and one compare call serves every diff of a ref. A missing ref, `behind`, `diverged`, or a commit the target does not know stays a difference. The default branch is not relaxed. An error from the compare API makes the Facet `unverifiable`. Order: strict diffs, then containment, then the LFS diff, then Expected Differences (ADR-0397).
- **FAC-GIT-007** Refs under `refs/heads/git-migrator/` on the target are framework branches for Change Requests. Config sync (DATA-030 step 5) creates one system Expected Difference per Route: `framework_mutation`, facet `git-refs`, path `/refs[name=refs/heads/git-migrator/*]`.
- **Findings:** `git-refs.blob-too-large` B · `git-refs.blob-large` W · `git-refs.hidden-refs-skipped` W (lists ignored refs) · `git-refs.empty-repository` W (source has no refs; the Migration creates an empty target).

## repository-settings (FAC-SET)

```ts
type RepositorySettings = {
  description: string;            // normalized: trimmed, framework prefix stripped (FAC-SET-003)
  homepage: string | null;
  visibility: 'private' | 'public';
  features: { issues: boolean; wiki: boolean };
  forking: 'allowed' | 'private-only' | 'disallowed';
};
```

| Field | Bitbucket | GitHub | Fidelity |
|---|---|---|---|
| description | `description` | `description` (truncated at 350 chars → lossy, `repository-settings.description-truncated`) | exact |
| homepage | `website` | `homepage` | exact |
| visibility | `is_private` | `private` | exact |
| features.issues / wiki | `has_issues` / `has_wiki` | `has_issues` / `has_wiki` | exact (content not migrated, see `extras`) |
| forking | `fork_policy`: `allow_forks` → allowed, `no_public_forks` → private-only, `no_forks` → disallowed | `allow_forking` | private repo: `private-only` ≡ `allowed` (translated). Public repo with `private-only` or `disallowed`: lossy (`repository-settings.public-fork-policy`; `private-only` maps to `allow_forking: true`). |

- **FAC-SET-001** The target repository name is not part of this Facet. It comes from naming rules (LIF-030), and parity compares it to `Migration.plannedTargetName`.
- **FAC-SET-002** `allow_forking` is only writable when the target organization permits private forking. If it doesn't, the adapter reports `unsupported` and the Facet emits `repository-settings.org-forking-disabled` as a post task.
- **FAC-SET-003** The source description prefix `[MIGRATED → <url>] ` written by LIF-070 is stripped by `normalize`. Because the prefix is stripped before translation, it never reaches `desired` and needs no Expected Difference.
- **Findings:** `repository-settings.accept-lossy` pre · `repository-settings.org-forking-disabled` post.

## merge-settings (FAC-MRG)

```ts
type MergeSettings = {
  allowed: ('merge-commit' | 'squash' | 'rebase' | 'fast-forward-only')[];   // set
  deleteBranchOnMerge: boolean;
};
```

- **FAC-MRG-001 Mapping to GitHub.** `merge-commit` → `allow_merge_commit`, `squash` → `allow_squash_merge`, `rebase` → `allow_rebase_merge`. Bitbucket's rebase variants (`rebase_merge`, `rebase_fast_forward`) map to `rebase`, translated. `fast-forward-only` has no GitHub equivalent and maps to `rebase`, lossy with policy key `merge-settings.ff-only-as-rebase`. `deleteBranchOnMerge` ↔ GitHub `delete_branch_on_merge`.
- **FAC-MRG-002 Bitbucket readability.** Resolved by T-030 (ADR-0035): both values are exposed and MUST be read.
  - `allowed` comes from `merge_strategies` on the repository's main branch (`GET …/refs/branches/{mainbranch}`). The Bitbucket reader maps strategies to canonical values before the facet sees them (`squash` and `squash_fast_forward` → `squash`, `rebase_*` → `rebase`, `fast_forward` → `fast-forward-only`), so `squash_fast_forward` is not lossy (ADR-0101).
  - `deleteBranchOnMerge` comes from `default_branch_deletion` on `GET …/branching-model/settings` (a string `"true"`/`"false"` absent from the schema; accept string or boolean).
  - A field that cannot be read (403, 404, missing field, or no main branch) is `unreadable` on the source. The desired target uses `routes[].defaults.mergeSettings` from config (default: all three GitHub strategies allowed, `deleteBranchOnMerge: true`). The analysis records an `unreadable_defaulted` Expected Difference automatically, with no task.
  - Whether these values reflect project-level inheritance is unverified; the live e2e validates it (ADR-0036).
- **Findings:** `merge-settings.accept-lossy` pre.

## access-control (FAC-ACL)

```ts
type AccessControl = {
  grants: { principal: PrincipalRef; role: 'read' | 'triage' | 'write' | 'maintain' | 'admin' }[]; // key: principal (kind:id)
};
```

- **FAC-ACL-001 Effective explicit grants (Bitbucket).** The union of:
  1. repository user and group permissions (`permissions-config/users|groups`);
  2. the containing project's user and group permissions;
  3. groups whose workspace-level default repository access applies.

  Where a principal appears more than once, it gets the maximum role. Workspace owners and admins are implicit and excluded. Roles map `read`→`read`, `write`→`write`, `admin`→`admin`.
- **FAC-ACL-002 GitHub.** Groups become teams (`PUT /orgs/{org}/teams/{slug}/repos/{owner}/{repo}` with `pull|triage|push|maintain|admin`). Identities become direct collaborators (`PUT /repos/{o}/{r}/collaborators/{login}`), *only* for org members. The adapter MUST NOT create outside-collaborator invitations. On read, GitHub uses `affiliation=direct` collaborators plus repository teams. Org owners and the GitHub App are excluded.
- **FAC-ACL-003 Resolution** follows FAC-006. For access control specifically:
  - **mapped:** the grant is translated.
  - **excluded:** a `identity_excluded` Expected Difference is created, and the grant is omitted.
  - **pending invitation:** post task `access-control.pending-invitation` (v). The grant is applied by a later resync once the invitation is accepted.
  - **unmapped:** pre task `access-control.unmapped-principal`.
- **FAC-ACL-004** A group whose GroupMapping has no created target team blocks with `access-control.team-missing` B until the endpoint Migration creates it (LIF-080). A team is live when its Group's `providerId` is listed on the target, whatever its current slug. A confirmed mapping whose team is gone counts as unmapped, so the blocker returns and the endpoint Plan recreates the team. The blocker is cleared by re-Analysis: when the endpoint Run confirms a mapping, it marks the Route's repository Analyses stale (LIF-081, ADR-0435).
- **Findings:** `access-control.unmapped-principal` pre · `access-control.pending-invitation` post (v) · `access-control.team-missing` B.

## branch-rules (FAC-BRR)

```ts
type BranchRule = {                          // key: pattern
  pattern: string;                           // glob, canonical: '**' crosses '/', '*' does not
  enforcement: 'advisory' | 'enforced';
  restrictPushes: PrincipalEntry[] | null;   // null = unrestricted; [] = nobody; key: principal
  restrictMerges: PrincipalEntry[] | null;
  blockForcePush: boolean;
  forcePushExempt: PrincipalEntry[];
  blockDeletion: boolean;
  deletionExempt: PrincipalEntry[];
  changeRequest: null | {
    minApprovals: number;
    requireCodeOwnerApproval: boolean;       // from "default reviewer approvals"
    dismissStaleApprovals: boolean;
    requireNoChangesRequested: boolean;
    requireTasksResolved: boolean;
    requireUpToDate: boolean;
    minPassingBuilds: number;                // 0 = none
  };
};
type BranchRules = { rules: BranchRule[] };
```

- **FAC-BRR-001 Bitbucket read.** Read the effective branch restrictions: repository restrictions plus any project-level restrictions the API exposes (confirmed in T-030). Group them by pattern.
  - `branch_match_kind: branching_model` restrictions are converted to globs using the effective branching model prefix (for example `feature/**`). That conversion is translated.
  - Restriction kinds map as follows:
    - `push` → `restrictPushes`
    - `restrict_merges` → `restrictMerges`
    - `force` → `blockForcePush` plus exempt users and groups
    - `delete` → `blockDeletion` plus exempt
    - `require_approvals_to_merge` → `minApprovals`
    - `require_default_reviewer_approvals_to_merge` → `requireCodeOwnerApproval`
    - `reset_pullrequest_approvals_on_change` → `dismissStaleApprovals`
    - `require_no_changes_requested` → `requireNoChangesRequested`
    - `require_tasks_to_be_completed` → `requireTasksResolved`
    - `require_commits_behind` → `requireUpToDate`
    - `require_passing_builds_to_merge` → `minPassingBuilds`
  - `enforcement` is `enforced` only if merge checks are enforced for the rule's pattern (Premium: an `enforce_merge_checks` restriction matching the pattern). On Standard every merge-check-derived rule is `advisory` (ADR-0221; to be confirmed by live e2e).
  - Kinds that don't map are reported as warning `branch-rules.unknown-kind`.
- **FAC-BRR-002 GitHub write: classic branch protection rules**, one per pattern. They are read and written through GraphQL (`branchProtectionRules`, `create/update/deleteBranchProtectionRule`), because REST protection endpoints accept only literal branch names. Rulesets are not used in v1 because ruleset bypass lists cannot name individual users (ADR-0014). GraphQL calls use the `graphql` quota resource (JOB-045). In the table below, field names are the REST names; the adapter uses their GraphQL equivalents: `requiresApprovingReviews`, `requiredApprovingReviewCount`, `dismissesStaleReviews`, `requiresCodeOwnerReviews`, `requiresConversationResolution`, `requiresStatusChecks`, `requiresStrictStatusChecks`, `restrictsPushes` + `pushAllowances`, `allowsForcePushes`, `allowsDeletions`, `isAdminEnforced`. When the target refuses a force-push bypass list at write time, the rule is written without it and the Run raises a run-origin post task with guidance (LIF-049, ADR-0380). This is distinct from the policy key, which covers the translation-time decision.

| Canonical | GitHub branch protection | Fidelity |
|---|---|---|
| `enforcement: advisory` | always enforced | lossy, policy `branch-rules.advisory-enforced` (accepted by default) |
| `restrictPushes` | `restrictions.{users,teams}`; `blocksCreations` follows: `true` when `restrictPushes` is non-null (ADR-0041) | translated |
| `restrictMerges` without `restrictPushes` | `restrictions` (merging is a push on GitHub) | lossy `branch-rules.merge-restriction-as-push` |
| `restrictMerges` ≠ `restrictPushes`, both set | `restrictions` = `restrictPushes` | lossy, same key |
| `blockForcePush` / `blockDeletion` | `allow_force_pushes: false` / `allow_deletions: false` | exact |
| non-empty `forcePushExempt` | `allowsForcePushes: false` + `bypassForcePushActorIds` (GraphQL; Users, Teams, Apps). Read: `allowsForcePushes: true` → `blockForcePush: false`, bypass list ignored; `false` → `blockForcePush: true`, exempt = bypass actors (ADR-0040). Fail closed: a contract/staging check MUST prove non-listed writers are rejected | translated (lossy `branch-rules.exemptions-dropped` if unavailable or unresolvable) |
| non-empty `deletionExempt` | not representable | lossy `branch-rules.exemptions-dropped` |
| `minApprovals` 1–6 | `required_approving_review_count` | exact |
| `minApprovals` > 6 | capped at 6 | lossy `branch-rules.approvals-capped` |
| `requireCodeOwnerApproval` | `require_code_owner_reviews` (plus the `code-ownership` Change Request) | translated, depends on `code-ownership` |
| `dismissStaleApprovals` | `dismiss_stale_reviews` | exact |
| `requireNoChangesRequested` with `minApprovals ≥ 1` | implicit in GitHub required reviews | translated |
| `requireNoChangesRequested` with `minApprovals = 0` | `required_approving_review_count: 0` with reviews required | translated |
| `requireTasksResolved` | `required_conversation_resolution` | lossy `branch-rules.tasks-as-conversations` |
| `requireUpToDate` | `required_status_checks.strict` | translated |
| `minPassingBuilds > 0` | named contexts required, unknown before CI exists | unsupported → post `branch-rules.configure-status-checks` (v once contexts exist) |

- **FAC-BRR-003 Pattern conversion.** Canonical globs convert to GitHub fnmatch patterns. GitHub `*` does not cross `/`, and `**` does. Bitbucket `*` crosses `/`, so Bitbucket `*` becomes canonical `**`. A pattern with no lossless conversion produces lossy `branch-rules.pattern-approximated`.
  - The desired rule pattern holds the converted (target-dialect) pattern; the target reader reports patterns verbatim. A trailing `**` segment gets a final `*` segment (`a/**` becomes `a/**/*`) (ADR-0110).
  - Source rules that convert to the same target pattern are merged into their strictest combination (block flags OR-ed, allow lists intersected with `null` as identity, exemptions kept only if every blocking rule exempts, approval and build counts take the maximum), never dropped: lossy `branch-rules.patterns-merged` (ADR-0110).
  - The target applies one rule per branch: an exact name wins, otherwise the oldest wildcard rule. So a rule whose branches are provably covered by another rule has that rule's restrictions folded in (`patterns-merged`), and rules that may select the same branch without a provable cover raise lossy `branch-rules.overlap-unresolved`; so does every wildcard rule folded under another wildcard rule, because a pre-existing older target rule would win. Overlaps are never silent (ADR-0113).
  - Apply order: the target writer creates wildcard rules in the order `branchRuleApplyOrder` (`@git-migrator/canonical`) gives for the desired rules, a deterministic topological order in which every rule precedes the rules that cover it, so the narrower rule is older and wins (ADR-0113).
- **FAC-BRR-004** `enforce_admins` is `false`, which matches Bitbucket, where workspace admins bypass restrictions.
- **Findings:** `branch-rules.accept-lossy` pre (one per unaccepted policy key) · `branch-rules.configure-status-checks` post (v) · `branch-rules.unknown-kind` W · `branch-rules.branching-model` W (informs about prefixes and dev/prod branches that GitHub lacks; raised only when a `branching_model` restriction used the model or a production branch is configured, or the development branch differs from the main branch).

## webhooks (FAC-WEB)

```ts
type Webhook = {                                   // key: key = webhookKey(url) = <origin>#<16 hex of sha256(normalized URL)> (ADR-0088)
  key: string;
  url: string;                                     // may carry credentials in path/query: redact before logging or display (redactWebhookUrl); the one exception is the guidance copy snippet that recreates the hook, which carries the full URL shell-quoted because the user needs it (FAC-WEB-002, ADR-0092)
  events: CanonicalEvent[];                        // sorted set
  active: boolean;
  hasSecret: boolean;                              // secret value is unreadable
  verifyTls: boolean;
};
type Webhooks = { hooks: Webhook[] };
type CanonicalEvent = 'push' | 'cr.opened' | 'cr.updated' | 'cr.merged' | 'cr.declined'
  | 'cr.comment' | 'cr.approved' | 'cr.changes_requested' | 'build.status' | 'repo.updated'
  | 'repo.fork' | 'issue.any';
```

- **FAC-WEB-001 Event mapping** (full table in provider docs):

  | Bitbucket | Canonical | GitHub |
  |---|---|---|
  | `repo:push` | push | `push` |
  | `pullrequest:created` | cr.opened | `pull_request` |
  | `pullrequest:updated` | cr.updated | `pull_request` |
  | `pullrequest:fulfilled` | cr.merged | `pull_request` |
  | `pullrequest:rejected` | cr.declined | `pull_request` |
  | `pullrequest:comment_*` | cr.comment | `pull_request_review_comment` and `issue_comment` |
  | `pullrequest:approved` | cr.approved | `pull_request_review` |
  | `pullrequest:changes_request_created` | cr.changes_requested | `pull_request_review` |
  | `repo:commit_status_*` | build.status | `status` and `check_run` |
  | `repo:updated` | repo.updated | `repository` |
  | `repo:fork` | repo.fork | `fork` |
  | `issue:*` | issue.any | `issues` |

  GitHub events are coarser, so a receiver gets a superset. This is translated. Unmapped source events are lossy `webhooks.event-dropped`.
- **FAC-WEB-002 Payload incompatibility.** Payload formats always differ. A hook is auto-created only if its URL matches a `WebhookAllowlistEntry` pattern for the Route. Matching is structural (ADR-0141): both URL and pattern are parsed; the scheme and port (defaults removed) must be equal; the host matches case-insensitively after IDN conversion, with `*` standing for exactly one label; `*` (within a segment) and `**` (across segments) apply to the parsed path only; query and fragment are ignored; a URL containing `\`, whitespace or control characters never matches, and neither does a pattern or URL longer than 2,048 characters. The path glob is matched in linear time, with no regular expression (ADR-0366). Otherwise, or when none of the hook's events can be received on the target, post task `webhooks.recreate-manually` (v), whose guidance includes the exact target settings. A hook that is not created raises no `webhooks.set-secret`. Hooks that exist only on the target are not parity differences. Webhooks whose URLs normalize to the same key are merged by the reader with warning `webhooks.duplicate-url`.
- **FAC-WEB-003 Secrets.** If `hasSecret`, the hook is created *inactive* and without a secret. git-migrator never generates, stores or displays webhook secrets. Post task `webhooks.set-secret` (v) instructs the human to set a secret on the GitHub hook and the receiver, then activate the hook. The desired `active` is `false` for such a hook; the task params carry the source value as `activateAfterSecret`, and the activate step is shown only when it is true. The task is satisfied when the target hook has `hasSecret: true` and, if `activateAfterSecret`, `active: true`. Parity compares `hasSecret`; `active` compares equal for such a hook because the human sets it (ADR-0141). Task params carry only the hook key and the redacted URL.
- **FAC-WEB-004** Content type is always `json`.
- Non-allowlisted hooks are omitted from `desired` and appear only as the post task, so parity stays equal for them. The task is satisfied when a target hook with the same URL and event set exists.
- **Findings:** `webhooks.recreate-manually` post (v) · `webhooks.set-secret` post (v) · `webhooks.accept-lossy` pre.

## deploy-keys (FAC-DKY)

```ts
type DeployKeys = { keys: { publicKey: string; title: string; readOnly: boolean }[] }; // key: publicKey (type + base64, comment stripped)
```

- **FAC-DKY-001 Bitbucket.** Repository access keys plus the containing project's access keys, flattened (ADR-0011). All are read-only.
- **FAC-DKY-002 GitHub.** `POST /repos/{o}/{r}/keys` with `read_only: true`. GitHub rejects a key already used as a deploy key on another repository, or as a user key. On a `key is already in use` response, the driver skips the key and continues. The step records the run-origin post task `deploy-keys.key-in-use` (v) when a desired key is missing after the apply (ADR-0380). Guidance covers generating per-repository keys or using a machine user.
- **FAC-DKY-003 Pre-detection.** During analysis, a key that appears on more than one source repository on the Route (computed from stored Snapshots) is flagged in advance with the same post task. When an Analysis changes a repository's keys, Migrations whose latest Snapshot holds a changed key are marked stale so the result converges in any order.
- **Findings:** `deploy-keys.key-in-use` post (v).

## environments (FAC-ENV)

```ts
type Environments = { environments: { name: string; category: 'test' | 'staging' | 'production' | null;
  deploymentBranches: string[] | null }[] };   // key: name
```

- Bitbucket deployment environments (`name`, `environment_type`) map to GitHub environments (`PUT /repos/{o}/{r}/environments/{name}`).
- `category` has no GitHub equivalent: lossy `environments.category-dropped`, accepted by default.
- Bitbucket deployment branch restrictions are Premium and therefore `null` on Standard. If present, they map to GitHub custom deployment branch policies (translated).
- Environment names are case-insensitive on the target. Source environments whose names differ only by case are grouped; the first in code-unit order is kept and the others are dropped (`unsupported`) with pre task `environments.name-collision`. Variables and secrets in an `environment:<name>` scope follow the kept spelling (ADR-0145).
- **Findings:** `environments.accept-lossy` pre · `environments.name-collision` pre.

## variables (FAC-VAR) and secrets (FAC-SEC)

```ts
type Variables = { variables: { key: string; scope: string; name: string; value: string }[] };  // key: key = `<scope>/<name>`; scope "repository" | "environment:<name>"; name has no '/' (ADR-0086)
type Secrets   = { secrets:   { key: string; scope: string; name: string }[] };    // key: key = `<scope>/<name>`
```

- **FAC-VAR-001 Bitbucket.** Repository pipeline variables and deployment environment variables. `secured: false` goes to `variables`, `secured: true` goes to `secrets` (value unreadable).
- **FAC-VAR-002 GitHub.** Actions repository variables and environment variables, and repository and environment secrets.
- **FAC-VAR-003 Names.** GitHub names must match `^[A-Z_][A-Z0-9_]*$` and must not start with `GITHUB_`. Lowercase names are upper-cased: lossy `variables.uppercase-names`. Collisions after normalization, or a `GITHUB_` prefix, raise pre task `variables.name-invalid`; the same rules for secret names raise pre task `secrets.name-invalid`. Colliding items are all rejected rather than one being guessed. Secret names are upper-cased by the target itself, so upper-casing a secret name is `translated`, not lossy (ADR-0145).
- **FAC-SEC-001** Secrets are never created with placeholder values. Each missing secret raises post task `secrets.set-value` (v), one per scope. Its params carry `scope`, `names` and `environment`; the guidance renderer supplies the planned target repository and builds a ready-to-run `gh secret set NAME --repo <org>/<repo> [--env <env>]` line per name (ADR-0145). Parity compares names.
- **Findings:** `variables.accept-lossy` pre · `variables.name-invalid` pre · `secrets.name-invalid` pre · `secrets.set-value` post (v).

## pipelines (FAC-PIP)

```ts
type Pipelines = {
  files: { path: string; sha256: string }[];                   // key: path
  enabled: boolean;
  translation: { supported: boolean; unsupported: string[] };  // computed in translate
};
```

- **FAC-PIP-001 Read.** Source: `bitbucket-pipelines.yml` at the default branch head (`/src` API) and `pipelines_config.enabled`. Target: `.github/workflows/*.yml` on the default branch, plus open framework Change Requests.
- **FAC-PIP-002 Translation subset.** The pair override `bitbucket-cloud → github` translates these constructs, and only these. YAML anchors and aliases are resolved first. The file text reaches `translate` only through the read's `attachments` (ADP-011), as the pipelines `sources` of the route index.
  - `image` (global or step): a public image name, optionally with `username`/`password` referencing variables. Becomes `container:` with credentials from secrets.
  - Triggers:
    - `pipelines.default` → `on.push` (all branches) plus `on.pull_request`.
    - `pipelines.branches.<glob>` → `on.push.branches`.
    - `pipelines.tags.<glob>` → `on.push.tags`.
    - `pipelines.custom.<name>` → a separate workflow with `on.workflow_dispatch`.
  - Step fields:
    - `name` → job name.
    - `script` (strings only) → `run:` steps.
    - `after-script` → a step with `if: always()`.
    - `max-time` → `timeout-minutes`.
    - `clone.depth` → `actions/checkout` `fetch-depth` (`full` → 0).
  - `caches`: predefined `node`, `pip`, `maven`, `gradle`, `composer`, `dotnetcore`, `docker` (dropped, since the runner has Docker), plus custom `definitions.caches` with `path` (and `key.files`). Translated to `actions/cache` with key `${{ runner.os }}-<name>-${{ hashFiles(<files or lockfile default>) }}`.
  - `artifacts` (path globs) → `actions/upload-artifact` and `download-artifact` between sequential jobs.
  - Sequential steps → jobs chained by `needs`. A `parallel` group → jobs sharing the previous job as `needs`.
  - `deployment: <env>` → `environment: <env>`.
  - `definitions.services` with `image` and `variables` only, used via `services:` → job `services`. `docker` service → dropped.
  - Bitbucket variables:
    - `BITBUCKET_BRANCH` → `${{ github.ref_name }}` in branch workflows and `${{ github.head_ref || github.ref_name }}` in the default workflow; unset elsewhere (ADR-0161)
    - `BITBUCKET_TAG` → `${{ github.ref_name }}` in tag workflows only; unset elsewhere (ADR-0161)
    - `BITBUCKET_COMMIT` → `${{ github.sha }}`
    - `BITBUCKET_BUILD_NUMBER` → `${{ github.run_number }}`
    - `BITBUCKET_REPO_SLUG` → `${{ github.event.repository.name }}`
    - `BITBUCKET_CLONE_DIR` → `${{ github.workspace }}`; in a container job the run script exports it from `$GITHUB_WORKSPACE` instead (ADR-0161)
    - `BITBUCKET_PR_ID` → `${{ github.event.pull_request.number }}`
    - `BITBUCKET_PR_DESTINATION_BRANCH` → `${{ github.base_ref }}`
    - `BITBUCKET_DEPLOYMENT_ENVIRONMENT` → environment name literal
  - Repository, deployment and workspace variables referenced as `$NAME` → workflow `env:` entries from `vars.NAME` or `secrets.NAME`, according to the `variables` and `secrets` Facets.

  Variables reach scripts only through job `env:` entries, never by text substitution; a script that reads a variable whose trigger leaves it unset is listed as unsupported.

  Safety rules of the generated workflows (ADR-0161, ADR-0162):
  - A step with `trigger: manual` is not generated, and neither is anything after it in that pipeline, so nothing runs that the source would hold for approval. A manual step anywhere inside a stage or parallel group, or in a part of the file that cannot be inspected within the limits, counts the same.
  - No source text is placed inside an expression. Any source string containing `${{` is not copied and is listed as unsupported. Globs, images, environment and cache names must match fixed allow-lists; image credentials must be whole references to known variables or secrets.
  - Every workflow sets read-only `contents` permission, and every action is pinned to a full commit SHA.
  - Inputs and outputs are bounded (aliases, file size, patterns, keys and list entries examined, jobs per workflow and per file, output size). Whatever exceeds a bound is listed as unsupported, never silently dropped.
  - When several branch or tag patterns match the same ref, each workflow excludes its strictly more specific siblings. Overlaps whose specificity cannot be decided, and overlaps where the broader pattern is listed first in the file, are listed as unsupported, because the source's selection rule is unconfirmed (docs/providers).

  Anything else is unsupported, and its YAML path is listed in `translation.unsupported`. Examples: `pipe:`, `trigger: manual`, `condition`, `oidc`, `runs-on`, `size`, `pull-requests:` triggers (Bitbucket filters by source branch, GitHub by base branch), other `BITBUCKET_*` variables, `stages`, and `step.services` with unsupported options.
- **FAC-PIP-003 Delivery.** Always via a target Change Request (LIF-047), never a direct commit.
  - **Fully supported:** generated workflows on branch `git-migrator/ci`; post task `pipelines.review-and-merge` (v once merged).
  - **Partially supported:** the generated workflow carries `# TODO(git-migrator): <path> — <reason>` comments for each unsupported construct, plus the original file as `.github/git-migrator/bitbucket-pipelines.yml`; post task `pipelines.complete-translation` (v once merged).
  - **Pipelines disabled** (`enabled: false`) with a file present: no workflow is generated; warning `pipelines.disabled`.
  - **Nothing generated** with a file present and pipelines enabled (no override for the pair, or nothing translatable): the source file path is listed as unsupported and only `pipelines.complete-translation` is raised; an empty set of generated paths never satisfies a task (ADR-0160).
- **FAC-PIP-004 Parity.** Only `files[].path` is compared: equal when the target default branch contains every generated workflow path. `sha256` is informational, because once merged the human owns the content. `enabled` and `translation` are not compared. Before merge, the facet is `different` and the task is open.
- **Findings:** `pipelines.review-and-merge` post (v) · `pipelines.complete-translation` post (v) · `pipelines.disabled` W.

## code-ownership (FAC-COD)

```ts
type CodeOwnership = { owners: { pattern: string; principals: PrincipalEntry[] }[] };  // key: pattern; principals key: principal
```

- Source: Bitbucket effective default reviewers, which become one entry with pattern `*`. Default reviewers per branch condition don't exist in Bitbucket Cloud.
- Target: `CODEOWNERS` in `.github/` on the default branch.
- Translation emits a `CODEOWNERS` file through a Change Request on branch `git-migrator/codeowners` (LIF-047), with post task `code-ownership.review-and-merge` (v once merged).
- GitHub requires owners to have write access. Principals with less access in `access-control` raise lossy `code-ownership.owner-insufficient-access` (they are omitted). An identity has sufficient access through a direct write grant or through membership of a team (facet `teams`) that holds write. When that membership cannot be known (team document missing, or members skipped without explanation), the owner is kept and warning `code-ownership.team-membership-unknown` is raised (ADR-0106).
- Semantics differ: Bitbucket adds reviewers, while GitHub requests and optionally requires them. The mapping is lossy with policy key `code-ownership.default-reviewers-as-codeowners`.
- **Findings:** `code-ownership.review-and-merge` post (v) · `code-ownership.accept-lossy` pre · `code-ownership.team-membership-unknown` W.

## change-requests (FAC-CRQ)

```ts
type ChangeRequests = { open: { id: string; title: string; url: string }[] };   // key: id
```

- Bitbucket: `pullrequests?state=OPEN` (all pages, title and link only).
- Any open Change Request raises blocker `change-requests.open`, with params listing them. This is re-checked by the Run preflight (LIF-041).
- `compareMode: none`. Target Change Requests opened by the framework are ignored.
- **Findings:** `change-requests.open` B.

## extras — detect-only (FAC-EXT)

```ts
type Extras = { wikiPopulated: boolean; issueCount: number; downloadCount: number; releaseCount: number };
```

- Bitbucket wiki: `git ls-remote <repo>.git/wiki` returns refs. Issues: only if `has_issues`. Downloads: from the downloads API. Releases: 0 (no such concept).
- Each non-zero item raises a warning: `extras.wiki-not-migrated`, `extras.issues-not-migrated`, `extras.downloads-not-migrated`.
- `compareMode: none`. Never blocks (FAC-EXT-001).

---

## Endpoint-level facets (FAC-END)

These run in the endpoint-scope Migration of a Route (LIF-080).

### members

```ts
type Members = { members: { principal: PrincipalRef; role: 'member' | 'admin' }[] };  // key: principal
```

- Source: Bitbucket workspace members (`/workspaces/{ws}/members`), plus workspace permission when readable. Target: GitHub org members plus pending invitations.
- Translation resolves each member through Identity Mappings. Unmapped members with a known email become **invitation candidates**. Members are never added except via approved Invitation Batches (AUTH-060).
- A principal is written as a member only if its resolved target identity is in the Route index's `targetOrgMembers` list (target identities already in the org, filled by Analysis). When the list is absent or invalid, nobody is written (fail closed); everyone else goes the invitation route (ADR-0150).
- Parity ignores members with `identity_excluded` Expected Differences, including deselected invitees (Q59). Members that exist only on the target are not parity differences (ADR-0150).
- **Findings:** `members.review-identity-mapping` pre (any `suggested` or `unmapped`) · `members.approve-invitations` post (any candidates not yet in a sent batch) · `members.pending-acceptance` post (v).

### teams

```ts
type Teams = { teams: { slug: string; name: string; members: PrincipalEntry[] }[] };   // key: slug; members key: principal
```

- Source: Bitbucket groups (1.0 groups API, with members). Target: GitHub teams (`privacy: closed`).
- Team slug = GroupMapping `plannedSlug`, which is the group slug passed through the Route's naming pipeline for teams (default: kebab-case of the group slug). For a mapped group, the slug is the confirmed target Group's live slug from the Route index (`targetSlugs`), not the group principal's id, which is the provider's team id that `access-control` writes. A renamed team therefore plans no duplicate (ADR-0435).
- Membership is applied only for principals that are already org members, as recorded in `targetOrgMembers` (`PUT /orgs/{org}/teams/{slug}/memberships/{login}` would otherwise invite them, which violates AUTH-061). When that list is absent, no membership is applied (fail closed). Excluded, pending and non-member principals are skipped per FAC-006. Team members that exist only on the target are not parity differences (ADR-0150).
- Planned slugs must be lowercase `[a-z0-9-]`; otherwise blocker `teams.slug-invalid`.
- **Findings:** `teams.slug-collision` B · `teams.slug-invalid` B · `teams.set-membership` post (v), only when source membership is unreadable (satisfied by any non-empty target team).

### org-variables, org-secrets, org-webhooks

```ts
type OrgVariables = { variables: { name: string; value: string; visibility: 'all' }[] };  // key: name
type OrgSecrets   = { secrets: { name: string }[] };                                     // key: name (values never read or stored)
type OrgWebhooks  = { hooks: Webhook[] };                                                // key: key (as webhooks)
```

(ADR-0087.)

- Workspace pipeline variables (unsecured) become organization variables with `visibility: all`. Secured ones become organization secret post tasks (`org-secrets.set-value`, v), with the same rules as the repository Facets.
- Workspace webhooks become organization webhooks under the same allowlist, secret, payload, event-drop and parity rules as FAC-WEB, implemented by the same matcher and helpers (ADR-0152).
- Names follow FAC-VAR-003: lossy `org-variables.uppercase-names`; collisions or a reserved prefix raise `org-variables.name-invalid` / `org-secrets.name-invalid` (ADR-0151). Unmapped webhook events are lossy `org-webhooks.event-dropped`.
- **Findings:** `org-variables.name-invalid` pre · `org-variables.accept-lossy` pre · `org-secrets.name-invalid` pre · `org-secrets.set-value` post (v) · `org-webhooks.recreate-manually` post (v) · `org-webhooks.set-secret` post (v) · `org-webhooks.accept-lossy` pre.
