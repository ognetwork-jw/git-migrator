# ADR-0372: The `invitations.batch` job and `InvitationWriter.cancel`

- Status: accepted (spec updated)
- Date: 2026-10-09
- Task: T-085
- Affects: JOB-010, JOB-011, JOB-013, ADP-010 (InvitationWriter), AUTH-060

## Context

JOB-010 lists the queues and their jobs, and none carries the send job that AUTH-060 step 4 requires. The revoke flow that ADR-0320 delegates to T-085 needs a provider call the `InvitationWriter` of `04-adapter-contract.md` does not offer (`invite`, `listPending`, `listFailed` only).

## Decision

1. One job, `invitations.batch`, rides the existing `maintenance` queue (worker-standard, 2 slots; the work is short and rate limited by the provider anyway). Its payload is a strict union on `step`: `{step: 'seats', batchId}`, `{step: 'send', batchId}` and `{step: 'revoke', batchId, invitationId}`, IDs only (JOB-011). It uses the default 3 attempts with backoff (JOB-013); every step is idempotent (ADR-0370). `JobRuntime.enqueueInvitationStep` deduplicates immediate steps per batch (`invitations-<step>-<batchId>[-<invitationId>]`) and gives every delayed step an id of its own (`-later-<due time in ms>`), so a second reschedule from inside the running job is not dropped as a duplicate of the first. A send step woken before `next_attempt_at` schedules itself again for the remaining wait. A new queue was not added: it would change the queue table, the worker roles, the metrics and the Helm values for three short steps.
2. Jobs reach the provider only through the injected `EndpointConnector` (ARC-012), with the `interactive` quota pool, because an operator asked for the work (JOB-020). Every call goes through the adapter's `ProviderHttpClient` and the quota service.
3. `InvitationWriter` gains `cancel(providerInvitationId): Promise<{cancelled: boolean}>`. The GitHub adapter implements it with `DELETE /orgs/{org}/invitations/{id}` (listed in `docs/providers/github.md`, Members); a 404 is `cancelled: false`, not an error, and an id that is not numeric is refused before any request.
4. `listPending` gains an optional `createdAt` and `listFailed` optional `createdAt` and `failedAt` (GitHub: `created_at`, `failed_at`). The send retry, the correlation and revoke use `createdAt` to tell an entry's own invitation from an older one for the same address (ADR-0370, Round 3 review). The fields are optional, so the contract of `04-adapter-contract.md` still holds for an adapter that cannot tell.
5. The inventory handler gets an optional `scheduleInvitation` dependency, through which the pass wakes the send step of approved batches (ADR-0371); the worker passes `JobRuntime.enqueueInvitationStep`.

## Alternatives

- A new `invitations` queue: see point 1.
- Revoking by deleting the invitation from the API process: rejected, it has no provider access.
- No revoke flow, leaving `pending_invite` until the 7 days pass: rejected, a mistaken invitation would stay for a week and the operator could not correct the mapping.
