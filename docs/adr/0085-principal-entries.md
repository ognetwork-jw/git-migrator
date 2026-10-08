# ADR-0085: Principal lists are keyed collections of `{ principal }`

- Status: accepted (spec updated)
- Date: 2026-10-08
- Task: T-015
- Affects: FAC-001, ADP-020, ADP-021, 05-facets (`restrictPushes`, `restrictMerges`, `forcePushExempt`, `deletionExempt`, `CodeOwnership.principals`, `Teams.members`)

## Context

05-facets types these fields as `PrincipalRef[]` (elements `{ kind, id }`). ADP-020 says arrays of `PrincipalRef` are keyed collections with key `principal`, addressed as `restrictPushes[principal=identity:42]`. Core's `CollectionKeySpec.key` names a *field of the element* (ADR-0057), and a bare `{ kind, id }` element has no `principal` field, so `normalizeDocument` rejects it (`missing_key`). `grants` and `members` already have a `principal` field and are unaffected.

## Decision

Every `PrincipalRef[]` field is stored as `PrincipalEntry[]` with `PrincipalEntry = { principal: PrincipalRef }`, declared as a collection with key `principal`. Nullability is unchanged (`PrincipalEntry[] | null`, null = unrestricted, `[]` = nobody). `PrincipalRef` itself is exactly `{ kind: 'identity' | 'group'; id: string }`. This makes the documented path form work with core as is.

## Alternatives

- Bare `PrincipalRef[]` plus a key spec: cannot be expressed with core's key field; normalization would reject real documents.
- Add an element-self key to core: core belongs to T-011/T-012; a later change could still allow the bare form and a migration of the schema version.

## Notes for the orchestrator

Spec text for these fields should read `PrincipalEntry[]` (or note the wrapper). Adapters and facets (T-050 and later) write `{ principal: { kind, id } }`.
