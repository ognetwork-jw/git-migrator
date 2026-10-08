# Provider: Bitbucket Cloud (`bitbucket-cloud`)

The source provider for v1. Plan assumed: **Standard**. Every former **[verify]** item was resolved by task T-030 against Atlassian's published API reference and OpenAPI document (retrieved 2026-10-08, saved at `testing/provider-fakes/specs/bitbucket-cloud.openapi.json`, see its README). No calls were made to `api.bitbucket.org`. Items that the published documents cannot settle are marked **unverified — validate during live e2e** and are recorded in ADR-0036. Spec deviations are in ADR-0035.

Sources: the API reference <https://developer.atlassian.com/cloud/bitbucket/rest/> (intro page: <https://developer.atlassian.com/cloud/bitbucket/rest/intro/>) and the OpenAPI document <https://dac-static.atlassian.com/cloud/bitbucket/swagger.v3.json>. `support.atlassian.com` was not reachable from the build environment.

## Authentication

- **REST:** HTTP Basic, with the Atlassian account email as username and a **user-scoped API token** as password (Q62). App passwords are not supported.
- **Git over HTTPS:** username `x-bitbucket-api-token-auth`, password = API token. **Unverified — validate during live e2e.** The published API reference documents only the literal username `x-token-auth` for *access tokens* (repository, project and workspace tokens; [intro, Repository cloning](https://developer.atlassian.com/cloud/bitbucket/rest/intro/#repository-cloning)). It says API tokens can "interact with Git" ([intro, API tokens](https://developer.atlassian.com/cloud/bitbucket/rest/intro/#api-tokens)) but does not name the Git username; that detail lives on `support.atlassian.com`, which was unreachable. The adapter keeps the username configurable, with `x-bitbucket-api-token-auth` as the default (ADR-0036).
- Multiple credentials are allowed (`BITBUCKET_CREDENTIALS` JSON array). Each entry declares `accountId`, the Atlassian account ID. Rate limits apply per user, so credentials with the same `accountId` share quota (JOB-040).
- **Required API token scopes (verified names):** the scope names below all exist ([intro, Forge app and API token scopes](https://developer.atlassian.com/cloud/bitbucket/rest/intro/#forge-app-and-api-token-scopes)). Scopes do not imply each other (`write:` does not grant `read:`). Per-endpoint scopes come from each operation's `x-atlassian-oauth2-scopes` in the OpenAPI document.
  - `read:workspace:bitbucket`: members.
  - `read:user:bitbucket`: `/user` and user lookups.
  - `read:project:bitbucket`: project list, project permissions-config.
  - `read:repository:bitbucket`: repository, repository permissions-config, workspace repository permissions, effective branching model, `src`, downloads.
  - `admin:repository:bitbucket`: **branch restrictions (even `GET`)**, **repository update (`PUT`; `write:repository:bitbucket` is *not* enough)**, `GET /pipelines_config`, repository deploy keys, branching-model settings, override-settings.
  - `admin:project:bitbucket`: **project deploy keys** (new in this list), project branching-model settings.
  - `read:pullrequest:bitbucket`: pull requests, effective default reviewers.
  - `read:pipeline:bitbucket`: pipeline variables (repository, environment, workspace) and environments.
  - `read:webhook:bitbucket`: repository and workspace webhooks.
  - `read:issue:bitbucket`: issue count (assumed from the scope list; the issue endpoints are absent from the OpenAPI document, so **unverified — validate during live e2e**).

  `write:repository:bitbucket` is therefore not required. The adapter needs `admin:repository:bitbucket` for the description update (LIF-070). The token's account must be a workspace **admin**: inherited permissions and the source read-only step require it.

## Rate limits

User API tokens receive **no rate-limit headers**. The adapter tracks quota locally per JOB-043, using Atlassian's documented limits:

- **Rolling window.** Limits use a one-hour rolling window, and authenticated calls are measured per user ID.
- **Per-category limits:**
  - Repository data under `/2.0/repositories/*`: 1,000–10,000 per hour. The upper end is reached only through scaled limits.
  - Git operations over HTTPS and SSH: 60,000 per hour.
  - Raw file downloads: 5,000 per hour.
  - Webhook listing, adding and removing: 1,000 per hour.
- **Scaled limits do not apply to us.** They require a Standard or Premium plan, at least 100 paid users, *and* workspace, project or repository access tokens (or Forge). User API tokens don't qualify.

Source: the original provider-doc author's research (<https://support.atlassian.com/bitbucket-cloud/docs/api-request-limits/>). `support.atlassian.com` was unreachable during T-030, so these numbers are **unverified — validate during live e2e** (ADR-0036 item 11). The quota limits MUST be configurable (JOB-043 config), with the values above as defaults.

## Namespace model

`workspace` (holds projects) → `project` (holds repositories). `Namespace.key` = project key. Repositories are always in a project.

## Endpoints used

All paths are relative to `https://api.bitbucket.org`. Every list uses `pagelen=100` (the max for most endpoints) and `fields=` to trim payloads where it's supported.

| Purpose | Method & path | Facet / use |
|---|---|---|
| Projects | `GET /2.0/workspaces/{ws}/projects` | inventory |
| Repositories | `GET /2.0/repositories/{ws}?q=project.key="{KEY}"` (or all, then group) | inventory |
| Repository | `GET /2.0/repositories/{ws}/{slug}` | settings, size, `mainbranch`, `updated_on` |
| Repository update | `PUT /2.0/repositories/{ws}/{slug}` (description) | source read-only |
| Members | `GET /2.0/workspaces/{ws}/members` | identities, `members` |
| Groups | `GET /1.0/groups/{ws}` (includes members, default permission) **Not in the published API reference.** The OpenAPI document contains no `/1.0/` paths and no workspace-group list or membership endpoint, so availability is **unverified — validate during live e2e** (ADR-0036). The adapter MUST try it once per workspace and use the fallback on 404/410. Fallback (also the default if the probe fails): group names from repository and project `permissions-config/groups`, with membership unreadable. The `teams` facet then marks `members` `unreadable`, and raises post task `teams.set-membership`. | `teams`, ACL inheritance |
| Repo user / group permissions | `GET /2.0/repositories/{ws}/{slug}/permissions-config/users`, `/groups` | `access-control` |
| Project user / group permissions | `GET /2.0/workspaces/{ws}/projects/{key}/permissions-config/users`, `/groups` | `access-control` |
| Effective per-user permission | `GET /2.0/workspaces/{ws}/permissions/repositories/{slug}` | cross-check in tests |
| Branch restrictions | `GET/POST/DELETE /2.0/repositories/{ws}/{slug}/branch-restrictions` | `branch-rules`, source read-only |
| Project branch restrictions | **Does not exist.** The OpenAPI document has no project-level branch-restriction path. Project-level paths exist only for `branching-model`, `default-reviewers`, `deploy-keys` and `permissions-config`. Read repository restrictions only (FAC-BRR-001 already allows this: "any project-level restrictions the API exposes"). | `branch-rules` |
| Effective branching model | `GET /2.0/repositories/{ws}/{slug}/effective-branching-model` | pattern conversion, warning |
| Effective default reviewers | `GET /2.0/repositories/{ws}/{slug}/effective-default-reviewers` | `code-ownership` |
| Merge strategies / close-branch default | **Allowed strategies and default strategy: readable per branch.** `GET /2.0/repositories/{ws}/{slug}/refs/branches/{mainbranch}` returns `merge_strategies` ("Available merge strategies for pull requests targeting this branch"; enum `merge_commit`, `squash`, `fast_forward`, `squash_fast_forward`, `rebase_fast_forward`, `rebase_merge`) and `default_merge_strategy` (OpenAPI `branch` schema; scope `read:repository:bitbucket`). One extra call per repository. The facet reads the main branch's value as the repository's allowed set. Whether branch-level values reflect repository- or project-level settings is **unverified — validate during live e2e**. **Close-branch default: readable** as `default_branch_deletion` from `GET /2.0/repositories/{ws}/{slug}/branching-model/settings` (scope `admin:repository:bitbucket`), described as "whether branches will be deleted by default on merge". It is absent from the `branching_model_settings` schema and appears only in descriptions and examples, as the **string** `"true"`/`"false"`: the adapter accepts string or boolean, and the fake (T-041) must not schema-validate this field. Project equivalent: `GET /2.0/workspaces/{ws}/projects/{key}/branching-model/settings` (scope `admin:project:bitbucket`). Inheritance of the repository value is unverified (ADR-0036). See ADR-0035. | `merge-settings` |
| Webhooks | `GET /2.0/repositories/{ws}/{slug}/hooks`, `GET /2.0/workspaces/{ws}/hooks` | `webhooks`, `org-webhooks` |
| Access keys | `GET /2.0/repositories/{ws}/{slug}/deploy-keys`, `GET /2.0/workspaces/{ws}/projects/{key}/deploy-keys` | `deploy-keys` |
| Pipelines config | `GET /2.0/repositories/{ws}/{slug}/pipelines_config` | `pipelines.enabled` |
| Repo variables | `GET /2.0/repositories/{ws}/{slug}/pipelines_config/variables` | `variables` / `secrets` |
| Environments | `GET /2.0/repositories/{ws}/{slug}/environments` | `environments` |
| Environment variables | `GET /2.0/repositories/{ws}/{slug}/deployments_config/environments/{envUuid}/variables` | `variables` / `secrets` |
| Workspace variables | `GET /2.0/workspaces/{ws}/pipelines-config/variables` | `org-variables` |
| Pipelines file | `GET /2.0/repositories/{ws}/{slug}/src/{mainbranch}/bitbucket-pipelines.yml` (404 = none) | `pipelines` |
| Open PRs | `GET /2.0/repositories/{ws}/{slug}/pullrequests?state=OPEN&fields=values.id,values.title,values.links.html,next,size` | `change-requests` |
| Issues count | `GET /2.0/repositories/{ws}/{slug}/issues?pagelen=1&fields=size` (only if `has_issues`) | `extras` |
| Downloads count | `GET /2.0/repositories/{ws}/{slug}/downloads?pagelen=1&fields=size` (the 200 response has no schema in the OpenAPI document, and the generic paginated `size` is documented as "an optional element that is not provided in all responses, as it can be expensive to compute", so presence is **unverified — validate during live e2e**; if `size` is absent the adapter records the count as unknown rather than paging through downloads) | `extras` |
| Wiki | `git ls-remote https://bitbucket.org/{ws}/{slug}.git/wiki` (**unverified — validate during live e2e**: the reference only documents `has_wiki` as a repository field; it gives no wiki clone URL. The repository object's `links.clone` is the documented source of clone URLs, and the wiki URL is conventionally the repository URL with `/wiki` appended, which the adapter MUST probe and treat a failure as "wiki unreadable") | `extras` |
| Refs | `git ls-remote --symref https://bitbucket.org/{ws}/{slug}.git` | `git-refs` |

## Quirks

- `size` on a repository is documented only as `integer` with no description ([OpenAPI `repository.size`](https://dac-static.atlassian.com/cloud/bitbucket/swagger.v3.json)). The unit (assumed bytes) and whether it includes LFS are **unverified — validate during live e2e**. Size class (JOB-015) uses it either way.
- **Repository update is also create.** `PUT /2.0/repositories/{ws}/{slug}` "can be used to both update and to create a repository" and accepts the full repository body; changing `name` changes the slug and location ([OpenAPI, Update a repository](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-repositories/#api-repositories-workspace-repo-slug-put)). LIF-070 therefore sends a `PUT` with only `description`, only after a successful `GET` of the same slug in the same step, and never sends `name`. The fake (T-041) mirrors the real API: `PUT` on a missing slug returns 201 and creates the repository. Instead, T-032 MUST include a test asserting the adapter never sends a `PUT` without a prior successful `GET` of the same slug in the same step. After the `PUT`, the adapter `GET`s the repository again and compares `is_private`, `fork_policy`, `project.key`, `name` and `mainbranch` with the pre-`PUT` `GET`. On any difference it restores them and fails the step. Partial-body semantics are unverified (ADR-0036 item 10).
- Issue-tracker endpoints are not in the published OpenAPI document, so the issues-count row above is unverified against it (ADR-0036).
- `GET /pipelines_config` needs `admin:repository:bitbucket`, not `read:pipeline:bitbucket`.
- List endpoints: `pagelen` maximum is 100 and default 10 where documented, but "individual APIs may enforce different values" (OpenAPI `pagelen` description). The adapter reads `next` and never assumes a maximum.
- Bitbucket `*` in branch patterns matches across `/` (canonical `**`, FAC-BRR-003).
- There is no native archive. Source read-only is a `push` restriction on `*` plus a description prefix (LIF-070), and does not cover tags.
- **Merge checks** on Standard are advisory only. Enforcement is Premium (FAC-BRR-001). Verified: the branch-restriction `kind` enum contains both `enforce_merge_checks` and `require_commits_behind` (with `value` = maximum commits behind the destination). The full enum is `push`, `delete`, `force`, `restrict_merges`, `require_tasks_to_be_completed`, `require_approvals_to_merge`, `require_review_group_approvals_to_merge`, `require_default_reviewer_approvals_to_merge`, `require_no_changes_requested`, `require_passing_builds_to_merge`, `require_commits_behind`, `reset_pullrequest_approvals_on_change`, `smart_reset_pullrequest_approvals`, `reset_pullrequest_changes_requested_on_change`, `require_all_dependencies_merged`, `enforce_merge_checks`, `allow_auto_merge_when_builds_pass`, `require_all_comments_resolved`. Rules also carry `branch_match_kind` (`glob` or `branching_model`) and, for the latter, `branch_type`. Whether Standard plans enforce or merely list these kinds is a plan matter the API reference does not state, so it stays **unverified — validate during live e2e**. The facet MUST read `enforce_merge_checks` as the enforcement signal (FAC-BRR-001).
- Repository emails for users are not exposed: the OpenAPI `user` and `account` schemas have no email field, and the only email endpoints are `/user/emails` for the authenticated user (OpenAPI paths `/user/emails`, `/user/emails/{email}`). Optional enrichment comes through the Atlassian Admin API (AUTH-050).
- `fork_policy` values (verified): `allow_forks`, `no_public_forks`, `no_forks`.
- API tokens: Basic auth, username = Atlassian email, password = token; the token cannot be inspected or re-scoped after creation and expires after at most 1 year ([intro, API tokens](https://developer.atlassian.com/cloud/bitbucket/rest/intro/#api-tokens)). Raise a credential-expiry warning in the UI.
- `GET …/src/{commit}/{path}` returns a 301 to Atlassian's media service for LFS-managed files.

## Analysis call budget (estimate)

Per repository 17 REST calls when project data is cached: repository, permissions × 2, restrictions, `effective-branching-model`, `branching-model/settings`, effective default reviewers, hooks, deploy keys, pipelines config, variables, environments, pipelines file, PRs, issues, downloads, main-branch ref (merge strategies). Project permissions × 2 and project deploy keys add up to 3 more when not cached (cached per project per Analysis batch). Each environment adds 1 (its variables). Planning figure: about 20–27 REST calls per repository, plus 2 git ls-remote calls.

A missing or null `repository.mainbranch` (empty repository) makes the merge-settings strategies and the pipelines file `unreadable` and skips those two calls. Branch names in request paths are percent-encoded.

At 1,000 per hour per account, × 0.9 for background, one account analyzes about 40 repositories per hour. **2,000 repositories take about 50 hours with one account, or about 17 hours with three accounts.** T-030 derives the per-repository call count from the adapter's endpoint list. Real measurements happen after handoff (`avgCallsPerAnalysis` adapts automatically, JOB-020).
