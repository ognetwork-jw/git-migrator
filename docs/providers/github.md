# Provider: GitHub (`github`)

The target provider for v1. Plan assumed: **GitHub Team**, organization-owned, private repositories. Items marked **[verify]** are confirmed by task T-031.

## Authentication

- A **GitHub App** installed on the target organization (Q62).
  - App ID and installation ID come from config. The private key comes from secretspec `GITHUB_APP_PRIVATE_KEY`.
  - JWT (RS256, 9-minute lifetime) → installation access token (`POST /app/installations/{id}/access_tokens`). Tokens are cached until 5 minutes before expiry.
- **Git over HTTPS:** username `x-access-token`, password = installation token. Long pushes refresh the token between batches.

### Required App permissions

| Scope | Permission | Why |
|---|---|---|
| Repository: Administration | Read & write | create/delete repos, settings, branch protection, teams on repos, collaborators |
| Repository: Contents | Read & write | git push, Change Request branches and commits, CODEOWNERS and workflow files |
| Repository: Workflows | Read & write | pushing `.github/workflows/*` (history may contain them; generated CI) |
| Repository: Pull requests | Read & write | open framework Change Requests |
| Repository: Secrets | Read & write | read secret names, set secrets in future versions |
| Repository: Variables | Read & write | Actions variables |
| Repository: Environments | Read & write | environments, environment variables |
| Repository: Webhooks | Read & write | repository hooks |
| Repository: Metadata | Read | mandatory |
| Organization: Members | Read & write | members, invitations, teams |
| Organization: Administration | Read | plan seat info for invitation preview **[verify]** |
| Organization: Secrets / Variables | Read & write | `org-secrets` names, `org-variables` |
| Organization: Webhooks | Read & write | `org-webhooks` |

The org must also allow members to create private repositories, or the App is granted repository creation through its permission **[verify]**. Rollback of created repos needs repository deletion allowed for the App.

## Rate limits

- **Primary:** read from `x-ratelimit-*` headers per installation.
- **Secondary:** concurrency and content-creation limits, tracked locally (JOB-045).
- **Push and object limits:** blob max 100 MiB, warning at 50 MiB; pushes over 2 GiB are rejected (LIF-044).

## Namespace model

`organization` (holds repositories). `Route.targetNamespace` = org login.

## Endpoints used

| Purpose | Method & path |
|---|---|
| Org | `GET /orgs/{org}` (plan seats) |
| Members | `GET /orgs/{org}/members`, `GET /orgs/{org}/invitations`, `POST /orgs/{org}/invitations` |
| Users | `GET /users/{login}` (name, public email) |
| Teams | `GET/POST /orgs/{org}/teams`, `PUT /orgs/{org}/teams/{slug}/memberships/{login}`, `GET /orgs/{org}/teams/{slug}/members` |
| Repo create / get / update / delete | `POST /orgs/{org}/repos`, `GET/PATCH/DELETE /repos/{o}/{r}` |
| Collaborators | `GET /repos/{o}/{r}/collaborators?affiliation=direct`, `PUT/DELETE /repos/{o}/{r}/collaborators/{login}` |
| Repo teams | `GET /repos/{o}/{r}/teams`, `PUT/DELETE /orgs/{org}/teams/{slug}/repos/{o}/{r}` |
| Branch protection | `GET /repos/{o}/{r}/branches?protected=true` is insufficient for patterns → GraphQL `repository.branchProtectionRules` for reading pattern rules; REST `PUT /repos/{o}/{r}/branches/{branch}/protection` only accepts existing branch names, so **pattern rules MUST be written via GraphQL `createBranchProtectionRule` / `updateBranchProtectionRule` / `deleteBranchProtectionRule`** (ADR-0014) |
| Deploy keys | `GET/POST/DELETE /repos/{o}/{r}/keys` |
| Environments | `GET /repos/{o}/{r}/environments`, `PUT/DELETE /repos/{o}/{r}/environments/{name}`, deployment branch policies under `/deployment-branch-policies` |
| Variables | `/repos/{o}/{r}/actions/variables`, `/repos/{o}/{r}/environments/{env}/variables`, `/orgs/{org}/actions/variables` |
| Secrets (names) | `/repos/{o}/{r}/actions/secrets`, `/repos/{o}/{r}/environments/{env}/secrets`, `/orgs/{org}/actions/secrets` |
| Webhooks | `/repos/{o}/{r}/hooks`, `/orgs/{org}/hooks` |
| Contents | `GET /repos/{o}/{r}/contents/{path}?ref=` (CODEOWNERS, workflows), Git Data API for Change Request commits (`/git/refs`, `/git/trees`, `/git/commits`) |
| Pull requests | `GET/POST/PATCH /repos/{o}/{r}/pulls` |
| Compare | `GET /repos/{o}/{r}/compare/{base}...{head}` (FAC-GIT-006) |
| LFS | `POST https://github.com/{o}/{r}.git/info/lfs/objects/batch` (`download` existence check) |
| Refs | `git ls-remote --symref` |
| Default branch | `PATCH /repos/{o}/{r}` `{default_branch}` |

## Quirks

- **Branch protection patterns** use fnmatch: `*` does not cross `/`, `**` does. Rule patterns are case-sensitive. Rulesets are not used in v1 (ADR-0014).
- **Push `restrictions`** can list users, teams and apps. Users and teams must have write access.
- **Deploy keys** are unique across GitHub. Reusing a key returns 422 "key is already in use" (FAC-DKY-002).
- **Environment protection** on Team private repositories: environments, environment secrets and variables, and deployment branch policies are available. Required reviewers and wait timers are not.
- **Collaborators:** adding a non-member creates an outside-collaborator invitation. The adapter refuses (FAC-ACL-002).
- **Workflow files:** pushing history that contains workflow files needs the Workflows permission.
- **Hidden refs:** `refs/pull/*` cannot be pushed.
