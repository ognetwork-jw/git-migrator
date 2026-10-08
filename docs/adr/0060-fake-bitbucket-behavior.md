# ADR-0060: Fake Bitbucket behavior choices where the spec is silent

- Status: agent-decided
- Date: 2026-10-08
- Task: T-041
- Affects: TST-010, TST-012, JOB-040, JOB-043, JOB-044, FAC-ACL-001, LIF-070

## Context

TST-010 and the provider doc fix the endpoint list, pagination, auth, "no rate-limit headers, 429 at the documented limits", the repository `PUT` create quirk and the optional `/1.0/groups`. They do not say how the limits are bucketed, what a 429 carries, how a partial `PUT` behaves (ADR-0036 item 10 is unverified), how effective permissions are derived, or how tests change fake behavior.

## Decision

1. **Rate-limit groups follow JOB-043** exactly: `repository-data` (`/2.0/repositories/**` and any other `/2.0` or `/1.0` path, 1000), `webhooks` (repository and workspace hooks, 1000), `raw-files` (`src` file downloads, 5000, also counted in `repository-data`), `app-properties` (`/properties/**`, 2000). JOB-043 lists hooks and properties separately, so they are counted only in their own group; only `raw-files` is stated as "also counted". A request in two groups is granted only if both grant and then recorded in both. A `src` path naming a directory is a listing, so it is `repository-data` only. The `git` group is T-040's. Counting is per `accountId` (credentials sharing one share quota, JOB-040) over a rolling window (default 1 h). A 429 has the Bitbucket error body and no headers (not even `Retry-After`), and a rejected request records nothing. Config is changed through constructor options, `POST /__config` (`clearUsage` forgets counters and keeps limits) and `POST /__reset`, with an injectable clock.
2. **Partial `PUT`.** Default `merge` (only sent fields change). `reset-omitted` is an opt-in mode that resets `is_private`, `fork_policy`, `project` and `mainbranch` when omitted, so T-032 can test the "compare and restore" guard of LIF-070 against the worst case.
3. **Effective permission** (`/workspaces/{ws}/permissions/repositories/{slug}`) is the maximum of workspace admin, group default permission, every group grant on the repository and the project, and project and repository user grants; `create-repo` reports as `write`. Users without access are omitted.
4. **`/1.0/groups` removal** is a runtime mode (`enabled`, `not-found` = 404, `gone` = 410).
5. **Control plane.** `POST /__reset` restores constructor options, counters and credentials, then runs the fixture. `GET /__state` redacts API tokens. Both are unauthenticated. Fixtures are plain functions over `BitbucketState`, registered by name, so T-043 adds `world` without touching the server.
6. **Authorization.** Credentials may carry `scopes` (default all). Required scopes come from `x-atlassian-oauth2-scopes` in the saved document (static table, test cross-checked); all listed scopes are required, none implies another; missing scopes are a 403 with `detail.granted/required`. A credential whose account is not a workspace member gets 403 for that workspace. Per-repository permission checks are not modelled.
7. **Input validation.** Branch-restriction `POST`: malformed `users`/`groups`, a missing `value` for `require_commits_behind`, a missing `branch_type` for `branching_model` and a duplicate (kind, pattern, match kind, branch type) are 400 (a duplicate is rejected like the real API's "already exists"). Repository `PUT`: a new slug must be slugified (else 400) and a rename onto an existing slug is 409 with no change applied. `q`/`sort` apply only on endpoints that document them, an unknown field is 400, an invalid pull request `state` is 400, and a page beyond the last is 404 (the OpenAPI document is silent; this mirrors the real API).
8. **Default bind** is `127.0.0.1` because the control plane is unauthenticated; the Compose `fakes` container sets `FAKES_HOST=0.0.0.0`.
9. **Partial-PUT test coverage.** Default suites run with `merge`; T-032 runs the LIF-070 guard tests in both `merge` and `reset-omitted`.
10. **Pagination caps.** Default `pagelen` 10, clamp at `maxPagelen` (default 100, configurable) instead of rejecting, because the real API "may enforce different values" and the adapter must follow `next`.
11. **Default credential** is the dummy `operator@test.local` / `fake-bitbucket-api-token` (not a secret; no real system accepts it).

## Alternatives

- One global bucket: hides that webhooks and raw downloads are throttled separately.
- Always `reset-omitted`: a pessimistic guess that could break adapters against a real API that merges.
- Emitting `Retry-After` on 429: contradicts the "no rate-limit headers" requirement and real behavior.
