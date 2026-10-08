# Provider: Bitbucket Cloud (`bitbucket-cloud`)

The source provider for v1. Plan assumed: **Standard**. Everything marked **[verify]** MUST be confirmed by task T-030 against Atlassian's API reference and recorded here. If reality differs, T-030 updates this file and the adapter, and records an `agent-decided` ADR when spec behavior changes.

## Authentication

- **REST:** HTTP Basic, with the Atlassian account email as username and a **user-scoped API token** as password (Q62). App passwords are not supported.
- **Git over HTTPS:** username `x-bitbucket-api-token-auth`, password = API token **[verify]**.
- Multiple credentials are allowed (`BITBUCKET_CREDENTIALS` JSON array). Each entry declares `accountId`, the Atlassian account ID. Rate limits apply per user, so credentials with the same `accountId` share quota (JOB-040).
- **Required API token scopes [verify names]:** `read:workspace:bitbucket`, `read:user:bitbucket`, `read:project:bitbucket`, `read:repository:bitbucket`, `write:repository:bitbucket` (description update), `admin:repository:bitbucket` (branch restrictions, permissions read), `read:pullrequest:bitbucket`, `read:pipeline:bitbucket`, `read:webhook:bitbucket`. The token's account must be a workspace **admin**: inherited permissions and the source read-only step require it.

## Rate limits

User API tokens receive **no rate-limit headers**. The adapter tracks quota locally per JOB-043, using Atlassian's documented limits:

- **Rolling window.** Limits use a one-hour rolling window, and authenticated calls are measured per user ID.
- **Per-category limits:**
  - Repository data under `/2.0/repositories/*`: 1,000–10,000 per hour. The upper end is reached only through scaled limits.
  - Git operations over HTTPS and SSH: 60,000 per hour.
  - Raw file downloads: 5,000 per hour.
  - Webhook listing, adding and removing: 1,000 per hour.
- **Scaled limits do not apply to us.** They require a Standard or Premium plan, at least 100 paid users, *and* workspace, project or repository access tokens (or Forge). User API tokens don't qualify.

Source: <https://support.atlassian.com/bitbucket-cloud/docs/api-request-limits/> (fetched 2026-10-08).

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
| Groups | `GET /1.0/groups/{ws}` (includes members, default permission) **[verify still available]**. Fallback if removed: group names from repository and project `permissions-config/groups`, with membership unreadable. The `teams` facet then marks `members` `unreadable`, and raises post task `teams.set-membership`. | `teams`, ACL inheritance |
| Repo user / group permissions | `GET /2.0/repositories/{ws}/{slug}/permissions-config/users`, `/groups` | `access-control` |
| Project user / group permissions | `GET /2.0/workspaces/{ws}/projects/{key}/permissions-config/users`, `/groups` | `access-control` |
| Effective per-user permission | `GET /2.0/workspaces/{ws}/permissions/repositories/{slug}` | cross-check in tests |
| Branch restrictions | `GET/POST/DELETE /2.0/repositories/{ws}/{slug}/branch-restrictions` | `branch-rules`, source read-only |
| Project branch restrictions | **[verify existence and path]** | `branch-rules` |
| Effective branching model | `GET /2.0/repositories/{ws}/{slug}/effective-branching-model` | pattern conversion, warning |
| Effective default reviewers | `GET /2.0/repositories/{ws}/{slug}/effective-default-reviewers` | `code-ownership` |
| Merge strategies / close-branch default | **[verify — FAC-MRG-002]** | `merge-settings` |
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
| Downloads count | `GET /2.0/repositories/{ws}/{slug}/downloads?pagelen=1&fields=size` **[verify `size` presence]** | `extras` |
| Wiki | `git ls-remote https://bitbucket.org/{ws}/{slug}.git/wiki` **[verify URL]** | `extras` |
| Refs | `git ls-remote --symref https://bitbucket.org/{ws}/{slug}.git` | `git-refs` |

## Quirks

- `size` on a repository is in bytes and includes LFS? **[verify]** Size class (JOB-015) uses it either way.
- Bitbucket `*` in branch patterns matches across `/` (canonical `**`, FAC-BRR-003).
- There is no native archive. Source read-only is a `push` restriction on `*` plus a description prefix (LIF-070), and does not cover tags.
- **Merge checks** on Standard are advisory only. Enforcement is Premium (FAC-BRR-001). **[verify]** how the API exposes enforcement (possibly as restriction kind `enforce_merge_checks`), and whether `require_commits_behind` is a real kind.
- Repository emails for users are not exposed. Optional enrichment comes through the Atlassian Admin API (AUTH-050).
- `fork_policy` values: `allow_forks`, `no_public_forks`, `no_forks`.

## Analysis call budget (estimate)

Per repository about 18–25 REST calls (settings, permissions × 2, project permissions × 2 (cached per project per Analysis batch), restrictions, branching model, default reviewers, hooks, deploy keys, project keys (cached), pipelines config, variables, environments (+1 per env), pipelines file, PRs, issues, downloads), plus 2 git ls-remote calls.

At 1,000 per hour per account, × 0.9 for background, one account analyzes about 40 repositories per hour. **2,000 repositories take about 50 hours with one account, or about 17 hours with three accounts.** T-030 derives the per-repository call count from the adapter's endpoint list. Real measurements happen after handoff (`avgCallsPerAnalysis` adapts automatically, JOB-020).
