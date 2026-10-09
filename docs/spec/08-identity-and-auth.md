# 08 — Identity, Authentication and Authorization

## Better Auth (AUTH-001 … AUTH-012)

- **AUTH-001 Storage.** Better Auth uses Postgres schema `auth`, through its own `pg.Pool` with `options: '-c search_path=auth'`. Its tables are created by the Better Auth CLI migration in the `migrate` entrypoint (DATA-030). ZenStack never models these tables.
- **AUTH-002 Microsoft Entra ID.** This is the first sign-in method: the Better Auth `microsoft` social provider with `tenantId` set to the configured tenant. The scopes are `openid profile email`. Accounts from other tenants are rejected: besides `tenantId`, the token's `tid` claim must equal the configured tenant, which config validates as a lower-case GUID. Only the redirect code flow is used: id-token sign-in, client-supplied scopes or extra sign-in parameters, and Better Auth's token and account endpoints are disabled, and provider OAuth tokens are not stored (ADR-0170).
- **AUTH-003 Mount point.** Better Auth is served from `/api/auth/*`, through the Hono app (API-001). Cookies are `HttpOnly`, `Secure` (except in dev), `SameSite=Lax`.
- **AUTH-004 Sessions.** `expiresIn` 8 h, `updateAge` 1 h. Sign-out invalidates server-side. Origin and CSRF checks are always on, whatever the environment variables (ADR-0170).
- **AUTH-005 Actor provisioning.** On first successful sign-in, create a `human` Actor linked by `authUserId`, with `displayName` and `email` from the profile. Identity is the Entra `oid`, never the email: the Better Auth user record holds a synthetic address, the real address lives on the Actor (not unique), and UI and API code read name and email from the Actor. Creating an Actor and changing its role at sign-in write `AuditEvent`s with a null (system) actor (ADR-0171). Every later sign-in updates these fields and re-evaluates the role (AUTH-010). A disabled Actor's sign-in is rejected, and its existing sessions are revoked.
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

- **AUTH-021** Policies are expressed in ZModel (`@@allow` / `@@deny`, plus field-level `@deny` for lifecycle fields: DOM-011). Custom `/api/v1` handlers check the same rules via a shared `can(actor, capability)` helper in `packages/auth`, and run privileged writes through the server-only client. The policy-enforcing client handed to the RPC mount is an allow-list facade: model delegates, `$transaction` (callback, or an array of operations that same facade issued) and a read-only `$schema`, and nothing else. It accepts only plain-data arguments and returns errors without SQL text or parameters (ADR-0122). Only a validated deep clone of the arguments reaches the data layer, so a caller cannot change them after the call. Proxies, accessors, class instances, cycles, objects reached twice, depth over 64, more than 10,000 values, more than 1,000,000 string characters and any `$expr` key are refused as `invalid-input`. `orderBy`, `by`, aggregates and sub-queries may not use a read-denied field. An error that is not a wrapped database error but carries SQL or driver fields is rethrown as the generic database error (ADR-0200, ADR-0202).
- **AUTH-022 Audit.** Every mutation by an Actor produces an `AuditEvent`, whether through RPC or a custom endpoint, with action, subject and a redacted diff. RPC mutations are captured by a ZenStack client plugin (query hook) on audited models. Custom endpoints write audit events explicitly. Reads are not audited.
  - An RPC mutation and its events commit or roll back together. One event is written per affected row, with `actorId` the mutating Actor, `action` `rpc.<model>.<create|update|delete>`, and a diff of changed fields only. A mutation without an Actor id fails.
  - The diff redacts values of fields and JSON keys whose names suggest secrets (secret, token, password, credential, authorization, api key, hash), and omits strings or JSON longer than 2,000 characters.
  - `AuditEvent` may be created only with `actorId` equal to the acting Actor, a narrow exception to DOM-005. It has no update or delete, and RPC callers cannot reach it.
  - Deleting a Wave records the Migrations it unassigned in the event (ADR-0201, ADR-0202).
  - Custom endpoints name their actions after the domain: `inventory.refresh`, `migration.analyze`, `run.create`, `run.cancel`, `migration.mark_complete`, `migration.revoke_complete`, `task.done|reopen|dismiss`, `expected_difference.create|revoke`, `migration.wave_assign|wave_remove`, `identity-mapping.confirm|exclude|unmap|import.<action>`, `group-mapping.confirm|rename`, `overlay.create|update|delete`, and the invitation batch actions. A bulk action writes one event per item. Commands that only enqueue write their event after the enqueue succeeded, so the audit is at least once. `run.create` and `run.cancel` are written in the mutation's transaction. Events never record e-mail addresses, Overlay documents or the typed Run confirmation (ADR-0320, ADR-0330, ADR-0362, ADR-0370, ADR-0405, ADR-0415).
  - System changes are audited with a null Actor: parity's `task.auto_complete` (LIF-061) and the endpoint Run's `group-mapping.confirm` (LIF-081) (ADR-0396, ADR-0435).

## Identity mapping (AUTH-050)

Identity Mappings are per Route: source Identity → target Identity.

1. **Email source.** If `endpoints[].atlassianAdmin` is configured (organization ID plus an API key secret), the Bitbucket adapter enriches source Identities with emails from the Atlassian Admin API (managed accounts, `emailSource: atlassian-admin`). GitHub Identities carry an email only when it's public (`emailSource: provider-public`).
2. **Matching cascade** (Q30/Q58), run after each inventory, **only for mappings in status `unmapped` or `suggested`**. Decisions (`confirmed`, `excluded`, `pending_invite`) are never overwritten.
   1. Exact case-insensitive **email** match → `confirmed`, method `email`. This is automatic when `policies.identityMatch.autoConfirmEmail` is true; otherwise `suggested`.
   2. Exact case-insensitive **login** match (Bitbucket nickname = GitHub login) → `suggested`, confidence 0.9.
   3. **Normalized display-name** match (NFKD, lowercase, alphanumerics only) with exactly one candidate → `suggested`, confidence 0.7.
   4. Otherwise `unmapped`. If an email is known, the Identity is an invitation candidate.

   Suggestions always need an operator to confirm them.

   A step that finds more than one candidate (two Identities with the same email or display name) is ambiguous and falls through to the next step. When several sources would be confirmed to one target by email, or the target is already confirmed to another source, they are `suggested` instead. Each source Identity has one mapping per Route (bots and non-members included), created `unmapped` when nothing matches; an automatic email confirmation sets `decidedAt` and leaves `decidedById` null. A Group member that is not a known Identity is left out of the Group's `memberIds`, and inventory never deletes Identities or Groups (ADR-0280).
3. **CSV import:** header `source,target,action`.
   - `source` is a Bitbucket `account_id` or nickname.
   - `target` is a GitHub login or an email.
   - `action ∈ {map, invite, exclude}`.

   The import is validated in full before anything is applied, and errors are reported per row.

   Rules (ADR-0320):
   - **Format.** The header is case-insensitive, and a BOM is allowed. At most 5,000 data rows; cells at most 320 characters, with no control characters; RFC 4180 quoting. The body is `text/csv` or `text/plain` (415 otherwise).
   - **Matching.** `source` matches an account id first, then a login, case-insensitively. A `map` `target` matches a target login, or an email when it contains `@`. Several matches are `*_ambiguous`, none is `*_not_found`. The same source twice, or a target confirmed for two sources, is an error on the later row.
   - **Actions.** `map` confirms with method `csv`. `exclude` records the reason "Excluded by CSV import". `map` and `exclude` may replace an earlier decision, which the dry run reports as `replaces_decision`. `invite` invites nothing. It records the email on the source Identity (`emailSource: csv`, refused as `email_conflict` against a different provider email) and leaves the mapping `unmapped`. On a `confirmed` or `excluded` mapping it is the row error `already_decided`. For a `pending_invite` mapping, `map` and `exclude` are the row error `invite_pending`. Rows that change nothing are `unchanged`.
   - **Formula injection.** A `target` starting with `=`, `+`, `-`, `@`, tab or carriage return is refused (`formula_prefix`). Cells echoed in a report are prefixed with an apostrophe when they start with one of those characters.
   - **Dry run and apply.** `?dryRun=true` returns a report per row and writes nothing. Apply re-validates everything in one transaction under the Route's mapping lock and answers 422 `validation_failed` with the row errors if anything is invalid. A lock or statement timeout answers 503 `busy` with `Retry-After: 5`.
4. **Exclusion** requires a reason and creates Route-scoped `identity_excluded` Expected Differences covering that principal wherever it can appear: `/grants[principal=identity:<id>]`, `/members[principal=identity:<id>]`, `/teams[slug=*]/members[principal=identity:<id>]`, `/rules[pattern=*]/restrictPushes[principal=identity:<id>]` (and the same for `restrictMerges`, `forcePushExempt`, `deletionExempt`), and `/owners[pattern=*]/principals[principal=identity:<id>]`. This is "ignored with the migrator's consent" (Q30). The patterns cover the source Identity's provider id and, when the mapping had a target, the target's provider id too, because translated documents name target principals. Ids are escaped as field-path keys. The records carry the reason as `note` and link to the mapping (`identityMappingId`). Confirming, excluding again or unmapping revokes every record linked to the mapping (ADR-0320).
5. Changing a mapping marks affected Analyses stale (LIF-021).

**Decisions** (ADR-0320, ADR-0370). The Identity decisions are `confirm`, `exclude` and `unmap`; the Group decisions are `confirm` and `rename`.
- `confirm` takes the suggested target or the `targetIdentityId` given. The target must belong to the Route's target Endpoint (422) and must not be confirmed for another source (409). Confirming the suggestion keeps its method and confidence; a chosen target is `manual`.
- `exclude` needs a reason of 1 to 500 characters.
- `unmap` returns the mapping to `unmapped` with no decision. `unmap` and `exclude` of a `pending_invite` mapping are 409 `revoke_first`, and the operator revokes the invitation instead. `confirm` of a `pending_invite` mapping is how an operator names the invitee: it accepts the person's `sent` and `unknown` entries and moves in-flight `selected` entries to `unknown`.
- A Group `confirm` needs a target team. `rename` takes a lowercase slug (`[a-z0-9]` with single hyphens, at most 100 characters) and is refused for a confirmed mapping (409). A slug an existing team holds makes the mapping `suggested`; otherwise the team is planned.
- A decision that changes nothing writes no audit event, marks nothing and publishes nothing.

Group Mappings follow the same flow: an existing target team with the same slug is `suggested`, and otherwise the team is planned for creation (FAC-END teams). When the endpoint Migration creates the team, the GroupMapping becomes `confirmed` with `targetGroupId` set. This happens only on ledger proof that the Run created the team, and only for an unambiguous slug (LIF-081, ADR-0435).

## Invitation batches (AUTH-060)

Implements Q59.

1. An operator creates a draft batch from candidates (all, or filtered). Each item has an email and the team slugs it will join. A candidate is a human source Identity with a non-empty email whose mapping is `unmapped` (`suggested` people are decided first). The person and their normalized address must not be held by an outstanding entry in the same target organization, on any Route. A draft names its people or asks for `all`, never both, with at most 5,000 entries; two candidates sharing an address are never drafted together. Team slugs are the confirmed target team's slug, else the planned slug (ADR-0370).
2. **Seat preview.** Read the GitHub org's `plan.seats` and `plan.filled_seats` where the App can read them, otherwise show "unknown". The preview shows `toInvite` (selected count) and the projected seats. The web process has no provider access, so creating a draft enqueues the job step `seats`, which stores `{toInvite, seatsTotal, seatsFilled, seatsReadAt}`. `toInvite` follows every select, deselect and approval, and a seat total of 0 means no limit (ADR-0370).
3. The operator reviews the items and can **deselect** any of them. Deselecting requires a reason and creates the `identity_excluded` Expected Difference (step 4 of AUTH-050), so the person isn't counted against parity. Reselecting revokes it. Selecting and deselecting happen only in a `draft`, and the reason is 1 to 500 characters. The Expected Differences are linked to the mapping and to the entry (`invitationId`), and a reselect revokes exactly those linked to the entry. None is created for a person already decided. A deselect marks nothing stale. A reselect requires the person to be `unmapped` and not held elsewhere (409) (ADR-0370).
4. Approval records the approver and immediately enqueues the send job. The endpoint Migration's `members` step never sends invitations; it only verifies.
   - The approval body carries `expectedToken` (a hash of the selected entry ids the operator confirmed; missing is 422) and may carry `expectedCount`. A changed selection or count is 409, and so is an empty batch. Entries whose person is no longer invitable are dropped with the reason "no longer a candidate (<status>)". The batch becomes `approved` in one conditional update, so of two concurrent approvals one is 409. The send step is enqueued after commit. If the queue is down, the approval stands and the next target inventory schedules it (JOB-030).
   - The job calls `POST /orgs/{org}/invitations` with `email`, `role: direct_member` and `team_ids` for teams that already exist.
   - It respects quota, stores `providerInvitationId`, marks each item `sent` or `failed` with an error, and sets the IdentityMapping to `pending_invite`. `targetIdentityId` stays null until acceptance.
   - If GitHub refuses because of an invitation rate or daily cap, the remaining items stay `selected`, and the job re-schedules itself 24 h later, or at the error's retry time when given (`nextAttemptAt`). A job that wakes early does nothing. The batch ends `sent`, or `partial` when an item `failed` or `expired`.
   - **Idempotent sending.** The claim stamps `sendStartedAt` and, in the same transaction, moves the mapping from `unmapped` to `pending_invite` and marks the Route stale. Anyone not `unmapped` fails the entry with `mapping_<status>`. A definitive refusal (`invalid`, `forbidden`, `conflict`, `unsupported`, `not_found`, `blocked_by_provider`) fails only that entry and gives the claim back. A rate limit on a first claim also gives it back. Any other error keeps the claim. An entry whose `sendStartedAt` is set never posts again and never fails. Instead it looks for its own invitation: the same normalized address, created at or after `sendStartedAt`, recorded on no other entry of the organization (pending before failed), then for a single member with that address. It records what it finds. Finding nothing makes the entry `unknown`: the person and the address stay held, the mapping stays `pending_invite`, and an operator resolves the entry as `invited` (→ `sent`) or `not_invited` (→ `failed`, mapping `unmapped`). Errors store the adapter's code and HTTP status, never provider text (ADR-0370).
   - **Revoke.** An operator revokes a `sent` entry through the job step `revoke` (`InvitationWriter.cancel`). The entry becomes `expired` (`revoked`), the mapping returns to `unmapped` and the Route is marked stale. If the provider no longer has the invitation and a member is the invitee, the entry is `accepted`; otherwise it is `expired` (`revoked_not_found`) (ADR-0370).
5. **Acceptance correlation**, at each inventory. GitHub's invitation API reveals the invitee login only in some cases, so:
   1. If a pending invitation disappeared and its `invitee.login` (when GitHub provided it) is now a member, link them: item `accepted`, mapping `confirmed`, method `invite`, `targetIdentityId` set. The login is stored on the entry while the invitation is still pending (`inviteeLogin`). Under `identityMatch.autoConfirmEmail`, exactly one member Identity with the invited email also links. A target already confirmed for another source is never handed out (ADR-0371).
   2. Otherwise, new org members that match no mapping are offered on the Identity mapping page as suggestions for `pending_invite` mappings. An operator confirms. A `sent` entry lists up to five members created after it was sent and not confirmed for anyone, an email match first (ADR-0370).
   3. Invitations that GitHub reports as expired or failed (`GET /orgs/{org}/failed_invitations`) → `expired`. They can be added to a new batch. The error is `failed:expired` or `failed:other`, and a failure report wins over a pending listing. Nothing else expires an invitation. An entry with no signal for seven days gets the error `unresolved` and a log line, and nothing else changes (ADR-0371).

   Correlation runs at the end of a target Endpoint's pass over every `sent` entry whose own target is that Endpoint. An entry without a provider id is first matched to its own invitation as in step 4. A provider fault leaves everything as it is (ADR-0371).
6. Nothing is ever invited outside an approved batch (AUTH-061).

**AUTH-061** is enforced three times and per target organization (ADR-0370):
- The API creates `approved` batches only through approval.
- The send job re-reads the batch under a row lock for every item. It stops unless the batch is `approved` or `sending` with an approver, and sends only `selected` items.
- Database triggers allow:
  - an entry to become `sent` only from `selected` in an approved batch;
  - `selected` and `deselected` only in a draft;
  - no changes to the email, teams, person, batch or Route of an approved batch's entries;
  - a batch to be inserted only as a draft and approved only with its approver;
  - no moves of a batch back to `draft`, from `sending` back to `approved`, or out of `sent`/`partial` (except `sent` to `partial`).

At most one invitation per person and per address is outstanding (`selected`, `sent` or `unknown`) in a target organization. Two partial unique indexes over `(targetEndpointId, …)` enforce this. The trigger sets the entry's target when the entry is created and then freezes it, and a uniqueness violation is answered 409 `conflict`. Approval drops entries whose Route now targets another Endpoint, and the send claim refuses them (`target_changed`).

Every invitation write takes the target Endpoint's invitation lock, then the Route mapping lock, then the batch row, the invitation row, the mapping row and Migration rows in id order. No provider call happens while a transaction is open.
