# @git-migrator/provider-fakes

Stateful HTTP fakes of the provider APIs plus a git http-backend server (TST-010 … TST-013).

| Fake | Task | Port (DEV-020) | Status |
|---|---|---|---|
| Fake Bitbucket Cloud | T-041 | 4010 | implemented |
| Fake GitHub | T-042 | 4020 | implemented |
| Git http-backend + LFS | T-040 | 4030 | implemented |

```sh
pnpm --filter @git-migrator/provider-fakes start      # all available fakes
FAKE_BITBUCKET_PORT=4010 FAKES_HOST=0.0.0.0 FAKE_GIT_BASE_URL=http://localhost:4030 pnpm --filter @git-migrator/provider-fakes start
```

The servers bind to `127.0.0.1` by default because `/__reset`, `/__config` and `/__state` have no auth. Set `FAKES_HOST=0.0.0.0` only inside the Compose `fakes` container (DEV-020).

Layout: `src/common/` (pagination, `q`/`sort`/`fields`), `src/bitbucket/` (state, serializers, app, rate limiter, fixtures), `src/github/` (the fake GitHub, below), `src/start.ts` (`startFakes` starts the git server and the fake Bitbucket, and the fake GitHub when `githubPort`/`github` is given; `src/main.ts` always does), `specs/` (saved OpenAPI documents). Programmatic use: `createFakeBitbucket(options)` returns `{ app, state, limiter, config, reset }`. `app` is a Hono app (use `app.request()` without a socket), `startFakes()` binds real ports (port `0` = ephemeral).

## Fake Bitbucket Cloud

All paths are under `/2.0` (`/1.0` for groups). Auth: HTTP Basic, email + API token. The default credential is the dummy `operator@test.local` / `fake-bitbucket-api-token`; pass `credentials: [{ email, token, accountId? }]` for others (same `accountId` = shared quota). A bad credential is a `401` with `WWW-Authenticate: Basic`. Errors have the Bitbucket shape `{ "type": "error", "error": { "message" } }`.

Every endpoint of the provider doc's "Endpoints used" table is implemented: workspace projects, members, hooks, pipeline variables; `/1.0/groups/{ws}`; repositories (list with `q`/`sort`, get, `PUT`); repository and project `permissions-config` users and groups; workspace effective permission per repository; branch restrictions (`GET` list with `kind`/`pattern`, `GET` one, `POST`, `DELETE`); effective branching model; effective default reviewers; `refs/branches/{name}` (merge strategies); repository and project `branching-model/settings`; hooks; deploy keys (repository and project); `pipelines_config` and its variables; environments and their variables; `src/{commit}/{path}` (file text, directory listing, 404); open pull requests (`state`); issues (404 when the tracker is off, `size` count); downloads (`size`). `GET /2.0/user` returns the authenticated account.

- **Pagination.** `page`, `pagelen` (default 10, clamped to `maxPagelen`, default 100, configurable via `pageOptions`), `size`, absolute `next`/`previous` links that keep every other query parameter. Webhook lists use the closed envelope (`values`, `pagelen`, `next`) as the schema does.
- **Filtering.** `q` and `sort` apply only on the endpoints whose OpenAPI operation defines them (repository list, effective permissions, `src` listings); other endpoints ignore them. `q` (`=`, `!=`, `~`, `!~`, `<`, `<=`, `>`, `>=`, `AND`, `OR`, `NOT`, parentheses, dotted paths such as `project.key`), `sort` (`-` for descending), `fields` (includes, `-x` removes; `+x` keeps defaults). A bad `q`, an unknown `q`/`sort` field or an invalid pull request `state` (`OPEN`, `MERGED`, `DECLINED`, `SUPERSEDED`) is a 400. A `page` beyond the last page is a 404 (ADR-0060).
- **Quirks mirrored from the provider doc.** `PUT` on a missing slug returns 201 and creates the repository (project from the body, else the first project; empty repository). `PUT` with `putSemantics: 'reset-omitted'` additionally models a partial body resetting `is_private`, `fork_policy`, `project` and `mainbranch` (default `merge` leaves them alone), so adapters can prove their restore logic. **The default test suites run with `merge`; T-032's LIF-070 guard tests (GET before PUT, compare and restore) must run in both modes.** `PUT` slugs must already be slugified (else 400) and a rename onto an existing slug is a 409. A changed `name` changes the slug. `default_branch_deletion` is served as a string (`"true"`/`"false"`). `mainbranch` is `null` for an empty repository. Branch restriction `POST` validates its body (array types, `value` for `require_commits_behind`, `branch_type` for `branching_model`) and rejects a duplicate kind + pattern with 400. Secured variables have no `value`, webhooks expose `secret_set` only. There are no project-level branch restrictions. `GET /1.0/groups/{ws}` can be removed: `groupsEndpoint: 'not-found' | 'gone'` (404/410), set at construction, on `POST /__reset` or on `POST /__config`.
- **Effective permissions** are the maximum of: workspace admin, group default permission, repository/project group grants (through group membership), project and repository user grants. `create-repo` counts as `write`.
- **Not modelled:** per-repository permission checks (membership and scopes are enforced, repository grants are not), LFS 301 redirects from `src`, write endpoints that the adapter does not use (webhook, deploy key and variable creation), issues beyond a count.

### Rate limits

No rate-limit headers are ever sent (also no `Retry-After`). A request over the limit gets `429` with the error body. Resource groups and defaults follow JOB-043, per `accountId` over a rolling window (`windowMs`, default one hour):

| Group | Counted requests | Default / hour |
|---|---|---|
| `repository-data` | `/2.0/repositories/**` and every other `/2.0` or `/1.0` path (`/2.0/user`, workspaces, members, projects, permissions, pipelines-config, `/1.0/groups`, unknown paths) | 1000 |
| `webhooks` | repository and workspace `hooks` (only this group) | 1000 |
| `raw-files` | `src/**` file downloads (also counted in `repository-data`, granted atomically; directory listings are `repository-data` only) | 5000 |
| `app-properties` | `/properties/**` | 2000 |

The `git` group (60,000/h) belongs to the git server of T-040, not to this REST fake. Unauthenticated requests are not counted. A request rejected with 429 records nothing. Configure per test:

```ts
createFakeBitbucket({ limits: { limits: { 'repository-data': 3 }, windowMs: 1000 }, now: fakeClock })
```

```sh
curl -XPOST :4010/__config -d '{"limits":{"repository-data":3,"raw-files":null,"windowMs":1000}}'   # null disables a group
curl -XPOST :4010/__config -d '{"clearUsage":true}'                                             # forget counters, keep limits
curl -XPOST :4010/__reset  -d '{"fixture":"empty","limits":{"repository-data":3}}'
```

### Authorization

- **Scopes.** A credential may carry `scopes` (`credentials: [{ email, token, scopes: ['read:repository:bitbucket'] }]`); without it every scope is granted. Each route requires the scopes of its operation's `x-atlassian-oauth2-scopes` in the saved OpenAPI document (`src/bitbucket/scopes.ts`, cross-checked by a test; issues and the `src` root are assumed, as in the provider doc). Scopes do not imply each other (`write:` or `admin:` does not grant `read:`); when several are listed all are required. Missing scopes give `403` with `{"type":"error","error":{"message":"Your credentials lack one or more required privilege scopes.","detail":{"granted":[…],"required":[…]}}}`. Admin-only endpoints: branch restrictions (even `GET`), repository `PUT`, `pipelines_config`, repository deploy keys and branching-model settings need `admin:repository:bitbucket`; project deploy keys and project branching-model settings need `admin:project:bitbucket`.
- **Workspace access.** An account that is not a member of a workspace gets `403` on every `/2.0/**` and `/1.0/groups` call for it (unknown workspaces stay `404`; `/2.0/user` needs no membership). Fixtures must add the credential accounts: `state.addCredentialMembers('acme')`.

### Control plane (no auth)

- `POST /__reset` body `{ "fixture"?: string, "limits"?, "groupsEndpoint"?, "putSemantics"? }`. Drops all state, usage counters and runtime config back to the constructor options (plus the overrides in the body), then runs the named fixture. `empty` (default, also `""` or no body) leaves only the configured credentials. An unknown name is a 400 listing the known fixtures. Ids and timestamps are deterministic, so two resets give identical worlds.
- `POST /__config` same keys, plus `"clearUsage": true`; applies without resetting state.
- `GET /__state` returns `{ fixture, config, limits, state }`. `state` holds every user, workspace, project, repository and so on as plain JSON. API tokens are redacted.

### Building a world (T-043)

`BitbucketState` has builders that return the created records (`addWorkspace`, `addUser`, `addMember`, `addGroup`, `addProject`, `addRepository`, `addBranch`, `addBranchRestriction`, `addDeployKey`, `addProjectDeployKey`, `addVariable`, `addEnvironment`, `addEnvironmentVariable`, `addWebhook`, `addWorkspaceWebhook`, `addWorkspaceVariable`, `addPullRequest`, `grantRepositoryUser|Group`, `grantProjectUser|Group`). Register fixtures with `createFakeBitbucket({ fixtures: { world: (state) => { … } } })`; they run against freshly reset state on `POST /__reset {"fixture":"world"}`. A builder may be async (the world seeds the git server): `reset()` then returns a promise, resets requested meanwhile queue behind it, and the REST API answers 503 until it settles (ADR-0130). The world itself lives in `testing/fixtures`.

Seam to the git server (T-040): `FakeRepository.gitRoot` is the bare repository path. The REST fake never reads it. It is listed in `/__state`, and `links.clone` points at `gitBaseUrl` (`http://localhost:4030`) as `{gitBaseUrl}/{workspace}/{slug}.git`. Until T-040 lands, `src` is served from the in-memory `FakeRepository.files` (ref independent) and branches carry a deterministic fake hash.

### Validation against Atlassian's OpenAPI

`src/bitbucket/spec-validation.ts` (`validateAgainstSpec(method, pathTemplate, status, body)`) validates a response with `openapi-response-validator` (pinned exactly) against `specs/bitbucket-cloud.openapi.json`. The fake's tests run every endpoint through it. Exemptions are limited to what the provider doc says is not in the schema: `default_branch_deletion` and null `mainbranch` (see ADR-0061). `/downloads` has no response schema and `/issues` is absent from the document, so those two are asserted by hand.

## Fake GitHub

`createFakeGitHub(options)` returns `{ app, state, limiter, config, reset, token }`; `startFakeGitHub({ port, hostname })` binds it (port 4020 by DEV-020, `127.0.0.1` by default, port `0` = ephemeral) and `pnpm --filter @git-migrator/provider-fakes start:github` runs it alone (`FAKE_GITHUB_PORT`, `FAKES_HOST`, `FAKE_GIT_BASE_URL`). `startFakes({ githubPort })` starts it beside the other fakes (`pnpm start` always does). `app` is a Hono app, so tests can use `app.request()` without a socket. Code lives in `src/github/`; GitHub's `Link` pagination is its own (`link.ts`), nothing is shared with `src/common/`.

Every endpoint of the provider doc's "Endpoints used" table is implemented, and so is every operation of the saved `specs/github.openapi.json` (a test checks both lists against the registered routes): organization, members, outside collaborators, invitations (create/list/delete), users, teams (create/list/get, memberships, members, repository access), repositories (create, get, update, delete), collaborators and repository invitations, deploy keys, branches and REST branch protection, environments with deployment branch policies, variables and secret names for repositories, environments and organizations (incl. selected repositories), repository and organization webhooks, contents, the Git Data API (refs, matching refs, commits, trees, blobs), pull requests, compare, `GET /app`, `/apps/{slug}`, installations, `GET /rate_limit`, the GraphQL branch-protection subset and the LFS batch API. Errors have GitHub's shape (`message`, `documentation_url`, `status`, and `errors[]` on 422).

- **Authentication.** `POST /app/installations/{id}/access_tokens` takes an App JWT (`fakeAppJwt({ appId })` builds one). The structure is checked as in the provider doc: three base64url segments, `alg` RS256, `iss` = App id or client id, integer `iat` not in the future and `exp` in the future and at most 10 minutes ahead; any signature is accepted unless `appPublicKeyPem` is given. The token (`ghs_…`, 1 hour, `expires_at`) can be narrowed with `permissions` (subset of the installation) and `repositories`/`repository_ids`. `Authorization: Bearer|token <token>` and Basic with the token as password (git, LFS) are accepted. Installation tokens are checked per endpoint against the permission table of the provider doc (`403 Resource not accessible by integration`, with `x-accepted-github-permissions`): for example environment writes need `administration: write`, reads need `actions: read`; `/app` and installation lookups need the JWT. `state.issueInstallationToken()`, `fake.token()` and `POST /__token` mint a token without a JWT.
- **Rate limits.** Every authenticated response has `x-ratelimit-limit|remaining|used|reset|resource` (the real names, not the OpenAPI `x-rate-limit-*`). Primary budget per installation and resource (`core`, `graphql`): 5,000/h by default with the doc's formula (+50 per repository and per member above 20, cap 12,500, 15,000 on an `enterprise` plan), fixed window from the first request; over the limit is 403 (or 429) with `remaining: 0`. `GET /rate_limit` is free. Secondary limits (JOB-045): concurrent requests, REST points per endpoint per minute, GraphQL points, content creation per minute and hour; they answer 403 (or 429) with `retry-after` (omittable). A rejected request records nothing. See ADR-0077. Configure per test:

  ```ts
  createFakeGitHub({ config: { primary: { limits: { core: 3 }, windowMs: 1000 }, secondary: { restPointsPerMinute: 10, retryAfter: false } }, clock })
  fake.state.config.forced = { requests: 2, retryAfterSeconds: 42, status: 429, match: '^POST /orgs/acme/repos$' } // next 2 matching requests
  ```

- **Pagination.** `page`/`per_page` (default 30, max 100) with absolute `Link` headers (`next`, `last`, `prev`, `first`) that keep other query parameters. Variables lists default to 10 per page (max 30) like GitHub.
- **Invitations.** Organization invitations expire after 7 days (lazily removed from lists), limits are 500 per 24 h on paid plans or organizations older than a month and 50 otherwise, and an org with `plan.seats` set and no free seat refuses (422). Repository invitations (PUT collaborator for a non-member, 201) also expire after 7 days. `state.acceptInvitation(org, id)` and the team membership `pending`/`active` states let tests complete the flow.
- **Teams and permissions.** Slugs derive from the name. Effective repository permission is the maximum of org owner, direct grant, org base role and team access; `affiliation=direct` lists every direct collaborator including outside ones (FAC-ACL-002); a permission below the base role is `Cannot assign {login} permission of {role}`; custom role names come from `org.customRoles`.
- **Deploy keys** are unique across the fake: a key already attached anywhere is `422 Validation Failed` with `errors[0] = { resource: "PublicKey", code: "custom", field: "key", message: "key is already in use" }` (FAC-DKY-002).
- **Empty repositories.** `POST /git/refs` (and the other Git Data reads and writes) answer `409 Git Repository is empty.`; the default branch must exist first (LIF-047). `refs/pull/*` is read-only (`422 Reference update failed`); creating a pull request writes `refs/pull/N/head` into the ref table for the git server (`isHiddenRef`). Commits touching `.github/workflows/` need the `workflows` permission.
- **Repository create and delete.** Private creation is `403` when `org.membersCanCreatePrivateRepositories` is false; delete is `403` when `config.repositoryDeletion` is `forbidden` or the org forbids it (LIF-077).
- **Branch protection.** The GraphQL model is the store (`state` rules per repository): `allowsForcePushes` and `bypassForcePushActorIds` are independent (ADR-0040), `blocksCreations` independent of `restrictsPushes` (ADR-0041), actors are node ids that must exist and have write access. Rules are enforced for REST ref writes and, through the git server's ref-policy seam, for `git push` (`checkRefUpdate`, `canForcePush`): force pushes need `allowsForcePushes` or a bypass-list actor, deletions need `allowsDeletions`, creations are blocked by `blocksCreations` unless the actor is in the push allowances, updates by `restrictsPushes` likewise; repository admins (Administration: write) bypass a rule unless it has `isAdminEnforced` (ADR-0076). The actor is the App behind the token, so the ADR-0040 check is a non-admin token (`fake.token({ permissions: { contents: 'write' } })`) of a listed versus an unlisted App. REST `PUT .../protection` only takes existing branches and replaces everything except the GraphQL-only bypass lists. Patterns use `File.fnmatch` with `FNM_PATHNAME` (`qa/*` does not match `qa/a/b`). Operations are executed by graphql-js against `specs/github.graphql`, so anything outside the subset is a validation error; errors carry GitHub's `type` (`NOT_FOUND`, `FORBIDDEN`, `UNPROCESSABLE`).
- **LFS batch** at `POST /{owner}/{repo}.git/info/lfs/objects/batch` (Basic `x-access-token:<token>`): `download` answers 200 with `error.code: 404` per missing object, `upload` returns an upload action (a `PUT` records the object). `lfsHas(repo, oid)` can delegate existence to T-040's LFS store; the default is `RepoRecord.lfs`.
- **Not modelled:** user (OAuth/PAT) tokens, issues, releases, actions runs, rulesets (not used in v1), webhook deliveries (always empty), SSH keys verification, organization seats beyond the invitation rule, `pull_request` merge and reviews, `Retry-After` on primary limits.

### Control plane (no auth)

- `POST /__reset` body `{ "fixture"?: string, ...config }`. Drops all state, tokens and counters and reseeds the App and its installation (default: one on the organization `acme` with the provider doc's permissions, no members, no repositories, no teams). `empty` is the only built-in fixture; register others with `createFakeGitHub({ fixtures: { world: (state) => { … } } })`. An unknown name is a 400. Ids are deterministic, timestamps follow the injected `clock`.
- `POST /__config` merges `primary`, `secondary`, `forced`, `repositoryDeletion`, `maxBlobBytes`, `environmentProtection`; `"clearUsage": true` forgets rate-limit counters.
- `GET /__state` returns users, organizations (members, teams, invitations, secret names), installations, token metadata and repositories (refs, collaborators, keys without key material, hooks without secrets, rules, pulls, LFS). No tokens, secrets or key text.

### Building a world (T-043)

`GitHubState` builders return the created records: `addUser`, `addOrg`, `addApp`, `addInstallation`, `addMember`, `addTeam`, `addRepository` (optional `files` make an initial commit, `gitRoot` is the seam), `addBranch`, `addCollaborator`, `grantTeam`, `addDeployKey`, `addEnvironment`, `addVariable`, `addSecret`, `addHook`, `addPull`, `addLfsObject`, `invite`, `acceptInvitation`. The TST-012 GitHub side (org `acme`, no repositories, members matching Bitbucket members by email and login, no teams) is `addMember('acme', login)` plus `addUser({ login, email })`; `email` is kept for matching and never served, `publicEmail` is what `GET /users/{login}` shows.

Git access is tied to the fake's tokens when `startFakes` wires the `target` side: Basic with any username and an installation token as password, 404 when the token cannot see the repository, 403 below Contents read (fetch) or write (push), pushes pass the ref policy above (`remote: error: Protected branch update failed …`). `POST /__reset` stops admitting API requests (409), waits for requests in flight, then calls `repositoryHooks.deleted` for every repository, which also drops the bare repository and its LFS objects; `created` always starts from an empty bare repository (and `created`/`renamed` re-derive the policy flag from the current rules, `syncPolicyFlag`), and a failing hook rolls the REST record back.

**Fixtures (T-043):** rules created before the bare repository is seeded (builders skip `repositoryHooks`) leave no policy flag; after `createBareRepo`/`seedBareRepo` call `fake.syncPolicy(repo?)` (`startFakes(...).github.syncPolicy`) so pushes are checked against the rules. `resetDrainMs` bounds how long `/__reset` waits for in-flight requests (default 10 s).

Seam to the git server: `RepoRecord.gitRoot` is the bare repository path below the `target` side; the REST fake never reads it (listed in `/__state`). `clone_url` is `{gitBaseUrl}/{owner}/{name}.git`, with `gitBaseUrl` defaulting to `http://localhost:4030/target` (`startFakes` passes the git server's). `startFakes` wires the git server in (ADR-0070): `repositoryHooks` create, rename and delete the bare repository under `target` when a repository is created, renamed or deleted through the REST API (the builders do not call them, fixtures seed the git server themselves), and `lfsHas` reads the `target` LFS store. Until the git server holds the data, branches, commits, trees, contents and compare are served from an in-memory object store with real git hashing (`RepoRecord.git`); T-043 should seed both consistently.

### Validation against GitHub's OpenAPI

`src/github/spec-validation.ts` (`validateAgainstSpec(method, pathTemplate, status, body)`) validates a response with `openapi-response-validator` 12.1.3 (same pin as the Bitbucket fake) against `specs/github.openapi.json`. The fake's tests run every endpoint's happy path and its documented errors through it. The validator is fed the description without `examples` and `x-*` extensions (they contain `null`, which it cannot read), with `$ref` responses inlined and `application/json` as the only media type; schema keywords are untouched. Error responses whose operation documents no body (for example `404` of team membership) are asserted by status only.

## Fake git and LFS server (TST-013)

Code in `src/git/`. A small Node HTTP server runs `git http-backend` as CGI over bare repositories, plus a minimal Git LFS server.

- URLs: `http://127.0.0.1:4030/{source|target}/{repoPath}.git` (ADR-0070). `source` and `target` have separate repository directories and LFS stores under `rootDir`. LFS lives at `{repoUrl}/info/lfs`.
- `source` is read-only by default (`allowPush: false`); `target` accepts pushes. Both use `transfer.fsckObjects=true`. `publicUrl` sets the base for LFS links (default: the listening address). `startFakes` starts this server on 4030 (env `FAKE_GIT_PORT`, `FAKE_GIT_ROOT`, `FAKE_GIT_PUBLIC_URL`; `git: false` skips it) and points the fake Bitbucket's clone links at `/source`.
- Auth: HTTP Basic on every request. Passwords default to `fake-token` (`tokens`), usernames to any (`usernames`), or pass `authenticate`. Optional per-side `authorize` (status per repository and operation) and `refPolicy` / `refPolicyFlag` (pre-receive branch protection decisions; with the flag the hook only calls the policy when `{bare repo}/gm-policy-active` exists, kept in step with the rules by `syncPolicyFlag`; `refs/pull/*` pushes are always denied) let a provider fake tie the side to its own rules. **With the fake GitHub started (`startFakes` with `githubPort`/`github`; `src/main.ts` always), the `target` side accepts only the fake GitHub's installation tokens as Basic passwords (any username): 404 for repositories the token cannot see, 403 below Contents read/write, and pushes pass the branch protection rules.** The default `fake-token` then no longer works on `target`; `source` is unchanged.
- LFS: batch API (`download`, `upload`), object PUT/GET and `verify`, basic transfer only. A missing object on `download` is a per-object `error.code` 404. Batches over 100 objects get 413.
- Rejections (ADR-0071): the `target` side defaults to a 100 MiB max blob (pre-receive hook, GitHub's "Large files detected" text) and a 2 GiB max push (counted by the server while streaming, answered with a fixed `413`, nothing applied). Tests lower them with `setLimits` or the `maxBlobBytes` / `maxPushBytes` options; `null` disables a limit.
- Seeding (ADR-0072): `createBareRepo` and `seedBareRepo(path, { commits, bytesPerCommit, branches, tags, lfsFiles, bigBlobs }, { store, repo })` build repositories without a server.
- Test helpers: `isolatedGitEnv`, `basicAuthEnv` (credentials via `GIT_CONFIG_*` environment, never argv) and `runGit`.

```ts
import { startFakeGitServer, createBareRepo, seedBareRepo } from '@git-migrator/provider-fakes';

const git = await startFakeGitServer({ rootDir, port: 0, target: { maxBlobBytes: 1024 * 1024 } });
await createBareRepo(git.repoDir('source', 'acme/app'));
await seedBareRepo(git.repoDir('source', 'acme/app'), { commits: 10, tags: [{ name: 'v1', annotated: true }] });
git.repoUrl('source', 'acme/app'); // http://127.0.0.1:<port>/source/acme/app.git
```

Standalone: `pnpm --filter @git-migrator/provider-fakes start:git` (env `GM_FAKE_GIT_PORT`, `GM_FAKE_GIT_ROOT`, `GM_FAKE_GIT_TOKEN`). The server needs git >= 2.31 (`assertGitPrerequisites` fails clearly); the tests also need `git-lfs`. With the fake GitHub started, `startFakes` creates, renames and deletes the `target` bare repositories (and their LFS objects) when repositories are created, renamed or deleted through the fake GitHub's REST API, and `/__reset` wipes them.

Declared internal dependencies (ARC-012, checked by `pnpm lint`): none.
