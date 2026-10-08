# ADR-0086: `variables` and `secrets` carry a derived `key` field

- Status: agent-decided
- Date: 2026-10-08
- Task: T-015
- Affects: FAC-VAR, FAC-SEC, ADP-021

## Context

05-facets keys `variables` and `secrets` by `scope + name`. Core's collection key is a single element field (ADR-0057), so a composite key cannot be declared.

## Decision

Each element gains a required `key: string` equal to `<scope>/<name>` (`scopedKey(scope, name)`), and the collection is declared with key `key`. The schema rejects an element whose `key` differs from `<scope>/<name>`. `scope` must be `repository` or `environment:<name>`; `name` must not contain `/`, so the key is unambiguous (the name is the part after the last `/`). Field paths read `/variables[key=environment:prod/API_URL]/value`.

## Alternatives

- Key by `name` only: two scopes with the same name collide (`duplicate_key`).
- Nest variables under their scope: changes the spec's shape more and makes cross-scope comparison harder.

## Notes

Adapters compute `key` with `scopedKey`; `value` of a variable stays out of the key. Secrets never carry values.

## Case

Case is preserved. Environment names are case-insensitive on the target, so two scopes differing only by case are distinct canonical keys; T-054 must handle that (ADR-0088).
