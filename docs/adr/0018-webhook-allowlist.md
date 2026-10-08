# ADR-0018: Webhooks auto-created only when allowlisted

- Status: accepted
- Date: 2026-10-08

## Context

Payload formats differ between providers (Q54b).

## Decision

Create a hook automatically only when its URL matches the Route allowlist. Otherwise raise a post task with exact settings. Hooks with secrets are created inactive until the receiver is updated.

## Consequences

Receivers are never silently broken.
