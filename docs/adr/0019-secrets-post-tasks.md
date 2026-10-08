# ADR-0019: Secrets are never set to placeholders

- Status: accepted
- Date: 2026-10-08

## Context

Secret values are unreadable from Bitbucket.

## Decision

Raise a post task per scope with ready-to-run `gh secret set` lines. Parity compares names.

## Consequences

Workflows needing secrets fail until humans set them, which is visible through the open task.
