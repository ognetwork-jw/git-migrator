# ADR-0230: GitHub adapter: identifiers, configuration, authentication and quota

- Status: accepted (no spec change needed)
- Date: 2026-10-08
- Task: T-033
- Affects: ADP-010, ADP-011, ADP-014, ADP-060, JOB-040, JOB-043, JOB-045, AUTH-060, FAC-ACL-002, FAC-BRR-002, FAC-WEB-002, LIF-047, LIF-077

## Context

The spec fixes the GitHub endpoints and limits but leaves open: what a canonical principal id is on GitHub, what `EndpointRuntime.config` and `credential` hold, how the installation token is cached across jobs, how requests map to quota buckets, and which API lists the repositories.

## Decision

1. **Identifiers.** Repository `providerId` is the GraphQL `node_id` (the domain model says so, and `createBranchProtectionRule` needs it). Namespace `providerId` is the numeric organization id as a string. Identity `providerId` and the `id` of an `identity` principal are the numeric user id; Group `providerId` and the `id` of a `group` principal are the numeric team id. Logins, slugs and GraphQL actor node ids are looked up when a write needs them, from the organization members, outside collaborators, teams and the repository's direct collaborators (`Directory`). Renamed logins therefore never break a stored principal.
2. **Configuration.** `configSchema` is `{ org, appId, installationId, gitBaseUrl = https://github.com, maxConcurrentRequests = 10, quotaOverrides = {} }`, strict. The runner merges `endpoints[].options`, `gitBaseUrl`, `github.maxConcurrentRequests` and `quota.overrides` into it. `appId` or `installationId` of `0` (the DEP-040 placeholder, ADR-0051) is refused at `connect` with `invalid`. `credentialSchema` accepts the PEM private key as a string or `{ privateKey }`. `accountKey` is supplied by the runner (one per installation).
3. **Authentication.** RS256 JWT (`iat` 60 s back, 9 minutes of life) exchanged at `POST /app/installations/{id}/access_tokens` through a second `ProviderHttpClient` whose `authorize` returns the JWT (its own `app-token` bucket). The installation token is cached in a process-wide `InstallationTokenCache` per adapter instance, keyed by base URL, App id, installation id and a digest of the key (never the key), refreshed 5 minutes before expiry, single-flight per key, failures not cached; a 401 drops it. `authorize` declares the token as a secret; Git credentials (`x-access-token`) read the same cache, so long pushes get a fresh token between batches.
4. **Quota.** Classifier buckets (JOB-045): `core` for REST, `graphql` for `/graphql`, `search`, `lfs` (3,000 per minute, the LFS batch host is a second client with the web base URL), `app-token`, and for POST/PATCH/PUT/DELETE additionally `content-minute` (80 per 60 s) and `content-hour` (500 per 3600 s). Every request takes a `QuotaLeases` lease on `concurrent` with the configured cap when the host supplies a `LeaseGate`; without one the cap is not enforced. `interpret` turns `x-ratelimit-*` (with `resource`) into fixed-window feedback (`nearLimit` at 20% left), classifies 403/429 as `rate-limited` (remaining 0, or "rate limit exceeded", wait until `retry-after` or the reset) or `secondary-limit` (message), reports GraphQL `rateLimit.cost` as an adjustment, and charges GraphQL mutations (recognised from the response data) to the content buckets because the classifier sees only method and path. Primary limits come from the headers (feedback uses the provider limit and the known window of the resource; unknown resources are ignored), so `quotaOverrides` only set the starting limit. The quota vocabulary (`bucketKey`, `BucketSpec`, `QuotaFeedback`, `QuotaPool`) is re-exported by `adapter-sdk` as in ADR-0223. The text of the invitation daily-cap 422 is unverified (see docs/providers/github.md).
5. **Repository listing** uses `GET /installation/repositories` (exactly what the App can read), not `/orgs/{org}/repos`.
6. **Errors.** A non-limit 403 is `forbidden` and never retried (missing Administration: write on a repository delete or a GraphQL branch-protection mutation, or an organization delete policy); 422 "already exists" or "already in use" is `conflict`; a GraphQL `FORBIDDEN` or `NOT_FOUND` error in a 200 response maps the same way. Writes use `retry: false`; reads of Facets use `capture: true`. The invitation daily cap becomes `rate_limited` with a 24 h `retryAt`.
7. **Provider token shapes**: `gh[pousr]_` and `github_pat_`, bounded and linear.
8. **Limits**: 100 MiB blob, 2 GiB push, names up to 100 characters of `[A-Za-z0-9._-]`, case-insensitive, hidden `refs/pull/`.

## Alternatives

- Numeric repository ids as provider ids: rejected, the domain model names the node id.
- Logins as principal ids: rejected, they are renamable.
- One client with the token exchange inside `authorize`: rejected, it would recurse into the same client and bypass the quota service.
- Classifying GraphQL mutations by path: impossible; response-based adjustment is the closest the SDK allows.

## Consequences

The runner (T-028) must build the config object and `accountKey` as above. Follow-up: confirm on a staging org whether the organization delete policy blocks Apps and which permission the GraphQL mutations need (both unverified, docs/providers/github.md).
