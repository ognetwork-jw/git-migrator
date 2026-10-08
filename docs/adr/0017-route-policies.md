# ADR-0017: Route policies pre-accept lossy translations

- Status: accepted
- Date: 2026-10-08

## Context

Bitbucket Standard merge checks are advisory and GitHub enforces them. The user chose to enforce (Q53a) without per-repository acknowledgement.

## Decision

Route `policies.acceptLossy` lists policy keys whose lossy decisions are accepted route-wide, recorded as `lossy_accepted` Expected Differences. Default: `branch-rules.advisory-enforced`, `environments.category-dropped`.

## Consequences

Fewer NeedsAttention repositories. Policy changes mark Analyses stale.
