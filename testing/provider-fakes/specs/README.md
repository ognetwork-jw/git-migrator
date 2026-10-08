# Provider API specs

## Bitbucket Cloud


### bitbucket-cloud.openapi.json

- Source: <https://dac-static.atlassian.com/cloud/bitbucket/swagger.v3.json> (Atlassian's published Bitbucket Cloud OpenAPI 3.0 document, linked from <https://developer.atlassian.com/cloud/bitbucket/rest/>).
- Retrieved: 2026-10-08 by task T-030, unmodified (1,374,776 bytes, `info.version` 2.0).
- Used for: verifying `docs/providers/bitbucket-cloud.md` and, later, response validation in the Bitbucket fake (TST-010).
- Known gaps: no `/1.0/` paths, no issue-tracker paths, and some responses (for example `/downloads`) have no schema. See ADR-0036.

## GitHub

Machine-readable GitHub API descriptions that the GitHub fake (T-042, TST-011) and the adapter contract tests are built against. Added by T-031. The prose findings are in `docs/providers/github.md`.

| File | What | Source | Pin | Retrieved |
|---|---|---|---|---|
| `github.openapi.json` | OpenAPI 3.0.3, `info.version` 1.1.4. A trimmed subset: every path in the provider doc's "Endpoints used" table (all methods for the repeated families, only the used methods for the others) plus the Git Data reads (`git/ref`, `git/matching-refs`, `git/commits/{sha}`, `git/trees/{sha}`, `git/blobs`), `orgs/{org}/teams/{team_slug}`, outside collaborators, invitation delete, repository invitations, `/app`, `/apps/{app_slug}`, `/rate_limit`, installation and token endpoints, and every `components` entry they reference. `x-webhooks` is removed. 81 paths. Validates with `@apidevtools/swagger-parser` 10.1.0. | [github/rest-api-description](https://github.com/github/rest-api-description), `descriptions/api.github.com/api.github.com.json` | commit `2eba8c3ba02f022011539cf01efc43e0251502f8` (sha256 of the full file `ba5ddc1eeeede9f3858abd96325359891f38a2bd8e20fd111abf4230741db194`) | 2026-10-08 |
| `github.graphql` | GraphQL SDL subset: `Query.repository/node/user/organization/rateLimit`, the three `*BranchProtectionRule` mutations, `BranchProtectionRule` with its push and bypass allowance connections, and the actor types. `Query`, `Mutation`, `Repository`, `BranchProtectionRule`, `User`, `Team`, `App` and `Organization` are cut to the fields kept; everything else is verbatim. Builds with `graphql` 16.9.0 `buildSchema`. | [octokit/graphql-schema](https://github.com/octokit/graphql-schema) `schema.graphql` (derived from GitHub's published schema; `docs.github.com/public/fpt/schema.docs.graphql` was unreachable from the build environment) | commit `82ff2d4780080e6929ebb95608cefa22dfa05ac7` (sha256 of the full file `3c62d0526d133cee53221c89de9b455ade24db78b9e7ad56d642c4c15bce2654`) | 2026-10-08 |

`github.openapi.json` carries the same provenance in `info.x-git-migrator-source`.

### Known differences between the description and live behavior

- The OpenAPI `components.headers` name the rate limit headers `x-rate-limit-*`. The documented and real headers are `x-ratelimit-limit|remaining|used|reset|resource`. The fake MUST emit the latter.
- The description does not list the App permission needed per endpoint. That comes from `github/docs` `server-to-server-permissions.json` (see Sources S3 in the provider doc).
- Error body texts (for example the deploy-key "key is already in use" 422) are not in the description.

### Secret scanning

`github.openapi.json` contains GitHub's public documentation example token strings (for example `ghs_16C7e42F292c6912E7710c838347Ae178B4a`). They are not credentials. T-003's gitleaks config MUST allowlist `testing/provider-fakes/specs/github.openapi.json` by path.

### Regenerating

1. Download both full files at the pinned commits from `raw.githubusercontent.com` (no `api.github.com` calls) as `api.github.com.json` and `schema.graphql` into one directory, copy `sources.sha256` there, and run `sha256sum -c sources.sha256`. It must pass before trimming.
2. `python3 -I trim-openapi.py api.github.com.json github.openapi.json`. The script injects `info.x-git-migrator-source`; update the pin inside the script when re-pinning.
3. Copy `trim-graphql.mjs` into a scratch directory, run `npm i --no-save graphql@16.9.0` there (ESM imports resolve from the script's directory), then `node trim-graphql.mjs schema.graphql github.graphql`. Prepend the 5-line header comment already present in `github.graphql`.
4. Validate: `@apidevtools/swagger-parser` 10.1.0 `validate()` for the OpenAPI file; `graphql` 16.9.0 `buildSchema()` for the SDL (the script already does the latter).
5. Bump the pins and date in this file and re-verify the `[S*]` claims in `docs/providers/github.md` that cite them.
