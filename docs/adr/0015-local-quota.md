# ADR-0015: Local quota tracking

- Status: accepted
- Date: 2026-10-08

## Context

Bitbucket user API tokens return no rate-limit headers, yet limits are enforced (the user's observation, confirmed by Atlassian docs: headers only for scaled limits).

## Decision

Track every request in a Postgres sliding-window ledger keyed by account and resource group, using documented limits from config. Honor headers whenever present.

## Consequences

A small write per request. Limits must be updated in config if Atlassian changes them.
