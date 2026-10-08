# ADR-0222: Bitbucket source read-only apply and undo

- Status: agent-decided
- Date: 2026-10-08
- Task: T-032
- Affects: LIF-070, LIF-045, LIF-042, ADP-012

## Decision

- **Order and idempotency.** `apply` first reads the repository (a missing one is `not_found` and nothing is written), then adds the `push` restriction on `*`, then re-reads the repository and writes the description from that fresh read (so an edit made meanwhile is not overwritten). A description already starting with the prefix is not rewritten; an older `[MIGRATED → …] ` prefix is replaced.
- **Ownership is never inferred from the shape of the state.** When an identical restriction or the prefixed description already exists, `apply` writes nothing and returns a record with `resourceRef.adopted: true` and `before` equal to `after`. `undo` of an adopted record is a no-op (a warning is logged): a user's own lock, or Run 1's legitimate lock seen by Run 2, is never deleted or stripped. Only writes this `apply` made, including lost-response writes confirmed by read-back, are reversed. Cross-attempt matching of earlier records is not possible without changing the `SourceLock` interface, so it is skipped.
- **Guarded `PUT`.** Only `{ description }` is sent, with `retry: false`; the repository is read again; if `is_private`, `fork_policy`, project key or main branch changed they are restored and the step fails `conflict`; a changed name or an unreadable repository fails without a restore: a rename changes the slug, so the old path no longer addresses the repository and the adapter cannot safely `PUT` the old name back. LIF-070 lists `name` among the fields to restore; this is the one deviation, and the step fails with `conflict` and a message saying a manual repair is needed.
- **Partial results.** `SourceLock.apply` returns records only on success, so a failure after a write would lose the Mutation. The adapter throws `SourceLockPartialError` (an `AdapterError`) carrying `mutations`; the runner must record them before failing the step (LIF-042). The description mutation is recorded as soon as the `PUT` succeeded, even if verification then fails.
- **Ambiguous writes.** If the `POST` or `PUT` fails in any way (timeout, 5xx, reset), the adapter reads the state back with its own `AbortSignal.timeout(30_000)`, independent of the Run signal, so a cancelled Run still records an applied write. When the write took effect it is recorded (not adopted) and thrown in `SourceLockPartialError`, so undo reverses it. If the read-back itself fails, the error still is a `SourceLockPartialError`, with the write named in `possiblyApplied`; the runner should treat it as maybe applied and run undo or a manual check.
- **Undo** refuses a mutation recorded for another repository (`invalid`).
- **Undo** deletes the restriction by id (404 is success) and restores the description: the original when it still equals what we wrote, else only the prefix is removed, so later edits survive. Undo is idempotent.
- Writes use `retry: false` and are never captured.

## Alternatives

Description first: leaves the repository writable longer. Rolling back inside `apply`: could fail too and hide the original error.
