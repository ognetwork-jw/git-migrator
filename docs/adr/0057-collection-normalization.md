# ADR-0057: Declaring and normalizing keyed collections

- Status: agent-decided
- Date: 2026-10-08

## Context

ADP-021 requires every array to be a keyed collection or a sorted set of primitives, and `FacetDefinition.collections` is `CollectionKeySpec[]`, whose shape the spec does not give. T-012 (facet engine) and T-015 (canonical schemas) consume it.

## Decision

- `CollectionKeySpec = { path: string; key: string }`. `path` is a field path of plain names from the document root to the array (`/rules`, or `/rules/restrictPushes` for an array inside the elements of `/rules`). `DocumentSchema = { collections, sets? }`, where `sets` lists the paths of primitive-set arrays.
- **Strictness.** `normalizeDocument` returns a normalized deep copy or throws `CollectionError` listing all issues (`validateCollections` returns them without throwing): an array that is not declared (ADP-021 says every array must be one or the other), a declared path that is not an array, a non-object element, a missing, empty or unusable key, a **duplicate key** (never merged, never last-wins), non-primitive or non-finite set members, a non-JSON value, a non-object root. A bad declaration (duplicate path, path with selectors, empty key, a path declared as both) throws `CollectionSpecError`.
- **Key rendering.** Strings as is (empty is invalid), finite numbers and booleans in JSON form, `{ kind, id }` principals as `kind:id` (exactly those two members, non-empty). Keys that render equal collide, so `1` and `"1"` are duplicates. Case and Unicode normalization are not folded.
- **Order.** Keyed collections sort by rendered key in UTF-16 code-unit order (the order JCS uses). Sets are deduplicated and sorted with a total order `null < false < true < numbers < strings`; `-0` becomes `0`.
- **Nullable arrays.** `null` is a legal value of a declared collection or set (`PrincipalRef[] | null`: null = unrestricted, `[]` = nobody; `string[] | null` for deployment branches). It passes through unchanged and stays distinct from `[]` in normalization, hashing, `getAtPath` and `flattenDocument`.
- A member named `__proto__` is kept as an own property (outputs are built with `Object.fromEntries`), so normalization cannot change a hash. `flattenDocument` throws `duplicate_key` like `normalizeDocument`.
- Empty collections stay `[]`; absent ones stay absent; `undefined` members are dropped. The function is idempotent and does not mutate its input.
- `getAtPath` and `flattenDocument` address elements by key, so path-based comparison does not depend on array order.

## Alternatives

- Treating undeclared arrays as opaque: would let unordered arrays produce false parity differences.
- Last-wins on duplicate keys: hides driver bugs and makes parity depend on provider order.

## Affected requirements

ADP-021, ADP-020.
