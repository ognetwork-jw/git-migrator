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
4. **Last-admin guard.** `PATCH /actors/{id}` refuses (409, problem `last_admin`) any change that would leave no enabled `admin` Actor (service Actors count), whoever acts. The transaction runs at READ COMMITTED and takes `pg_advisory_xact_lock` on a fixed key first, then reads, counts and updates, so Actor changes run one at a time and each sees the committed result of the previous one. A SERIALIZABLE transaction was tried first and produced false conflicts (a 500) between unrelated demotions. Defence in depth: a SQLSTATE 40001 or 40P01 (on the error or its causes) that still reaches the app is a 409 `conflict`, never a 500. Self-disable stays a separate 409 `conflict`. Human roles still come from the sign-in method.
5. **Every error under `/api/v1` is `application/problem+json`.** A safety-net middleware rewrites any 4xx or 5xx that is not already a problem, by status (`bad_request` 400, `unsupported_media_type` 415, and the existing codes). Any `HTTPException` that is not a `ProblemError` is mapped by status in `onError`.
6. **RPC mount.** An operation the facade does not expose is a 404 problem, also inside `$transaction/sequential`. Every 5xx body from the RPC handler is a generic `internal_error` problem, and the problems the mount makes itself are served as `application/problem+json`. Failed database calls are reported through `createDb({ onError })` (not for policy rejections, missing rows or invalid input) and logged as error class, reason, model and SQLSTATE only (`safeErrorFields`). The RPC handler gets no `log` function: ZenStack builds its debug messages (the whole request, serialized) eagerly for a function sink, which turned a shared-reference request into a multi-second stall.
7. **Argument limits.** The clone refuses any object reached twice (shared references), more than 10,000 values and more than 1,000,000 string characters. `orderBy`, `by`, aggregates and `include`/`select` sub-queries may not use a read-denied field (`ApiKey.hash`), because sorting by it would reveal the order of the stored hashes.
8. **Validation.** An empty `PATCH` body and a non-future `expiresAt` are 422. `title` and `detail` of a problem are machine-facing; the UI renders `problem.<code>` from `en.json`.

## Alternatives

- Letting the audit follow an id change (record from and to): the cascade into foreign keys would still be unaudited, and nothing needs to rename these rows.
- Counting only human administrators in the guard: a service admin could then be the only admin that is able to act, so every enabled admin counts.
