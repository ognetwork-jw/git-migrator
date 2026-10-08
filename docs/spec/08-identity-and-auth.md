# 08 — Identity, Authentication and Authorization

## Better Auth (AUTH-001 … AUTH-012)

- **AUTH-001 Storage.** Better Auth uses Postgres schema `auth`, through its own `pg.Pool` with `options: '-c search_path=auth'`. Its tables are created by the Better Auth CLI migration in the `migrate` entrypoint (DATA-030). ZenStack never models these tables.
- **AUTH-002 Microsoft Entra ID.** This is the first sign-in method: the Better Auth `microsoft` social provider with `tenantId` set to the configured tenant. The scopes are `openid profile email`. Accounts from other tenants are rejected.
- **AUTH-003 Mount point.** Better Auth is served from `/api/auth/*`, through the Hono app (API-001). Cookies are `HttpOnly`, `Secure` (except in dev), `SameSite=Lax`.
- **AUTH-004 Sessions.** `expiresIn` 8 h, `updateAge` 1 h. Sign-out invalidates server-side.
- **AUTH-005 Actor provisioning.** On first successful sign-in, create a `human` Actor linked by `authUserId`, with `displayName` and `email` from the profile. Every later sign-in updates these fields and re-evaluates the role (AUTH-010). A disabled Actor's sign-in is rejected, and its existing sessions are revoked.
- **AUTH-010 Role mapping.** Provider claims map to in-app roles through config, so future sign-in methods can map their own claims:

  ```yaml
  auth:
    roleMappings:
      - { method: entra, claim: roles, value: "GitMigrator.Admin",    role: admin }
      - { method: entra, claim: roles, value: "GitMigrator.Operator", role: operator }
      - { method: entra, claim: roles, value: "GitMigrator.Viewer",   role: viewer }
  ```

  - If several mappings match, the highest role wins (`admin > operator > viewer`).
  - No match → sign-in is denied with a page explaining that an Entra app role assignment is required. No session is created.
  - The role is re-synced at every sign-in **through a method that has mappings** (`entra`), and the Actor's `role` column stores the result. An admin-assigned role is not possible for those Actors: Entra is the source of truth.
  - Actors signing in through test sign-in (AUTH-012) are exempt from mapping. They keep the role stored on their seeded Actor.
- **AUTH-011 Claim extraction.** The `roles` claim is read from the Entra ID token returned at sign-in, using Better Auth's `mapProfileToUser` / account hooks. If an implementation constraint prevents this, the implementor records an `agent-decided` ADR.
- **AUTH-012 Test sign-in.** When config `auth.testSignIn.enabled: true`, Better Auth `emailAndPassword` is enabled and the seed script creates one Actor per role (`viewer@test.local`, `operator@test.local`, `admin@test.local`, password from secretspec `GM_TEST_USER_PASSWORD`). Startup MUST abort if `testSignIn.enabled` is true while `GM_ENVIRONMENT=production` (Q66).

## Service Actors and API keys (AUTH-040)

- Admins create `service` Actors with a role, then issue API keys for them. Human Actors cannot have API keys.
- Key format: `gm_<8-char prefix>_<32-char secret>`, base62, generated with a CSPRNG and shown exactly once.
- Only `sha256(key)` is stored. Lookup is by `prefix`, followed by a constant-time hash compare.
- Keys are used as `Authorization: Bearer gm_…` on `/api/model/*` and `/api/v1/*`. They are not accepted on `/api/auth/*`.
- Optional `expiresAt`. A revoked or expired key returns 401. `lastUsedAt` is updated at most once per minute.

## Authorization (AUTH-020)

Every request resolves to an Actor (session or API key) or is rejected with 401. Exceptions: `/api/auth/*` and health endpoints. Metrics are served on a separate port (DEP-050), not through the API. ZenStack access policies use `auth()` = the Actor.

| Capability | viewer | operator | admin |
|---|---|---|---|
| Read everything (except API key hashes, raw responses' bodies) | ✓ | ✓ | ✓ |
| Read raw responses | | ✓ | ✓ |
| Analyze, run, resync, verify, rollback, source read-only, cancel runs | | ✓ | ✓ |
| Mark complete / revoke | | ✓ | ✓ |
| Complete, reopen or dismiss tasks; create Expected Differences | | ✓ | ✓ |
| Waves, bulk actions | | ✓ | ✓ |
| Identity and Group mapping decisions, CSV import | | ✓ | ✓ |
| Create, edit, approve Invitation Batches (Q59) | | ✓ | ✓ |
| Naming rules, webhook allowlist, overlays | | | ✓ |
| Actors, service Actors, API keys | | | ✓ |
| Audit log | ✓ | ✓ | ✓ |

- **AUTH-021** Policies are expressed in ZModel (`@@allow` / `@@deny`, plus field-level `@deny` for lifecycle fields: DOM-011). Custom `/api/v1` handlers check the same rules via a shared `can(actor, capability)` helper in `packages/auth`, and run privileged writes through the server-only client.
- **AUTH-022 Audit.** Every mutation by an Actor produces an `AuditEvent`, whether through RPC or a custom endpoint, with action, subject and a redacted diff. RPC mutations are captured by a ZenStack client plugin (query hook) on audited models. Custom endpoints write audit events explicitly. Reads are not audited.

## Identity mapping (AUTH-050)

Identity Mappings are per Route: source Identity → target Identity.

1. **Email source.** If `endpoints[].atlassianAdmin` is configured (organization ID plus an API key secret), the Bitbucket adapter enriches source Identities with emails from the Atlassian Admin API (managed accounts, `emailSource: atlassian-admin`). GitHub Identities carry an email only when it's public (`emailSource: provider-public`).
2. **Matching cascade** (Q30/Q58), run after each inventory, **only for mappings in status `unmapped` or `suggested`**. Decisions (`confirmed`, `excluded`, `pending_invite`) are never overwritten.
   1. Exact case-insensitive **email** match → `confirmed`, method `email`. This is automatic when `policies.identityMatch.autoConfirmEmail` is true; otherwise `suggested`.
   2. Exact case-insensitive **login** match (Bitbucket nickname = GitHub login) → `suggested`, confidence 0.9.
   3. **Normalized display-name** match (NFKD, lowercase, alphanumerics only) with exactly one candidate → `suggested`, confidence 0.7.
   4. Otherwise `unmapped`. If an email is known, the Identity is an invitation candidate.

   Suggestions always need an operator to confirm them.
3. **CSV import:** header `source,target,action`.
   - `source` is a Bitbucket `account_id` or nickname.
   - `target` is a GitHub login or an email.
   - `action ∈ {map, invite, exclude}`.

   The import is validated in full before anything is applied, and errors are reported per row.
4. **Exclusion** requires a reason and creates Route-scoped `identity_excluded` Expected Differences covering that principal wherever it can appear: `/grants[principal=identity:<id>]`, `/members[principal=identity:<id>]`, `/teams[slug=*]/members[principal=identity:<id>]`, `/rules[pattern=*]/restrictPushes[principal=identity:<id>]` (and the same for `restrictMerges`, `forcePushExempt`, `deletionExempt`), and `/owners[pattern=*]/principals[principal=identity:<id>]`. This is "ignored with the migrator's consent" (Q30).
5. Changing a mapping marks affected Analyses stale.

Group Mappings follow the same flow: an existing target team with the same slug is `suggested`, and otherwise the team is planned for creation (FAC-END teams). When the endpoint Migration creates the team, the GroupMapping becomes `confirmed` with `targetGroupId` set.

## Invitation batches (AUTH-060)

Implements Q59.

1. An operator creates a draft batch from candidates (all, or filtered). Each item has an email and the team slugs it will join.
2. **Seat preview.** Read the GitHub org's `plan.seats` and `plan.filled_seats` where the App can read them, otherwise show "unknown". The preview shows `toInvite` (selected count) and the projected seats.
3. The operator reviews the items and can **deselect** any of them. Deselecting requires a reason and creates the `identity_excluded` Expected Difference (step 4 of AUTH-050), so the person isn't counted against parity. Reselecting revokes it.
4. Approval records the approver and immediately enqueues the send job. The endpoint Migration's `members` step never sends invitations; it only verifies.
   - The job calls `POST /orgs/{org}/invitations` with `email`, `role: direct_member` and `team_ids` for teams that already exist.
   - It respects quota, stores `providerInvitationId`, marks each item `sent` or `failed` with an error, and sets the IdentityMapping to `pending_invite`. `targetIdentityId` stays null until acceptance.
   - If GitHub refuses because of an invitation rate or daily cap, the remaining items stay `selected`, and the job re-schedules itself 24 h later.
5. **Acceptance correlation**, at each inventory. GitHub's invitation API reveals the invitee login only in some cases, so:
   1. If a pending invitation disappeared and its `invitee.login` (when GitHub provided it) is now a member, link them: item `accepted`, mapping `confirmed`, method `invite`, `targetIdentityId` set.
   2. Otherwise, new org members that match no mapping are offered on the Identity mapping page as suggestions for `pending_invite` mappings. An operator confirms.
   3. Invitations that GitHub reports as expired or failed (`GET /orgs/{org}/failed_invitations`) → `expired`. They can be added to a new batch.
6. Nothing is ever invited outside an approved batch (AUTH-061).
