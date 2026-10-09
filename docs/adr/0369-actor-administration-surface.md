# ADR-0369: What the Actors page offers: service Actor creation, disable and enable, keys; no role change in the UI

- Status: accepted (spec updated)
- Date: 2026-10-09
- Task: T-091
- Affects: UI-034, API-020, AUTH-020, AUTH-040

## Context

UI-034: "Actors list (human and service). Service Actor creation. API keys: create (shown once, copy button), revoke. Disable Actor." API-020 lets an admin change `role` with `PATCH /actors/{id}`, but only for service Actors, and a human's role comes from the sign-in method.

## Decision

- The list shows every Actor, human and service, with its type, role and status. Keys are offered only under service Actors.
- Creating a service Actor takes a name and a role (`POST /actors`).
- Disabling asks first (a popover). Enabling is offered on a disabled Actor (`PATCH` with `disabled: false`); the spec does not name it, but without it a disabled service Actor cannot be restored from the UI.
- An admin cannot disable their own account: the control is disabled, with the reason as its title. The server refuses it too (409 `conflict`).
- Role changes are not offered in the UI. UI-034 does not ask for them, and the `last_admin` rule (409) makes a demotion a multi-step decision the page would have to explain. The API still supports it.
- Refused changes show the problem text, so `last_admin` and `conflict` read as sentences (`problem.<code>`).

## Alternatives

- A role select on each service Actor: more surface than UI-034 asks for, and a demotion of the last admin needs its own message. Deferred.
- No enable control: a disabled service Actor could not be restored without the database. Rejected.
