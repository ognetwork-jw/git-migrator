# ADR-0371: Acceptance correlation and expiry at inventory

- Status: accepted (spec updated)
- Date: 2026-10-09
- Task: T-085
- Affects: AUTH-060 (step 5), AUTH-050 (step 1, step 2), JOB-030, LIF-021

## Context

AUTH-060 step 5 says acceptance is correlated at each inventory, but GitHub reveals the invitee login only in some cases and lists an invitation as expired only through `failed_invitations`. A pending invitation created by e-mail has no login. After acceptance the pending list no longer shows it, and the matching cascade cannot decide the mapping (`pending_invite` is a decision it never overwrites).

## Decision

At the end of an inventory pass of a Route's **target** Endpoint (after the Identities are up to date and the matching cascade has run), `correlateInvitations` looks at every `sent` entry of the Route's batches. It calls `listPending` and `listFailed` only when such entries exist, and compares:

1. **Failed.** An entry whose invitation id is in `listFailed` becomes `expired` with the error code `failed:expired` or `failed:other` (provider text is never stored); this wins even when the provider still lists it as pending. The mapping returns from `pending_invite` to `unmapped`, so the person is a candidate for a new batch.
2. **Still pending.** The entry stays `sent`. If the provider reports an invitee login, it is stored on the entry (`invitee_login`) so it survives the invitation disappearing.
3. **Gone from the pending list.** If the stored invitee login is now a member, or (only under the Route's `identityMatch.autoConfirmEmail` policy, because it is the same trust as AUTH-050 step 2.1) exactly one member Identity has the invited e-mail as its public e-mail, the entry becomes `accepted` and the mapping `confirmed`, method `invite`, with that Identity as target. A target that another source already holds confirmed is never handed out again (ADR-0320); the entry then stays `sent`. Otherwise nothing is guessed and the operator sees the new members as suggestions (ADR-0370, point 10).
4. **Nothing else expires an invitation.** Only the provider's own report does (point 1; the provider lists an invitation that ran out after 7 days as failed, and the fake does the same), or an explicit revoke (ADR-0370). An invitation that is gone from the pending list without a failure record and without a nameable invitee stays `sent` and the mapping stays `pending_invite`: it may have been accepted by someone this system cannot see (a private address). After seven days without a signal the pass records the error `unresolved` on the entry (visible in the batch) and logs `invitation.unresolved`, once per pass, and changes nothing else. The operator resolves it by confirming a suggested member or by revoking.

Every mapping move marks the Route's Analyses stale in the same transaction (ADR-0310) and publishes `invitation.updated` and `migration.updated`. A provider fault during correlation is logged by class only and leaves everything as it is; the next pass tries again. The same pass schedules the send step of every `approved` or `sending` batch whose `next_attempt_at` has passed, so a lost enqueue or a restart never strands an approved batch.

## Alternatives

- Linking only by login, as the spec words it: rejected, invitations by e-mail never expose a login, so acceptance would never be detected without an operator for each person.
- Expiring on absence or on a seven-day clock: rejected, it expired invitations that had been accepted by members the system could not match, and released their mapping.
- A separate scheduled job for correlation: rejected, the members it compares against are only fresh right after an inventory pass.

## Addendum (round 1 review)

The acceptance and expiry writes take the Route mapping lock first (ADR-0370 lock order), and the e-mail link is skipped when several members share the address.

## Addendum (round 3 review)

A `sent` entry without a provider id (an operator resolved an unknown outcome as `invited`) is first matched to its own invitation by `findOwnInvitation`: the same normalised address, created at or after its first attempt (`send_started_at`, else `sent_at`), recorded on no other entry of the same target organization (ADR-0370, Round 3 review). A pending match stores the id and the invitee login, a failed match expires the entry as in point 1, and without a match the entry goes through point 3 and the unresolved report of point 4.

## Addendum (round 4 review)

Correlation looks at every `sent` entry whose own `target_endpoint_id` is the Endpoint just inventoried, on every Route, including one that has since moved to another target. It takes the Endpoint's invitation lock before the Route lock (ADR-0370).
