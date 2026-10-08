# ADR-0201: How RPC mutations are audited

- Status: accepted (spec updated)
- Date: 2026-10-08
- Task: T-021
- Affects: AUTH-022, DOM-005, API-012, AUTH-021

## Context

AUTH-022 wants every RPC mutation to produce an `AuditEvent` through "a ZenStack client plugin (query hook)". DOM-005 denies every write to every model that API-012 does not list, so the plugin cannot write `AuditEvent` as an ordinary policy-checked write unless something allows it. ZenStack 3.9.7 keeps one plugin chain per transaction: inside a transaction, `$unuseAll()`, `$unuse()` and `$setAuth()` return clients that still run the original executor, so the policy plugin cannot be dropped for one write. Raw SQL is refused by the policy plugin ("non-CRUD queries").

## Decision

1. **Entity-mutation hooks, not `onQuery`.** The plugin (`packages/db/src/audit.ts`) uses `onEntityMutation` with `runAfterMutationWithinTransaction: true`. ZenStack then runs the mutation and the audit insert in one transaction (it opens one when none is active), so a mutation and its event commit or roll back together, including nested writes, `updateMany` and the array form of `$transaction`. `onQuery` runs outside the transaction of a sequential `$transaction` and sees only arguments, not rows. The hook is the "query hook" of AUTH-022 in effect.
2. **Installed on the policy client only.** `createDb` adds it after `PolicyPlugin` on the client behind `forActor`. `privileged` is not audited: jobs and custom endpoints write their own events (AUTH-022).
3. **One event per affected row.** `actorId` is the Actor, `action` is `rpc.<model_snake>.<create|update|delete>`, `subjectType` is the snake-case model, `subjectId` the primary key (composite keys joined by `:`), `data` is `{ via: 'rpc', changes: { <field>: { from?, to? } } }`. Updates list only changed fields (no-op updates give an empty diff); `createdAt` and `updatedAt` are left out. Column names are mapped back to field names.
4. **Redaction.** Values of fields, and of keys at any depth of a JSON value, whose name matches `secret|token|password|passwd|credential|authorization|api_?key|hash` are replaced with `[redacted]`. Strings and JSON longer than 2000 characters are replaced by `[omitted: N characters]`; Dates are ISO strings; bytes are a length.
5. **The write runs as the mutating Actor.** `AuditEvent` gets `@@allow('create', auth() != null && auth().disabled == false && actorId == auth().id)`, a narrow exception to DOM-005. The `forActor` facade exposes only the read operations of `auditEvent`, so no RPC caller can reach that rule; if something did, an Actor could only create events attributed to itself. There is still no update or delete, and the plugin skips `AuditEvent` itself, so it never audits its own writes.

## Alternatives

- `onQuery` plus a privileged client in a second transaction: not atomic; a failed audit write would leave an unaudited mutation, or a phantom event.
- A database trigger: needs the Actor id inside the transaction, which requires raw SQL that the policy plugin refuses.
- A sentinel system Actor with a create rule: `$setAuth` has no effect inside a transaction (see Context).
