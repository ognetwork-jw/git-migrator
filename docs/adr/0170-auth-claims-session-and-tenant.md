# ADR-0170: Entra claims, the sign-in gate and tenant enforcement

- Status: accepted (spec updated)
- Date: 2026-10-08
- Task: T-020
- Affects: AUTH-002, AUTH-003, AUTH-004, AUTH-005, AUTH-010, AUTH-011

## Context

AUTH-011 asks for the `roles` claim to be read "using Better Auth's `mapProfileToUser` / account hooks", with an ADR if a constraint prevents it. In Better Auth 1.7.7:

- `mapProfileToUser` can add fields to the user but cannot deny a sign-in, and a thrown error surfaces as a generic `unable_to_get_user_info`. Persisting the claims as user fields would store provider data in `auth.user` that any later `update-user` call could overwrite.
- `user.validateUserInfo` runs before a user is created, before an account is linked and, for OAuth, at every sign-in. It receives the raw decoded id-token claims (`source.oauth.profile`) and the fresh name and email. Returning `{ error }` redirects to the error URL with `error=<code>` and creates nothing.
- The authorization-code callback decodes the id token returned by the token endpoint and does not verify its issuer; only the `idToken` sign-in path verifies it against the tenant keys.
- The default Microsoft scopes include `User.Read` and `offline_access`, and the provider fetches a profile photo from Graph.

## Decision

1. **Claims are read in `user.validateUserInfo`.** For the `microsoft` provider it checks the tenant, evaluates `auth.roleMappings` for method `entra` against the claims, and returns `role_assignment_required` when nothing matches. `mapProfileToUser` only supplies the email fallback (`email`, else `preferred_username`). The decision (role, display name, email) is not stored in the Better Auth tables.
2. **Hand-off to Actor sync.** The decision travels to `databaseHooks.session.create.before` in an `AsyncLocalStorage` that `AuthService.handle(request)` opens for each request. The hook provisions or updates the Actor (AUTH-005) and refuses the session if the Actor is disabled. The Hono mount (API-001) MUST call `handle`, not `auth.handler`; without the request state an Entra sign-in is denied (fail closed), and a test pins this.
3. **Tenant.** `tenantId` is passed to the provider, and `validateUserInfo` also requires `claims.tid === auth.entra.tenantId`, because the code flow does not verify the issuer. An empty tenant id denies every Entra sign-in. Denial code: `tenant_not_allowed`.
4. **Scopes.** `disableDefaultScope: true` with `scope: ['openid','profile','email']` (AUTH-002), and `disableProfilePhoto: true` so no Graph call is made. `overrideUserInfoOnSignIn: true` keeps name and email current (AUTH-005).
5. **Method detection** in the session hook is by the user's account: a `microsoft` account means method `entra` (role from mapping), a `credential` account means test sign-in (only when `auth.testSignIn.enabled`). Anything else is refused (`sign_in_method_not_allowed`). Account linking is disabled, so a password user and an Entra user can never share an account.
6. **Denial surface.** Failures redirect to `<publicUrl>/auth/error?error=<code>` (Better Auth `onAPIError.errorURL`), with the codes in `AUTH_ERROR_CODES`. Their explanations are the `auth.error.*` keys of `apps/web/messages/en.json`. The page that renders them belongs to the UI tasks.
7. **Lost assignment.** When a returning Entra user no longer matches any mapping, the sign-in is denied, the Actor row is left as it was, and the user's existing sessions are deleted, so the missing assignment takes effect immediately instead of after the 8 h session expires. (AUTH-010 only requires denial; revoking is the safe reading of "Entra is the source of truth".)
8. **Cookies and sessions.** `Secure` follows the public URL scheme. Production requires an https `publicUrl` (`packages/config/src/schema.ts`, `publicUrl` rule; `src/config-rules.test.ts` pins it), so the cookie is Secure there and not on the plain-http dev origin; `HttpOnly` and `SameSite=Lax` are set explicitly. The cookie cache is off so sign-out and revocation apply on the next request. `expiresIn` is 8 h and `updateAge` 1 h.

9. **The app uses the redirect code flow only (round 1 review).**
   - `disableIdTokenSignIn: true`: a client-posted id token is never a sign-in (it was replayable for up to an hour and survived sign-out and role removal).
   - A `hooks.before` on `/sign-in/social` accepts only the fields in `SOCIAL_SIGN_IN_FIELDS` (`provider`, `callbackURL`, `errorCallbackURL`, `newUserCallbackURL`) and rejects any other (400), so AUTH-002's scopes cannot be widened (`scopes`, `additionalParams`, `idToken`, `loginHint`) and `additionalData` cannot store data without a sign-in (round 3 review: an allowlist instead of a denylist, so a field a Better Auth upgrade adds is refused until it is allowed on purpose).
   - `AuthService.handle` reads at most `MAX_AUTH_BODY_BYTES` (64 KiB) of a request body and answers 413 above that, before Better Auth sees the request.
   - OAuth tokens are never stored: `databaseHooks.account.create/update.before` null every token column, and `account.encryptOAuthTokens: true` is the second layer should a hook ever be removed.
   - `disabledPaths` (404): `/get-access-token`, `/refresh-token`, `/account-info`, `/link-social`, `/list-accounts`, `/unlink-account`, `/update-user`, `/update-session`, `/change-email`, `/change-password`, `/delete-user`, `/delete-user/callback`, `/sign-up/email`, `/request-password-reset`, `/reset-password` (and `DISABLED_PATH_PREFIXES`, a prefix check in `hooks.before`, because `/reset-password/:token` has a parameter), `/verify-password`, `/send-verification-email`, `/verify-email`, `/list-sessions`, `/revoke-session`, `/revoke-sessions`, `/revoke-other-sessions`, and `/sign-in/email` unless test sign-in is on. `/set-password` is server-only and has no HTTP route. Kept: `/sign-in/social`, `/callback/:id`, `/get-session`, `/sign-out`, `/ok`, `/error`. The list is `DISABLED_PATHS`. A test checks structurally that every Better Auth route is kept, in `DISABLED_PATHS` or under `DISABLED_PATH_PREFIXES`, and also probes each one over HTTP.
10. **Logging.** Better Auth's output goes to the application logger (`createLogger`, `component: auth`, JSON, shared redaction) through `betterAuthLogger`; email addresses are also removed because the shared rules key on field names. A failure while finishing a callback redirects to `/auth/error?error=sign_in_failed` instead of returning a raw 500.
11. **Tenant id.** The config schema trims and lowercases `auth.entra.tenantId` and requires a GUID (or empty), because the `tid` claim is one; `createAuth` repeats the check defensively.
12. **Request checks.** `advanced.disableOriginCheck: false` is set explicitly, because Better Auth skips origin and CSRF checks when `NODE_ENV` is `test` or `TEST` is set. A foreign `callbackURL`, `errorCallbackURL` or `newUserCallbackURL`, or a cookie-bearing POST from a foreign Origin, gets 403.
13. **Logs.** `betterAuthLogger` logs the first Error as `err` and the other arguments as `args` (emails scrubbed recursively, including `cause`), so no error is dropped. `migrateAuthSchema` takes the same logger. Round 3 review hardened it:
   - Every string and the message are cut to `MAX_LOGGED_TEXT` (4 KiB, with a `[truncated N chars]` marker) before any pattern runs, and the cut backs off over a run of address or token characters so no half address is left behind. The email pattern is bounded (local part 1 to 64, domain 1 to 253 characters, no `/`), so scrubbing is linear and one request cannot block the event loop.
   - Errors become plain objects with `type` (the constructor name), `message`, `stack`, `cause` and their own enumerable fields (`detail`, `constraint`, ...), all scrubbed. The shared rules redact any `code` key (it may be an OAuth code), so a short identifier-like `code` (an SQLSTATE, `ECONNREFUSED`) is also written as `errorKind`. Other non-plain objects are written as their scrubbed `String(value)`.
   - Cycles are cut (`[Circular]`), throwing getters read as `[Unreadable]`, one call writes at most 500 values, the message is coerced with `String`, and any failure falls back to logging the scrubbed message alone. Logging never throws into the request path.
14. **Test seams are not production options (round 3 review).** The Entra authority override (pointing sign-in at the local OIDC stub) and the decision rewrite used by one test live in `AuthTestSeams`, which only `createAuthForTest` in `@git-migrator/auth/testing` accepts. `CreateAuthOptions` has neither, and `createAuth` always uses Better Auth's default authority.

## Alternatives

- Store the claims on the user through `additionalFields` and read them in the session hook: durable, but client-writable through `update-user` and a copy of provider data to keep consistent.
- Wrap the session hook in a module-level variable keyed by user id: racy across concurrent sign-ins.
- Trust the issuer check alone: it is not run on the code path.
