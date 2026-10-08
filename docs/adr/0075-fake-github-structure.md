# ADR-0075: Fake GitHub structure, control plane and git server wiring

- Status: accepted (no spec change needed)
- Date: 2026-10-08
- Task: T-042
- Affects: TST-011, TST-012, TST-013, DEV-020

## Context

TST-011 lists what the fake GitHub implements but not how it is started, reset, seeded or connected to the git server (T-040), and TST-012 needs its state to be buildable for the fixture world (T-043).

## Decision

- **Shape.** Same as the fake Bitbucket: `createFakeGitHub(options)` returns `{ app (Hono), state, limiter, config(), reset(), token() }`, `startFakeGitHub()` binds it (4020, `127.0.0.1`). The fake keeps its own `Link` pagination in `src/github/link.ts` and does not depend on `src/common/`.
- **Seed and `empty`.** A fake without a GitHub App installation cannot be called, so `POST /__reset {"fixture":"empty"}` leaves the App (id 12345, slug `git-migrator-fake`) and one installation on the organization `acme` with the permissions of the provider doc, and nothing else: no users, members, repositories or teams. Other fixtures run against that state (`createFakeGitHub({ fixtures })`, as T-043 will register `world`).
- **Determinism.** Ids (users, repositories, teams, rules, ...) restart from fixed bases on reset, git objects use real git hashing with synthetic commit dates, so two resets give identical worlds. Timestamps in API bodies, token expiry, invitation expiry and rate-limit windows come from an injectable `clock` (default wall clock), because App auth must work against the real time in end-to-end runs.
- **Tokens.** Installation tokens are random `ghs_` + 36 hex characters held in memory with expiry, permissions and optional repository restriction; `/__state` lists metadata only. `fake.token()` and `POST /__token` mint one without a JWT for clients that do not exercise App auth.
- **Bodies the OpenAPI description cannot validate.** Responses are validated with `openapi-response-validator` 12.1.3 (the pin of the Bitbucket fake) after dropping `examples` and `x-*` keys (they contain `null`, which the validator throws on) and keeping only `application/json` per response. Documented error operations without a body schema are asserted by status.
- **Git server wiring.** `gitBaseUrl` is the `target` side URL (`{git}/target`), clone URLs are `{gitBaseUrl}/{owner}/{name}.git`. `RepoRecord.gitRoot` is the seam to the bare repository. REST Git Data, contents and compare use an in-memory object store until the git server's data is consulted (T-043 seeds both). As ADR-0070 requires, `startFakes` passes `repositoryHooks` that create (always from an empty bare repository, leftovers and LFS objects removed), rename and delete the bare repository and its LFS objects on REST create, rename and delete, and `lfsHas` reading the `target` LFS store. `reset()` is asynchronous: it calls the `deleted` hook for every repository before dropping the records, so `/__reset` also resets the git server. A failing `created` hook rolls the REST record back. A reset first stops admitting API requests (`409 The fake is being reset`), waits for the requests in flight to finish, and only then wipes the git server and the state, so no request writes into the new world (a request that straddles a reset completes in the old world, its record and bare repository are then removed together). Resets are serialized. The drain is bounded (`resetDrainMs`, default 10 s): on timeout the reset proceeds and the generation counter turns the straggler into a `409`. The control plane (`/__state`, `/__config`, `/__token`) answers `409` while a reset runs. A git push straddling a reset fails closed (`repository not found`) because the bare repository is gone. The git server gained two optional per-side seams for this (`authorize`, `refPolicy`; the pre-receive hook asks the server, which asks the fake GitHub, with a per-push ticket so credentials never enter the hook environment); `startFakes` binds the `target` side to the fake GitHub's tokens and branch protection rules when the fake GitHub is started.
- **Start.** `startFakes` starts the fake GitHub only when `githubPort` (or `github` options) is given, so existing callers and tests are unchanged; `src/main.ts` always passes 4020.

## Alternatives

- An empty world with no installation. Rejected: nothing could authenticate.
- Deterministic timestamps from a fixed clock. Rejected: JWT and token expiry would break against real clients.
- Starting the fake GitHub in every `startFakes` call. Rejected: port 4020 would collide between parallel test files.

## Consequences

T-043 builds the GitHub side of the TST-012 world with `GitHubState` builders inside a `world` fixture and seeds the `target` side of the git server; it can switch `startFakes` to default-on when it adds the fixture to the e2e start script.
