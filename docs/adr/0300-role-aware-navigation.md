# ADR-0300: Which sidebar items each role sees

- Status: agent-decided
- Date: 2026-10-08

## Context

UI-010 hides "items the Actor's role can't use" but does not say which items need which role. AUTH-020 lets viewers read everything, so "can use" has to mean the item's primary purpose, not read access.

## Decision

Each sidebar item names the AUTH-020 capability its page exists for (`apps/web/src/shell/navigation.ts`), checked with the shared `can` helper (exported client-safely as `@git-migrator/auth/capabilities`):

- Migration (Dashboard, Repositories, Waves, Endpoints) and Capability matrix: `read`, so every role.
- Identity mapping, Team mapping: `decideMappings`; Invitations: `manageInvitations` (operator and admin).
- Naming rules, Webhook allowlist, Overlays: `manageRules`; Actors and API keys: `manageActors` (admin).
- Audit log: `readAuditLog` (every role).

Sections left empty are hidden. A page outside the sidebar needs `read`. Opening a page without its capability redirects to `/denied?required=<role>`. The server still enforces every rule (AUTH-021).

## Alternatives

- Show every item to every role and rely on server errors: contradicts UI-010.
- Hide People and Configuration from viewers completely: hides the read-only Capability matrix.

## Affected requirements

UI-010, UI-036, AUTH-020, AUTH-021.
