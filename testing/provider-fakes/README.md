# @git-migrator/provider-fakes

Stateful HTTP fakes of the provider APIs plus a git http-backend server (TST-010 … TST-013).

| Fake | Task | Port (DEV-020) | Status |
|---|---|---|---|
| Fake Bitbucket Cloud | T-041 | 4010 | implemented |
| Fake GitHub | T-042 | 4020 | later |
| Git http-backend + LFS | T-040 | 4030 | later |

```sh
pnpm --filter @git-migrator/provider-fakes start      # all available fakes
FAKE_BITBUCKET_PORT=4010 FAKES_HOST=0.0.0.0 FAKE_GIT_BASE_URL=http://localhost:4030 pnpm --filter @git-migrator/provider-fakes start
```

The servers bind to `127.0.0.1` by default because `/__reset`, `/__config` and `/__state` have no auth. Set `FAKES_HOST=0.0.0.0` only inside the Compose `fakes` container (DEV-020).

Layout: `src/common/` (pagination, `q`/`sort`/`fields`), `src/bitbucket/` (state, serializers, app, rate limiter, fixtures), `src/start.ts` (starts every fake; add the others beside Bitbucket), `specs/` (saved OpenAPI documents). Programmatic use: `createFakeBitbucket(options)` returns `{ app, state, limiter, config, reset }`. `app` is a Hono app (use `app.request()` without a socket), `startFakes()` binds real ports (port `0` = ephemeral).

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

`BitbucketState` has builders that return the created records (`addWorkspace`, `addUser`, `addMember`, `addGroup`, `addProject`, `addRepository`, `addBranch`, `addBranchRestriction`, `addDeployKey`, `addProjectDeployKey`, `addVariable`, `addEnvironment`, `addEnvironmentVariable`, `addWebhook`, `addWorkspaceWebhook`, `addWorkspaceVariable`, `addPullRequest`, `grantRepositoryUser|Group`, `grantProjectUser|Group`). Register fixtures with `createFakeBitbucket({ fixtures: { world: (state) => { … } } })`; they run against freshly reset state on `POST /__reset {"fixture":"world"}`.

Seam to the git server (T-040): `FakeRepository.gitRoot` is the bare repository path. The REST fake never reads it. It is listed in `/__state`, and `links.clone` points at `gitBaseUrl` (`http://localhost:4030`) as `{gitBaseUrl}/{workspace}/{slug}.git`. Until T-040 lands, `src` is served from the in-memory `FakeRepository.files` (ref independent) and branches carry a deterministic fake hash.

### Validation against Atlassian's OpenAPI

`src/bitbucket/spec-validation.ts` (`validateAgainstSpec(method, pathTemplate, status, body)`) validates a response with `openapi-response-validator` (pinned exactly) against `specs/bitbucket-cloud.openapi.json`. The fake's tests run every endpoint through it. Exemptions are limited to what the provider doc says is not in the schema: `default_branch_deletion` and null `mainbranch` (see ADR-0061). `/downloads` has no response schema and `/issues` is absent from the document, so those two are asserted by hand.

Declared internal dependencies (ARC-012, checked by `pnpm lint`): none.
