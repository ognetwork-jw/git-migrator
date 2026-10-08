# Provider: GitHub (`github`)

The target provider for v1. Plan assumed: **GitHub Team**, organization-owned, private repositories. Facts below were verified by task T-031 (2026-10-08) against GitHub's published REST OpenAPI description, GraphQL schema and documentation sources; see [Sources](#sources). Copies of the machine-readable descriptions used by the fakes live in `testing/provider-fakes/specs/` (TST-011).

## Authentication

- A **GitHub App** installed on the target organization (Q62).
  - App ID and installation ID come from config. The private key comes from secretspec `GITHUB_APP_PRIVATE_KEY`.
  - JWT (RS256, 9-minute lifetime) → installation access token (`POST /app/installations/{id}/access_tokens`). Tokens are cached until 5 minutes before expiry.
  - Verified: the JWT must be signed with RS256 and `exp` may be at most 10 minutes ahead; `iat` should be set 60 seconds in the past for clock drift ([S5](#sources)). An installation token expires after 1 hour ([S6](#sources)); the response carries `expires_at`. The 9-minute JWT lifetime and the 5-minute early refresh are within these limits.
- **Git over HTTPS:** username `x-access-token`, password = installation token. Long pushes refresh the token between batches. Verified: requires the Contents permission ([S6](#sources)).

### Required App permissions

| Scope | Permission | Why |
|---|---|---|
| Repository: Administration (`administration`) | Read & write | create/delete repos, settings, branch protection, teams on repos, collaborators |
| Repository: Contents (`contents`) | Read & write | git push, Change Request branches and commits, CODEOWNERS and workflow files |
| Repository: Workflows (`workflows`) | Write (the only level) | pushing `.github/workflows/*` (history may contain them; generated CI) |
| Repository: Pull requests (`pull_requests`) | Read & write | open framework Change Requests |
| Repository: Secrets (`secrets`) | Read & write | read secret names, set secrets in future versions |
| Repository: Variables (`actions_variables`) | Read & write | Actions variables |
| Repository: Environments (`environments`) | Read & write | environment secrets and variables. Creating, updating or deleting an environment itself (`PUT/DELETE .../environments/{name}`, deployment branch policy writes) needs **Administration: write**, not Environments ([S3](#sources)) |
| Repository: Webhooks (`repository_hooks`) | Read & write | repository hooks |
| Repository: Actions (`actions`) | Read | `GET /repos/{o}/{r}/environments` and `GET .../deployment-branch-policies` require it ([S3](#sources)) |
| Repository: Metadata (`metadata`) | Read | mandatory |
| Organization: Members (`members`) | Read & write | members, invitations, teams |
| Organization: Plan (`organization_plan`) | Read | `plan.seats` and `plan.filled_seats` from `GET /orgs/{org}` for the invitation seat preview (seat preview, `08-identity-and-auth.md`). The REST description states that GitHub Apps need the `Organization plan` permission to see plan information ([S1](#sources)); the App-permission schema names it `organization_plan` (`read` only) ([S2](#sources)). **Not** Organization: Administration. |
| Organization: Secrets (`organization_secrets`) / Variables (`organization_actions_variables`) | Read & write | `org-secrets` names, `org-variables` |
| Organization: Webhooks (`organization_hooks`) | Read & write | `org-webhooks` |

The backticked names are the permission keys used in the installation manifest and in the `permissions` object of `POST /app/installations/{id}/access_tokens`. The `app-permissions` schema in the REST description ([S2](#sources)) does **not** list `actions_variables` or `organization_actions_variables` yet; their keys come from the permission data ([S3](#sources)).

**Repository creation (verified).** `POST /orgs/{org}/repos` works for an App installation with Repository **Administration: write** ([S3](#sources); the App-permission description for `administration` is "repository creation, deletion, settings, teams, and collaborators creation" ([S2](#sources))). The published permission data also lists a separate "Repository creation: write" entry for the same endpoint, flagged as requiring additional permissions; it is not yet in the `app-permissions` schema ([S2], [S3]), so the setup guide asks for Administration: write and treats the new permission as optional. The organization's "Repository creation" policy applies to **members and GitHub Apps alike** ([S4](#sources)): the org must allow repository creation, and on GitHub Team the choice is "public and private" or "public only" (private-only restriction is a Cloud feature), so for private repositories the org must have private repository creation enabled. An org owner can always create. Readiness check: `GET /orgs/{org}` exposes `members_can_create_private_repositories` for owners; when the App cannot read it, the first create returns 403/422 and the adapter maps it to a blocking finding with guidance.

**Repository deletion (rollback).** `DELETE /repos/{o}/{r}` needs Administration: write. If an owner has configured the org to prevent members from deleting repositories the API returns 403 ([S1](#sources)); the published text names members only, so whether the policy also blocks Apps is not documented. Per LIF-077, a 403 on delete fails the Run with a guidance finding (the org must allow deletion). Whether the policy also blocks Apps should be confirmed on a staging org (follow-up).

## Rate limits

- **Primary (REST):** read from `x-ratelimit-limit|remaining|used|reset|resource` per installation ([S7](#sources)). Note that the OpenAPI description names the header components `x-rate-limit-*`; the documented and actual response headers are `x-ratelimit-*`, and the fake must emit those. `GET /rate_limit` does not count against the primary limit. The `resources` keys are `core`, `graphql`, `search`, `code_search`, `integration_manifest`, `source_import`, `actions_runner_registration`, `scim`, `dependency_snapshots`, `dependency_sbom`, `code_scanning_autofix`, `copilot_usage_records` ([S1](#sources)).
  - Installation (non-Cloud org, e.g. Team): 5,000 requests per hour minimum; +50 per hour per repository above 20 and +50 per hour per org user above 20; capped at 12,500 per hour. Installations on a GitHub Enterprise Cloud org have 15,000 per hour ([S8](#sources)).
  - Exceeding it returns 403 or 429 with `x-ratelimit-remaining: 0`; wait until `x-ratelimit-reset` ([S7](#sources)).
  - The `x-ratelimit-*` headers, not `GET /rate_limit`, are authoritative when they disagree ([S7](#sources)).
- **Primary (GraphQL):** separate `graphql` resource, points-based: 5,000 points per hour for a non-Cloud installation (+50 per repository above 20, and per org user above 20, capped at 12,500), 10,000 on a Cloud org. Max 500,000 nodes per call. Cost is reported via the `rateLimit { cost remaining resetAt }` field and the same `x-ratelimit-*` headers with `x-ratelimit-resource: graphql` ([S9](#sources)).
- **Secondary:** tracked locally (JOB-045). Verified numbers ([S10](#sources)): at most 100 concurrent requests (REST and GraphQL together); 900 points per minute per REST endpoint and 2,000 per minute for GraphQL (GET/HEAD/OPTIONS = 1 point, POST/PATCH/PUT/DELETE = 5, GraphQL query = 1, GraphQL mutation = 5); 90 s CPU time per 60 s, of which at most 60 s may be GraphQL; content creation at most 80 requests per minute and 500 per hour (some endpoints lower); 2,000 OAuth token requests per hour. Responses are 403 or 429 with a message naming the secondary limit; honor `retry-after`, else if `x-ratelimit-remaining` is 0 wait until `x-ratelimit-reset`, else wait at least 60 s with exponential backoff. `GET /rate_limit` does not count against the primary limit but can count against the secondary limit ([S7](#sources)); there is no way to read secondary limit status. The JOB-045 defaults (10 concurrent, 80/min, 500/h) are within these limits.
- **Org invitations:** at most 50 invitations per 24 h, or 500 per 24 h when the org is more than one month old or on a paid plan; invitations expire after 7 days; a paid per-seat org needs an unused license before inviting ([S11](#sources)).
- **Push and object limits:** blobs over 100 MiB are blocked, warning at 50 MiB ([S12](#sources)); a single push is limited to 2 GiB ([S13](#sources)); the LIF-044 default `git.maxPushBytes` of 1.5 GiB leaves headroom. Git LFS maximum file size depends on the plan: 2 GB Free and Pro, **4 GB Team**, 5 GB Cloud ([S23](#sources)); GitHub Team applies here. The LFS batch API has a separate limit of 3,000 requests per minute authenticated, 100 objects per request by default ([S7](#sources)).

## Namespace model

`organization` (holds repositories). `Route.targetNamespace` = org login.

## Endpoints used

| Purpose | Method & path |
|---|---|
| Org | `GET /orgs/{org}` (plan seats) |
| Members | `GET /orgs/{org}/members`, `GET /orgs/{org}/outside_collaborators`, `GET /orgs/{org}/invitations`, `POST /orgs/{org}/invitations`, `DELETE /orgs/{org}/invitations/{invitation_id}` |
| Users | `GET /users/{login}` (name, public email) |
| Teams | `GET/POST /orgs/{org}/teams`, `GET /orgs/{org}/teams/{slug}`, `PUT /orgs/{org}/teams/{slug}/memberships/{login}`, `GET /orgs/{org}/teams/{slug}/members` |
| Repo create / get / update / delete | `POST /orgs/{org}/repos`, `GET/PATCH/DELETE /repos/{o}/{r}` |
| Collaborators | `GET /repos/{o}/{r}/collaborators?affiliation=direct`, `GET /repos/{o}/{r}/invitations`, `PUT/DELETE /repos/{o}/{r}/collaborators/{login}` |
| Apps | `GET /apps/{app_slug}` (`node_id` for GraphQL push and force-push actors), `GET /app`, `GET /rate_limit` |
| Repo teams | `GET /repos/{o}/{r}/teams`, `PUT/DELETE /orgs/{org}/teams/{slug}/repos/{o}/{r}` |
| Branch protection | `GET /repos/{o}/{r}/branches?protected=true` is insufficient for patterns → GraphQL `repository.branchProtectionRules` for reading pattern rules; REST `PUT /repos/{o}/{r}/branches/{branch}/protection` only accepts existing branch names, so **pattern rules MUST be written via GraphQL `createBranchProtectionRule` / `updateBranchProtectionRule` / `deleteBranchProtectionRule`** (ADR-0014) |
| Deploy keys | `GET/POST/DELETE /repos/{o}/{r}/keys` |
| Environments | `GET /repos/{o}/{r}/environments`, `PUT/DELETE /repos/{o}/{r}/environments/{name}`, deployment branch policies under `/deployment-branch-policies` |
| Variables | `/repos/{o}/{r}/actions/variables`, `/repos/{o}/{r}/environments/{env}/variables`, `/orgs/{org}/actions/variables` |
| Secrets (names) | `/repos/{o}/{r}/actions/secrets`, `/repos/{o}/{r}/environments/{env}/secrets`, `/orgs/{org}/actions/secrets` |
| Webhooks | `/repos/{o}/{r}/hooks`, `/orgs/{org}/hooks` |
| Contents | `GET /repos/{o}/{r}/contents/{path}?ref=` (CODEOWNERS, workflows), Git Data API for Change Request commits (`GET /git/ref/{ref}`, `GET /git/matching-refs/{ref}`, `POST /git/refs`, `GET /git/commits/{sha}`, `POST /git/commits`, `GET /git/trees/{sha}`, `POST /git/trees`, `POST /git/blobs`) |
| Pull requests | `GET/POST/PATCH /repos/{o}/{r}/pulls` |
| Compare | `GET /repos/{o}/{r}/compare/{base}...{head}` (FAC-GIT-006). The OpenAPI path parameter is `basehead`; `status` is one of `diverged`, `ahead`, `behind`, `identical` ([S1](#sources)) |
| LFS | `POST https://github.com/{o}/{r}.git/info/lfs/objects/batch` (`download` existence check) |
| Refs | `git ls-remote --symref` |
| Default branch | `PATCH /repos/{o}/{r}` `{default_branch}` |

## Quirks

- **Branch protection patterns** use Ruby `File.fnmatch` with `File::FNM_PATHNAME`: `*` does not match `/`, so `qa/*` matches `qa/foo` but not `qa/foo/bar`; `qa/**/*` matches any depth ([S14](#sources)). Case sensitivity of patterns is not stated in the published docs (follow-up: confirm empirically; the spec assumes case-sensitive). Rulesets are not used in v1 (ADR-0014).
- **Push `restrictions`** can list users, teams and apps, only on organization-owned repositories; the combined list of users, apps and teams is limited to 100 items; passing new arrays replaces the old ones ([S15](#sources)). Actors must have write access, and people and apps with admin permission can always push ([S16](#sources)). The installation App has Administration permission, so it is never locked out by `restrictsPushes`.
- **Deploy keys** are unique across GitHub: a key already attached to another account or repository is rejected as "Key is already in use" ([S17](#sources)); the create endpoint documents a 422 response ([S1](#sources)). The literal 422 message text (`key is already in use`) is what the adapter matches on; it is not given in the OpenAPI description (follow-up: pin the exact body in the T-042 fake from a staging capture). (FAC-DKY-002)
- **Environment protection** on Team private repositories: environments, environment secrets and variables, and deployment branch policies are available. Required reviewers and wait timers are not: on Free, Pro and Team plans they exist only for public repositories ([S18](#sources)). The `PUT .../environments/{name}` body accepts `reviewers` (up to 6) and `wait_timer` regardless; the adapter must not send them for private repositories on Team.
- **Collaborators:** `PUT /repos/{o}/{r}/collaborators/{login}` for a non-member creates an outside-collaborator invitation (response 201; 204 when the user already has access) and may be restricted by org policy (403) ([S1](#sources)). The adapter refuses (FAC-ACL-002). `affiliation=direct` means all collaborators with permissions to an org-owned repository **regardless of org membership**, so it includes outside collaborators; `outside` and `all` are the other values. Setting a permission below the org base role fails with `Cannot assign {member} permission of {role name}`. Team repository permissions accept `pull|triage|push|maintain|admin` or a custom role name ([S1](#sources)).
- **Workflow files:** pushing history that contains workflow files needs the Workflows permission.
- **Empty repositories:** `POST /repos/{o}/{r}/git/refs` cannot create refs in a repository with no branches, even if the commit exists ([S1](#sources)). Change Requests (LIF-047) therefore need the default branch to exist first.
- **Variable and secret names** may contain only alphanumerics and underscores, must not start with `GITHUB_` or a digit, are case-insensitive when referenced, and are stored upper-case; names are unique per repository, organization or enterprise ([S19](#sources)). This agrees with FAC-VAR-003.
- **Hidden refs:** `refs/pull/*` cannot be pushed. This is long-observed server behavior (`deny updating a hidden ref`) and is not covered by the published documentation; the T-042 fake follows the observed behavior.
- **Git LFS existence check:** the batch API is `POST {remote}/info/lfs/objects/batch` with `operation: "download"`; per-object results return HTTP 200 with an `error.code` of 404 for a missing object ([S20](#sources)).

## Branch protection through GraphQL (FAC-BRR-002)

Verified against the GraphQL schema subset in `testing/provider-fakes/specs/github.graphql` ([S21](#sources)).

| Canonical / REST name | GraphQL field | Notes |
|---|---|---|
| (rule key) | `pattern: String!` | `createBranchProtectionRule(input: {repositoryId, pattern, ...})`; `repositoryId` is the repository `node_id` from REST |
| `required_pull_request_reviews` present | `requiresApprovingReviews` | |
| `required_approving_review_count` | `requiredApprovingReviewCount: Int` | 1 to 6, or 0 for no approvals ([S15](#sources)); the schema has no maximum, the cap of 6 is from REST and the UI |
| `dismiss_stale_reviews` | `dismissesStaleReviews` | |
| `require_code_owner_reviews` | `requiresCodeOwnerReviews` | |
| `required_conversation_resolution` | `requiresConversationResolution` | |
| `required_status_checks` | `requiresStatusChecks`, `requiredStatusChecks: [RequiredStatusCheckInput!]`, `requiredStatusCheckContexts` | `requiresStrictStatusChecks` (the `strict` flag) lives beside them; set `requiresStatusChecks: true` with no contexts when only "up to date" is wanted |
| `restrictions` | `restrictsPushes` + `pushActorIds: [ID!]` | actors are User, Team or App node IDs; read via `pushAllowances { actor { ... on User/Team/App } }` |
| `allow_force_pushes` | `allowsForcePushes` | see force-push note below |
| force-push actors | `bypassForcePushActorIds: [ID!]` (read: `bypassForcePushAllowances`) | exists in the schema; accepts User, Team or App IDs (the spec table's open question is answered: available) |
| `allow_deletions` | `allowsDeletions` | no per-actor exemption exists (confirms `deletionExempt` is not representable) |
| `enforce_admins` | `isAdminEnforced: Boolean!` | |
| `block_creations` | `blocksCreations` | separate from `restrictsPushes` (ADR-0041) |
| PR bypass actors | `bypassPullRequestActorIds` (read: `bypassPullRequestAllowances`) | exists; not used by v1 |

- **Actor IDs are GraphQL node IDs**, not logins. REST objects carry them as `node_id` (users, teams, repositories); an App's node ID comes from `GET /apps/{app_slug}` (or `GET /app` for the framework's own App). Teams and users must have write access first, which the step order guarantees (access-control is step 7, branch-rules step 10 in `06-migration-lifecycle.md`).
- **Force-push semantics (fail closed, ADR-0040).** The GraphQL descriptions say `bypassForcePushActorIds` lists actors "allowed to bypass force push" and `allowsForcePushes` is "Are force pushes allowed on this branch" ([S21](#sources)); the UI text offers "Specify who can force push" under "Allow force pushes" ([S16](#sources)). Secondary evidence: the Terraform GitHub provider documents `allows_force_pushes` as "Set it to false if you specify force_push_bypassers" and forces `AllowsForcePushes=false` when bypassers are non-empty, ignoring bypassers when it is true ([S22](#sources)). The two readings conflict, so the adapter follows the safe one and the spec pairing. Write: `blockForcePush: false` gives `allowsForcePushes: true` with an empty bypass list; `blockForcePush: true` gives `allowsForcePushes: false` plus `bypassForcePushActorIds` (possibly empty). Read: `allowsForcePushes: true` gives `blockForcePush: false` (any bypass list is ignored); `false` gives `blockForcePush: true` with `forcePushExempt` = the bypass actors. A contract or staging check must prove that a non-listed writer's force push is rejected.
- **Reading:** `repository(owner, name) { branchProtectionRules(first: 100) { nodes { ... } pageInfo { hasNextPage endCursor } } }` costs 1 point; mutations cost 5 secondary-limit points ([S10](#sources)).
- **Permissions:** the REST protection endpoints require Administration (read for GET, write for PUT/DELETE) ([S3](#sources)); the permission the GraphQL branch-protection mutations require is not stated in the sources read; Administration: write is inferred and unconfirmed (follow-up: confirm on staging).

## Sources

Retrieved 2026-10-08. `S1` and `S21` are stored in this repository under `testing/provider-fakes/specs/` with commit pins in its README.

| Id | Source |
|---|---|
| S1 | GitHub REST OpenAPI description, [github/rest-api-description](https://github.com/github/rest-api-description/blob/2eba8c3ba02f022011539cf01efc43e0251502f8/descriptions/api.github.com/api.github.com.json) at commit `2eba8c3` (`info.version` 1.1.4, OpenAPI 3.0.3). Operation descriptions, schemas (`organization-full.plan`, `commit-comparison`, `organization-invitation`), and the `rate-limit-overview` resources |
| S2 | Same file, schema `app-permissions` (properties `organization_plan`, `administration`, `organization_administration`, `workflows`, ...) |
| S3 | GitHub App endpoint-to-permission data, [github/docs `src/github-apps/data/fpt-2026-03-10/server-to-server-permissions.json`](https://github.com/github/docs/blob/7b807926df3ccb7f3d1bcd4ad1c652fb42b0931d/src/github-apps/data/fpt-2026-03-10/server-to-server-permissions.json) (rendered at [Permissions required for GitHub Apps](https://docs.github.com/rest/overview/permissions-required-for-github-apps)) |
| S4 | [Restricting repository creation in your organization](https://docs.github.com/organizations/managing-organization-settings/restricting-repository-creation-in-your-organization) |
| S5 | [Generating a JSON Web Token (JWT) for a GitHub App](https://docs.github.com/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app) |
| S6 | [Authenticating as a GitHub App installation](https://docs.github.com/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation) |
| S7 | [Rate limits for the REST API](https://docs.github.com/rest/using-the-rest-api/rate-limits-for-the-rest-api) |
| S8 | Same page, "Primary rate limit for GitHub App installations" |
| S9 | [Rate limits and query limits for the GraphQL API](https://docs.github.com/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api) |
| S10 | Same REST page, "About secondary rate limits" (with the points table) |
| S11 | [Inviting users to join your organization](https://docs.github.com/organizations/managing-membership-in-your-organization/inviting-users-to-join-your-organization) |
| S12 | [About large files on GitHub](https://docs.github.com/repositories/working-with-files/managing-large-files/about-large-files-on-github) |
| S13 | [Troubleshooting the 2 GiB push limit](https://docs.github.com/get-started/using-git/troubleshooting-the-2-gb-push-limit) |
| S14 | [Managing a branch protection rule](https://docs.github.com/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/managing-a-branch-protection-rule) (the `fnmatch` note) |
| S15 | REST `PUT /repos/{owner}/{repo}/branches/{branch}/protection` description and request schema (via S1) |
| S16 | [About protected branches](https://docs.github.com/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches) |
| S17 | [Error: Key already in use](https://docs.github.com/authentication/troubleshooting-ssh/error-key-already-in-use) |
| S18 | [Managing environments for deployment](https://docs.github.com/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments) and [Deployments and environments](https://docs.github.com/actions/reference/workflows-and-actions/deployments-and-environments) ("required reviewers" and "wait timers are only available for public repositories" on Free, Pro and Team plans; deployment branches and tags are available for private repositories on Pro and Team) |
| S19 | Naming rules for secrets and variables ([github/docs reusable](https://github.com/github/docs/blob/main/data/reusables/actions/actions-secrets-and-variables-naming.md)), shown in [Using secrets in GitHub Actions](https://docs.github.com/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions) |
| S20 | [Git LFS batch API](https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md) |
| S21 | GitHub GraphQL schema via [octokit/graphql-schema](https://github.com/octokit/graphql-schema/blob/82ff2d4780080e6929ebb95608cefa22dfa05ac7/schema.graphql) at commit `82ff2d4` (types `BranchProtectionRule`, `CreateBranchProtectionRuleInput`, `UpdateBranchProtectionRuleInput`, `BypassForcePushAllowance`, `PushAllowance`, `BranchActorAllowanceActor`) |
| S22 | Terraform GitHub provider, [integrations/terraform-provider-github](https://github.com/integrations/terraform-provider-github): `github_branch_protection` docs (`allows_force_pushes`, `force_push_bypassers`) and `github/util_v4_branch_protection.go`. Secondary evidence only |
| S23 | [About Git Large File Storage](https://docs.github.com/repositories/working-with-files/managing-large-files/about-git-large-file-storage) (maximum file size per plan) |

`docs.github.com` itself was not reachable from the build environment, so the documentation sources above were read from their Markdown in `github/docs` (rendering differs only in `{% ifversion %}` plan gating, resolved for GitHub.com / Team here).
