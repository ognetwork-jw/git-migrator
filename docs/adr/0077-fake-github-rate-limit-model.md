# ADR-0077: Fake GitHub rate limit model

- Status: accepted (no spec change needed)
- Date: 2026-10-08
- Task: T-042
- Affects: TST-011, JOB-045

## Context

TST-011 asks for `x-ratelimit-*` headers and configurable secondary-limit 403s. The provider doc gives the numbers (primary formula, 900 points per minute per endpoint, 2,000 for GraphQL, 80 content-creating requests per minute and 500 per hour, 100 concurrent requests) and the response rules (403 or 429, `retry-after`), but no counting details.

## Decision

- **Primary.** Per installation (App JWT calls are counted per App) and resource (`core`, `graphql`). Fixed window from the first request, `reset` is that start plus the window (default one hour), `limit` follows the doc formula unless overridden. The 403 (429 optional) response carries `x-ratelimit-remaining: 0` and the reset time, no `retry-after`, message `API rate limit exceeded for installation ID {id}.`. `GET /rate_limit` is not counted. A GraphQL query costs the nodes it can return divided by 100, rounded up, at least one: the sum over connections of `first`/`last` multiplied through the nesting, variables resolved (`rateLimit { cost nodeCount }` reports it); a mutation costs one. The LFS batch API goes through the same secondary and primary accounting as REST (`core`).
- **Secondary.** Points per route template per minute (GET and HEAD 1, mutating 5; GraphQL query 1, mutation 5; 900 and 2,000 per minute), content creation counts every mutating REST request (80 per minute, 500 per hour), concurrency counts in-flight requests. The response is `403` (or `429`) with the secondary-limit message and `retry-after` (seconds until enough points leave the window, minimum 1; omittable to test the fallback rule). A request rejected by a limit records nothing, and a secondary rejection consumes no primary budget. Each limit can be set to `null` to switch it off.
- **Forced rejections.** `config.forced = { requests, retryAfterSeconds, status, retryAfter, match }` rejects the next N requests (optionally those matching `METHOD /path`) without touching counters, for backoff tests (JOB-045).
- **Headers on errors.** Every authenticated response, including errors, carries the `x-ratelimit-*` set of the `core` bucket (`graphql` for `/graphql`).

## Alternatives

- Count secondary points per token. Rejected: GitHub scopes them to the user or installation, as for the primary limit.
- Rolling primary window. Rejected: GitHub documents a fixed hourly reset.

## Consequences

The numbers are defaults; tests lower them. `GET /rate_limit` reports only the three modelled resources with real values and zero buckets for the others.
