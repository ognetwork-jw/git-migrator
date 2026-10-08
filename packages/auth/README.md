# @git-migrator/auth

Better Auth configuration, role mapping and Actor provisioning. It implements [08-identity-and-auth](../../docs/spec/08-identity-and-auth.md) AUTH-001 to AUTH-012. Decisions: ADR-0170, ADR-0171.

Internal dependencies (ARC-012): `@git-migrator/db`, `@git-migrator/config`, `@git-migrator/observability`.

## What it provides

| Export | Purpose |
|---|---|
| `createAuth(options)` | Builds Better Auth: Entra (`microsoft` provider with the configured tenant, scopes `openid profile email`), 8 h sessions refreshed after 1 h, `HttpOnly`/`SameSite=Lax` cookies (`Secure` on https), no account linking, optional email and password for test sign-in. Aborts when test sign-in is enabled in production. |
| `AuthService.handle(request)` | Serves `/api/auth/*`. The Hono mount MUST use it and not `auth.handler`: it carries the validated role from the profile gate to the session hook, and an Entra sign-in is denied without it. |
| `migrateAuthSchema(connectionString)` | DATA-030 step 3: creates the Better Auth tables in schema `auth` through the library's own migrator on a pool with `search_path=auth`. Idempotent. |
| `resolveRole(mappings, method, claims)` | AUTH-010: highest mapped role wins, no match is `undefined`. |
| `provisionMappedActor`, `linkTestActor` | AUTH-005 and AUTH-012: create or update the Actor behind a session. |
| `seedTestSignInUsers`, `createCredentialUser` | AUTH-012: the Better Auth users of the seeded test Actors. Used by `pnpm db:seed`. |
| `assertTestSignInAllowed(config, env)` | The production guard. |
| `DISABLED_PATHS`, `DISABLED_PATH_PREFIXES`, `MAX_AUTH_BODY_BYTES` | The Better Auth routes answered with 404 (ADR-0170), and the body size above which `handle` answers 413. `/sign-in/social` accepts only `provider`, `callbackURL`, `errorCallbackURL` and `newUserCallbackURL`. |
| `betterAuthLogger`, `scrubEmails` | DEP-050: Better Auth's output as JSON through the application logger, with every string cut to 4 KiB and email addresses removed in linear time. It never throws. |
| `AUTH_ERROR_CODES` | The `error` values of a denied sign-in redirect (`<publicUrl>/auth/error?error=<code>`). Their texts are `auth.error.*` in `apps/web/messages/en.json`. |

## Sign-in flow

1. The user starts Entra sign-in. Better Auth redirects to the Entra authority for the configured tenant and handles the callback.
2. `user.validateUserInfo` receives the id-token claims: the tenant (`tid`) must match, the `roles` claim is mapped through `auth.roleMappings` (method `entra`), and no match denies the sign-in before anything is created.
3. The session hook provisions or updates the `human` Actor (`displayName`, `email`, `role`) and refuses a disabled Actor, deleting its sessions.
4. Test sign-in (`auth.testSignIn.enabled`) uses email and password for the seeded `viewer@`, `operator@` and `admin@test.local` users. Their Actors are linked by email at the first sign-in and keep their seeded role.

## Testing

`@git-migrator/auth/testing` has `createAuthForTest(options, seams)` (the only way to pass `AuthTestSeams`: the Entra authority of the stub and a decision rewrite; the production `createAuth` takes neither), `startEntraStub` (a local token endpoint and key set standing in for Microsoft, so no test reaches a real Entra endpoint) and `signInWithEntra`/`CookieJar`, which drive the authorization-code flow against `AuthService.handle`. The tests create databases named `gm_t020_<random>` with `createTestDatabase` and drop them afterwards. `src/auth.test.ts` needs PostgreSQL 16 (see the db README).

UI and API code take the display name and email from the Actor, never from `session.user`: Better Auth stores a synthetic `<oid>@entra.invalid` address for Entra users (ADR-0171), and the session response replaces it with the Actor's email.

Not in this package yet: the sign-in and `/auth/error` pages (UI tasks), the Hono mount (T-021), request-time resolution of a session or API key to an Actor (T-021).
