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

`PrincipalRef = { kind: 'identity' | 'group'; id: string }`. Here `id` is the Provider-stable ID. In translated documents, principals refer to target IDs.

**FAC-006 Principal resolution.** Every facet that contains principals resolves each source principal through the Route's mappings:

| Mapping status | Outcome in `desired` | Finding |
|---|---|---|
| `confirmed` (identity), or group with created target team | target principal | — |
| `excluded` | omitted; an `identity_excluded` ED exists (AUTH-050) | — |
| `pending_invite` | omitted | post task `<facet>.pending-invitation` (completion `parity`) |
| `suggested` or `unmapped` | omitted | pre task `<facet>.unmapped-principal` (completion `resolution`), e.g. `access-control.unmapped-principal`, `branch-rules.unmapped-principal` |
| group without a created team | omitted | blocker `access-control.team-missing` |

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
- **FAC-GIT-004 Large blobs.** During `git.prepare`, every reachable blob larger than the target's `maxBlobBytes` raises blocker `git-refs.blob-too-large` with path and size params, and the Run stops before any target write. Blobs between 50 MiB and 100 MiB raise warning `git-refs.blob-large`.
- **FAC-GIT-005 LFS parity.** After pushing, every LFS OID referenced by any ref in the mirror (`git lfs ls-files --all --long`) MUST exist on the target, checked through the LFS batch API `download` operation. Drift checks re-verify LFS only when refs changed.
- **FAC-GIT-006 Post-cutover containment.** Once `sourceReadOnlyApplied` is true, git parity relaxes for drift purposes. Each source ref must exist on the target, and the target ref must equal it or descend from it (GitHub compare API: `identical` or `ahead`). Extra target refs are allowed. This permits normal development after cutover, including merging the framework's Change Requests.
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
| description | `description` | `description` (truncated at 350 chars → lossy) | exact |
| homepage | `website` | `homepage` | exact |
| visibility | `is_private` | `private` | exact |
| features.issues / wiki | `has_issues` / `has_wiki` | `has_issues` / `has_wiki` | exact (content not migrated, see `extras`) |
| forking | `fork_policy`: `allow_forks` → allowed, `no_public_forks` → private-only, `no_forks` → disallowed | `allow_forking` | private repo: `private-only` ≡ `allowed` (translated). Public repo with `private-only`: lossy (`repository-settings.public-fork-policy`, maps to `allow_forking: true`). |

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
  - `allowed` comes from `merge_strategies` on the repository's main branch (`GET …/refs/branches/{mainbranch}`). `squash_fast_forward` is mapped by T-050.
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
- **FAC-ACL-004** A group whose GroupMapping has no created target team blocks with `access-control.team-missing` B until the endpoint Migration creates it (LIF-080).
- **Findings:** `access-control.unmapped-principal` pre · `access-control.pending-invitation` post (v) · `access-control.team-missing` B.

## branch-rules (FAC-BRR)

```ts
type BranchRule = {                          // key: pattern
  pattern: string;                           // glob, canonical: '**' crosses '/', '*' does not
  enforcement: 'advisory' | 'enforced';
  restrictPushes: PrincipalRef[] | null;     // null = unrestricted; [] = nobody
  restrictMerges: PrincipalRef[] | null;
  blockForcePush: boolean;
  forcePushExempt: PrincipalRef[];
  blockDeletion: boolean;
  deletionExempt: PrincipalRef[];
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
  - `enforcement` is `enforced` only if the workspace enforces merge checks (Premium). On Standard every merge-check-derived rule is `advisory`.
  - Kinds that don't map are reported as warning `branch-rules.unknown-kind`.
- **FAC-BRR-002 GitHub write: classic branch protection rules**, one per pattern. They are read and written through GraphQL (`branchProtectionRules`, `create/update/deleteBranchProtectionRule`), because REST protection endpoints accept only literal branch names. Rulesets are not used in v1 because ruleset bypass lists cannot name individual users (ADR-0014). GraphQL calls use the `graphql` quota resource (JOB-045). In the table below, field names are the REST names; the adapter uses their GraphQL equivalents: `requiresApprovingReviews`, `requiredApprovingReviewCount`, `dismissesStaleReviews`, `requiresCodeOwnerReviews`, `requiresConversationResolution`, `requiresStatusChecks`, `requiresStrictStatusChecks`, `restrictsPushes` + `pushAllowances`, `allowsForcePushes`, `allowsDeletions`, `isAdminEnforced`.

| Canonical | GitHub branch protection | Fidelity |
|---|---|---|
| `enforcement: advisory` | always enforced | lossy, policy `branch-rules.advisory-enforced` (accepted by default) |
| `restrictPushes` | `restrictions.{users,teams}` | translated |
| `restrictMerges` without `restrictPushes` | `restrictions` (merging is a push on GitHub) | lossy `branch-rules.merge-restriction-as-push` |
| `restrictMerges` ≠ `restrictPushes`, both set | `restrictions` = `restrictPushes` | lossy, same key |
| `blockForcePush` / `blockDeletion` | `allow_force_pushes: false` / `allow_deletions: false` | exact |
| non-empty `forcePushExempt` | `bypassForcePushAllowances` (GraphQL) **[verify in T-031]** | translated (lossy `branch-rules.exemptions-dropped` if unavailable) |
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
- **FAC-BRR-004** `enforce_admins` is `false`, which matches Bitbucket, where workspace admins bypass restrictions.
- **Findings:** `branch-rules.accept-lossy` pre (one per unaccepted policy key) · `branch-rules.configure-status-checks` post (v) · `branch-rules.unknown-kind` W · `branch-rules.branching-model` W (informs about prefixes and dev/prod branches that GitHub lacks).

## webhooks (FAC-WEB)

```ts
type Webhook = {                                   // key: url
  url: string;
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
- **FAC-WEB-002 Payload incompatibility.** Payload formats always differ. A hook is auto-created only if its URL matches a `WebhookAllowlistEntry` pattern for the Route (glob over the full URL, `*` within a segment, `**` across). Otherwise post task `webhooks.recreate-manually` (v), whose guidance includes the exact target settings.
- **FAC-WEB-003 Secrets.** If `hasSecret`, the hook is created *inactive* and without a secret. git-migrator never generates, stores or displays webhook secrets. Post task `webhooks.set-secret` (v) instructs the human to set a secret on the GitHub hook and the receiver, then activate the hook. It is satisfied when the target hook has `hasSecret: true` and `active: true`. Parity compares `hasSecret` and `active`; for this hook, the desired `active` is the source value only after the task is done, and `false` before that.
- **FAC-WEB-004** Content type is always `json`.
- Non-allowlisted hooks are omitted from `desired` and appear only as the post task, so parity stays equal for them. The task is satisfied when a target hook with the same URL and event set exists.
- **Findings:** `webhooks.recreate-manually` post (v) · `webhooks.set-secret` post (v) · `webhooks.accept-lossy` pre.

## deploy-keys (FAC-DKY)

```ts
type DeployKeys = { keys: { publicKey: string; title: string; readOnly: boolean }[] }; // key: publicKey (type + base64, comment stripped)
```

- **FAC-DKY-001 Bitbucket.** Repository access keys plus the containing project's access keys, flattened (ADR-0011). All are read-only.
- **FAC-DKY-002 GitHub.** `POST /repos/{o}/{r}/keys` with `read_only: true`. GitHub rejects a key already used as a deploy key on another repository, or as a user key. On a `key is already in use` response, the step records post task `deploy-keys.key-in-use` (v) and continues. Guidance covers generating per-repository keys or using a machine user.
- **FAC-DKY-003 Pre-detection.** During analysis, a key that appears on more than one source repository on the Route (computed from stored Snapshots) is flagged in advance with the same post task.
- **Findings:** `deploy-keys.key-in-use` post (v).

## environments (FAC-ENV)

```ts
type Environments = { environments: { name: string; category: 'test' | 'staging' | 'production' | null;
  deploymentBranches: string[] | null }[] };   // key: name
```

- Bitbucket deployment environments (`name`, `environment_type`) map to GitHub environments (`PUT /repos/{o}/{r}/environments/{name}`).
- `category` has no GitHub equivalent: lossy `environments.category-dropped`, accepted by default.
- Bitbucket deployment branch restrictions are Premium and therefore `null` on Standard. If present, they map to GitHub custom deployment branch policies (translated).
- **Findings:** `environments.accept-lossy` pre.

## variables (FAC-VAR) and secrets (FAC-SEC)

```ts
type Variables = { variables: { scope: string; name: string; value: string }[] };  // key: scope+name; scope "repository" | "environment:<name>"
type Secrets   = { secrets:   { scope: string; name: string }[] };                 // key: scope+name
```

- **FAC-VAR-001 Bitbucket.** Repository pipeline variables and deployment environment variables. `secured: false` goes to `variables`, `secured: true` goes to `secrets` (value unreadable).
- **FAC-VAR-002 GitHub.** Actions repository variables and environment variables, and repository and environment secrets.
- **FAC-VAR-003 Names.** GitHub names must match `^[A-Z_][A-Z0-9_]*$` and must not start with `GITHUB_`. Lowercase names are upper-cased: lossy `variables.uppercase-names`. Collisions after normalization, or a `GITHUB_` prefix, raise pre task `variables.name-invalid`.
- **FAC-SEC-001** Secrets are never created with placeholder values. Each missing secret raises post task `secrets.set-value` (v), one per scope. Its params list the names and a ready-to-run `gh secret set NAME --repo <org>/<repo> [--env <env>]` line per name. Parity compares names.
- **Findings:** `variables.accept-lossy` pre · `variables.name-invalid` pre · `secrets.set-value` post (v).

## pipelines (FAC-PIP)

```ts
type Pipelines = {
  files: { path: string; sha256: string }[];                   // key: path
  enabled: boolean;
  translation: { supported: boolean; unsupported: string[] };  // computed in translate
};
```

- **FAC-PIP-001 Read.** Source: `bitbucket-pipelines.yml` at the default branch head (`/src` API) and `pipelines_config.enabled`. Target: `.github/workflows/*.yml` on the default branch, plus open framework Change Requests.
- **FAC-PIP-002 Translation subset.** The pair override `bitbucket-cloud → github` translates these constructs, and only these. YAML anchors and aliases are resolved first.
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
    - `BITBUCKET_BRANCH` → `${{ github.ref_name }}`
    - `BITBUCKET_TAG` → `${{ github.ref_name }}`
    - `BITBUCKET_COMMIT` → `${{ github.sha }}`
    - `BITBUCKET_BUILD_NUMBER` → `${{ github.run_number }}`
    - `BITBUCKET_REPO_SLUG` → `${{ github.event.repository.name }}`
    - `BITBUCKET_CLONE_DIR` → `${{ github.workspace }}`
    - `BITBUCKET_PR_ID` → `${{ github.event.pull_request.number }}`
    - `BITBUCKET_PR_DESTINATION_BRANCH` → `${{ github.base_ref }}`
    - `BITBUCKET_DEPLOYMENT_ENVIRONMENT` → environment name literal
  - Repository, deployment and workspace variables referenced as `$NAME` → workflow `env:` entries from `vars.NAME` or `secrets.NAME`, according to the `variables` and `secrets` Facets.

  Anything else is unsupported, and its YAML path is listed in `translation.unsupported`. Examples: `pipe:`, `trigger: manual`, `condition`, `oidc`, `runs-on`, `size`, `pull-requests:` triggers (Bitbucket filters by source branch, GitHub by base branch), other `BITBUCKET_*` variables, `stages`, and `step.services` with unsupported options.
- **FAC-PIP-003 Delivery.** Always via a target Change Request (LIF-047), never a direct commit.
  - **Fully supported:** generated workflows on branch `git-migrator/ci`; post task `pipelines.review-and-merge` (v once merged).
  - **Partially supported:** the generated workflow carries `# TODO(git-migrator): <path> — <reason>` comments for each unsupported construct, plus the original file as `.github/git-migrator/bitbucket-pipelines.yml`; post task `pipelines.complete-translation` (v once merged).
  - **Pipelines disabled** (`enabled: false`) with a file present: no workflow is generated; warning `pipelines.disabled`.
- **FAC-PIP-004 Parity.** Only `files[].path` is compared: equal when the target default branch contains every generated workflow path. `sha256` is informational, because once merged the human owns the content. `enabled` and `translation` are not compared. Before merge, the facet is `different` and the task is open.
- **Findings:** `pipelines.review-and-merge` post (v) · `pipelines.complete-translation` post (v) · `pipelines.disabled` W.

## code-ownership (FAC-COD)

```ts
type CodeOwnership = { owners: { pattern: string; principals: PrincipalRef[] }[] };  // key: pattern
```

- Source: Bitbucket effective default reviewers, which become one entry with pattern `*`. Default reviewers per branch condition don't exist in Bitbucket Cloud.
- Target: `CODEOWNERS` in `.github/` on the default branch.
- Translation emits a `CODEOWNERS` file through a Change Request on branch `git-migrator/codeowners` (LIF-047), with post task `code-ownership.review-and-merge` (v once merged).
- GitHub requires owners to have write access. Principals with less access in `access-control` raise lossy `code-ownership.owner-insufficient-access` (they are omitted).
- Semantics differ: Bitbucket adds reviewers, while GitHub requests and optionally requires them. The mapping is lossy with policy key `code-ownership.default-reviewers-as-codeowners`.
- **Findings:** `code-ownership.review-and-merge` post (v) · `code-ownership.accept-lossy` pre.

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
- Parity ignores members with `identity_excluded` Expected Differences, including deselected invitees (Q59).
- **Findings:** `members.review-identity-mapping` pre (any `suggested` or `unmapped`) · `members.approve-invitations` post (any candidates not yet in a sent batch) · `members.pending-acceptance` post (v).

### teams

```ts
type Teams = { teams: { slug: string; name: string; members: PrincipalRef[] }[] };   // key: slug
```

- Source: Bitbucket groups (1.0 groups API, with members). Target: GitHub teams (`privacy: closed`).
- Team slug = GroupMapping `plannedSlug`, which is the group slug passed through the Route's naming pipeline for teams (default: kebab-case of the group slug).
- Membership is applied only for principals that are already org members (`PUT /orgs/{org}/teams/{slug}/memberships/{login}` would otherwise invite them, which violates AUTH-061). Excluded, pending and non-member principals are skipped per FAC-006.
- **Findings:** `teams.slug-collision` B · `teams.set-membership` post (v), only when source membership is unreadable.

### org-variables, org-secrets, org-webhooks

- Workspace pipeline variables (unsecured) become organization variables with `visibility: all`. Secured ones become organization secret post tasks (`org-secrets.set-value`, v), with the same rules as the repository Facets.
- Workspace webhooks become organization webhooks under the same allowlist, secret and payload rules as FAC-WEB.
