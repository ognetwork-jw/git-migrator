# ADR-0202: RPC primary keys, the last-admin guard, error shapes and argument limits

- Status: agent-decided
- Date: 2026-10-08
- Task: T-021 (review round 1)
- Affects: AUTH-022, AUTH-021, AUTH-020, API-011, API-012; amends ADR-0200 and ADR-0201

## Context

Review of T-021 found: an RPC update could change a primary key, so an audit event named the new id and the `ON UPDATE CASCADE` rewrote foreign keys with no event; the last administrator could be demoted or disabled; some `/api/v1` errors were `text/plain`; the RPC mount answered an unexposed operation with a 500 that echoed an internal message; sorting by `ApiKey.hash` leaked the order of hashes; and a SuperJSON shared-reference DAG made the argument clone take exponential time.

## Decision

1. **Primary keys are immutable through RPC.** `id` carries `@deny('update', true)` on every RPC-writable model (`Wave`, `NamingRule`, `WebhookAllowlistEntry`, `Overlay`; `Migration` and `ManualTask` already had it). An audit subject id therefore never changes.
2. **Delete events name cleared rows.** Deleting a `Wave` clears `Migration.waveId` through `ON DELETE SET NULL`, which fires no hook. The `rpc.wave.delete` event data lists `clearedMigrationIds`, read in the same transaction before the delete.
3. **The audit plugin fails closed.** A mutation whose client has no Actor id throws, which rolls the mutation back.
4. **Last-admin guard.** `PATCH /actors/{id}` refuses (409, problem `last_admin`) any change that would leave no enabled `admin` Actor (service Actors count), whoever acts, in a serializable transaction. Self-disable stays a separate 409 `conflict`. Human roles still come from the sign-in method.
5. **Every error under `/api/v1` is `application/problem+json`.** A safety-net middleware rewrites any 4xx or 5xx that is not already a problem, by status (`bad_request` 400, `unsupported_media_type` 415, and the existing codes). Any `HTTPException` that is not a `ProblemError` is mapped by status in `onError`.
6. **RPC mount.** An operation the facade does not expose is a 404 problem. Every 5xx body from the RPC handler is a generic `internal_error` problem; the status is logged without the message.
7. **Argument limits.** The clone refuses any object reached twice (shared references), more than 10,000 values and more than 1,000,000 string characters. `orderBy`, `by`, aggregates and `include`/`select` sub-queries may not use a read-denied field (`ApiKey.hash`), because sorting by it would reveal the order of the stored hashes.
8. **Validation.** An empty `PATCH` body and a non-future `expiresAt` are 422. `title` and `detail` of a problem are machine-facing; the UI renders `problem.<code>` from `en.json`.

## Alternatives

- Letting the audit follow an id change (record from and to): the cascade into foreign keys would still be unaudited, and nothing needs to rename these rows.
- Counting only human administrators in the guard: a service admin could then be the only admin that is able to act, so every enabled admin counts.
