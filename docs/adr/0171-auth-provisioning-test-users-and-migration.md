# ADR-0171: Actor linking, test sign-in users and the Better Auth migration

- Status: accepted (spec updated)
- Date: 2026-10-08
- Task: T-020
- Affects: AUTH-001, AUTH-005, AUTH-010, AUTH-012, DATA-030

## Context

AUTH-005 links Actors by `authUserId`, ADR-0121 item 9 says seeded test Actors are linked by email at sign-in, AUTH-012 has the seed script create the test users, and DATA-030 step 3 runs "Better Auth migrations".

## Decision

1. **Entra Actors are linked by `authUserId` only.** An Actor that was seeded with the same email (for example `admin@test.local`) is never claimed by an Entra identity, so a tenant user cannot inherit a seeded Actor's role. A second Actor is created instead. Two simultaneous first sign-ins converge on one Actor through the unique `authUserId`.
2. **Test sign-in links by email.** At the first password sign-in the seeded human Actor with that email and no `authUserId` is linked (a conditional update, so two concurrent sign-ins cannot both link it). The role is never changed (AUTH-010). A test user without an Actor is denied (`actor_not_found`).
3. **Test sign-in users** are created by `pnpm db:seed` (not `migrate`) when `auth.testSignIn.enabled`, directly in the Better Auth store with `GM_TEST_USER_PASSWORD` (the sign-up endpoint is disabled: `disableSignUp`). The seed is idempotent and replaces a stored password only when it no longer matches. It refuses to run when the flag is off, when the password is empty, and in production.
4. **Production guard.** `assertTestSignInAllowed` throws when the flag is on and either the validated `environment` or the raw `GM_ENVIRONMENT` is `production`. `createAuth` and the seed call it, in addition to the config schema's own check. The raw variable is checked too because a config file that lost its `environment` key reads as `development` (ADR-0051).
5. **Migration.** `migrateAuthSchema` runs Better Auth's `getMigrations(...).runMigrations()` (the library behind its CLI `migrate`) on a pool whose `search_path` is `auth` (AUTH-001). The CLI itself needs a config file the library can import; the programmatic form needs none and runs in the plain-node `migrate` entrypoint. It is step 3, between the ZenStack migrations and config sync, idempotent, and it fails instead of adding a required column to a populated table.
6. **Disabled Actors.** A disabled Actor's sign-in is refused and its sessions are deleted (AUTH-005). Revoking sessions at the moment an administrator disables an Actor belongs to the Actor administration endpoint (T-021 and the UI tasks); request-time resolution of a session to a disabled Actor must also reject it (AUTH-020, T-021).

7. **Identity is the Entra `oid`, not the email (round 1 review).** For Entra users `auth.user.email` holds a synthetic address `<oid>@entra.invalid` (the `.invalid` TLD is reserved, so it cannot equal a real or seeded address), set in `mapProfileToUser`. The real address from the claims (`email`, else `preferred_username`) is stored only on the Actor and re-synced at every sign-in. A changed or recycled address therefore cannot collide on Better Auth's unique email or fail to link. Test sign-in users keep their real seeded addresses. The decision made at the profile gate carries the `oid`, and the session hook denies when the session's account is not that `oid`.
8. **`Actor.email` is not unique** (the schema has no constraint) and stays that way: two Actors may hold the same address after a mailbox is recycled, and the sync never fails on it. Test sign-in linking only considers Actors without an `authUserId`, so a recycled address cannot capture a seeded Actor.
9. **Audit.** Creating an Actor and changing its role at sign-in each write an `AuditEvent` (`actor.created_by_sign_in`, `actor.role_changed_by_sign_in`, null `actorId` = system, `data` with the old and new role) in the same transaction as the Actor write.
10. Any other failure while finishing a sign-in ends on the error page with a defined code (`sign_in_failed`, or Better Auth's own such as `account_not_linked`, each with a text in `en.json`), never a raw 500.

## Alternatives

- Link Entra identities to seeded Actors by email: convenient for demos, but lets a tenant user with a chosen email address take over a seeded admin Actor.
- Run `npx @better-auth/cli migrate` as a child process: needs a TypeScript config file importable by the CLI and a second process in the migrate Job.

## Addendum (round 2)

- The synthetic address is also removed from the session response: an `after` hook on `/get-session` replaces `user.email` with the Actor's email. UI and API code take the display name and email from the Actor, never from `session.user`.
