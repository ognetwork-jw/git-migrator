# ADR-0013: Pre- and post-run manual tasks

- Status: accepted
- Date: 2026-10-08

## Context

Some human actions are only possible after a migration (setting secret values, merging generated Change Requests). Counting them against readiness would make almost nothing one-click.

## Decision

Manual tasks have phase `pre` (affects readiness → NeedsAttention) or `post` (gates Verified only). Ready Migrations show their follow-up count.

## Consequences

One-click migration remains honest: the result isn't Verified until follow-ups are done.
