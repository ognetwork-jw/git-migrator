# ADR-0055: Pure SHA-256 in `core`, and a strict RFC 8785 serializer

- Status: agent-decided
- Date: 2026-10-08

## Context

`FacetSnapshot.hash` and `ManualTask.paramsHash` are `sha256(JCS(value))` (DOM-001, 03-domain-model). `core` is pure (ARC-010, ARC-012: no I/O, depends on nothing) and its helpers are also needed by the web UI bundle. The spec does not say how `core` computes a digest, nor how RFC 8785 corner cases (unsafe integers, `undefined`, lone surrogates) are handled.

## Decision

- **Hashing.** `core` ships its own SHA-256 (`sha256.ts`, FIPS 180-4) instead of importing `node:crypto`. A digest is computation, not I/O, so `node:crypto` would be permitted by the purity rule, but a `node:` import would tie `core` to Node, break browser bundling and make `core`'s import list non-empty. The implementation is checked against `node:crypto` for every input length 0-200, the FIPS vectors and a 1 MB input. An architecture test fails if any `core` file imports anything other than a sibling file.
- **Serializer.** `canonicalize` follows RFC 8785: members sorted by UTF-16 code units, numbers by ECMAScript Number-to-string (`-0` becomes `0`), strings escaped as `JSON.stringify` does. It is strict and throws `CanonicalJsonError` (with a JSON Pointer) instead of altering the value:
  - `NaN`, `Infinity`: error (RFC 8785 section 3.2.2.3).
  - `bigint`, `symbol`, function, `Date`, `Map`, class instances: error. Callers convert explicitly.
  - `undefined` as an **object member**: omitted (an absent optional field hashes like a missing one). `undefined` or a hole **in an array**: error.
  - Lone surrogates in strings or keys: error (I-JSON).
  - Cycles: error. Depth over 512 (configurable): error.
  - Integers beyond +-(2^53 - 1): **allowed by default**, serialized as the double the engine holds (as the RFC specifies, and as `JSON.parse` already rounded them). `{ unsafeIntegers: 'reject' }` is available for callers that must not lose precision; such values should be strings.
- `hashCanonical(value)` = lowercase hex `sha256(JCS(value))`.

## Alternatives

- `node:crypto`: smaller code, but ties `core` to Node (see above).
- Silently dropping or coercing unsupported values (`JSON.stringify` behavior): two different documents could hash equal.
- Rejecting unsafe integers by default: not RFC-conformant, and would reject legitimate provider ids that arrive as doubles.

## Affected requirements

DOM-001, ARC-012, ADP-021 (stable hashing of normalized documents).
