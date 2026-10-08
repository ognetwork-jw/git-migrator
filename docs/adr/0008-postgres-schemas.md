# ADR-0008: Separate Postgres schemas, no cross-schema foreign keys

- Status: accepted
- Date: 2026-10-08

## Context

Better Auth must live in a separate schema from ZenStack. BullMQ owns its own tables.

## Decision

Use schemas `app`, `auth` and `bullmq`, each migrated by its own tool. `Actor.authUserId` references `auth.user.id` logically, without an FK.

## Consequences

Referential integrity between Actor and auth user is maintained in code (provisioning hooks).
