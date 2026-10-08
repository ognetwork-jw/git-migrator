# @git-migrator/core

Pure domain primitives: field paths, collection normalization, canonical hashing, Expected Difference
patterns, the lifecycle state machine, readiness and Route-policy resolution. No I/O, no provider
vocabulary, no internal dependencies (ARC-012). Everything is exported from `src/index.ts`; the
package is consumed as source. Decisions are recorded in ADR-0055 to ADR-0059.

Declared internal dependencies (ARC-012, checked by `pnpm lint`): none.

## Field paths and patterns (ADP-020)

```ts
parseFieldPath('/rules[pattern=main]/blockForcePush')
// [{ name: 'rules', key: { field: 'pattern', value: 'main' } }, { name: 'blockForcePush' }]
formatFieldPath([itemSeg('refs', 'name', 'refs/heads/main'), seg('target')])
// '/refs[name=refs/heads/main]/target'
```

- `''` is the root. A selector value runs to the first unescaped `]`, so it may contain `/` and `=`.
- Escapes: names `\ / [ ] *`, selector fields `\ = [ ] / *`, values `\ ] *`. `formatFieldPath` always
  escapes `*`, so a literal `*` key is `[pattern=\*]` and a concrete path never acts as a wildcard.
- Functions: `parseFieldPath`, `formatFieldPath`, `joinFieldPath`, `canonicalFieldPath`, `isFieldPath`,
  `seg`, `itemSeg`; errors are `FieldPathError` (with the failing index).
- `patternForPath(path)` is the only way to turn a concrete path into a pattern (escapes `*`); never store a raw path as a pattern.
- Patterns: `parsePathPattern`, `matchesPattern(pattern, path)`, `compilePattern`, `findMatchingPattern`.
  `*` is a whole selector value or a trailing glob (`[name=refs/heads/git-migrator/*]`), `**` is the
  entire final segment. A pattern matches a path that equals it or lies beneath it; a pattern longer
  than the path never matches; `/hooks` does not match `/hooks[url=x]`. Any other wildcard, and the
  empty pattern, is an error.

## Keyed collections (ADP-021)

```ts
const schema = { collections: [{ path: '/rules', key: 'pattern' }], sets: ['/labels'] };
normalizeDocument(doc, schema);      // sorted deep copy, or throws CollectionError
validateCollections(doc, schema);    // CollectionIssue[] without throwing
getAtPath(doc, '/rules[pattern=main]/enabled');
flattenDocument(doc, schema);        // Map<path, leaf>, independent of array order
```

Every array must be a declared keyed collection or a declared primitive set; duplicate, missing or
unusable keys are errors. `null` is allowed for nullable arrays and stays distinct from `[]`. Keys render as strings, numbers, booleans or `kind:id` principals; order is
UTF-16 code-unit order. `renderKeyValue` exposes the rendering.

## Canonical JSON and hashing (RFC 8785)

`canonicalize(value, { unsafeIntegers?, maxDepth? })` is a strict JCS serializer (throws
`CanonicalJsonError` on `NaN`, `Infinity`, `bigint`, lone surrogates, cycles, `undefined` array
elements, non-plain objects; omits `undefined` members). `hashCanonical(value)` returns the hex
`sha256(JCS(value))` used for `FacetSnapshot.hash` and `ManualTask.paramsHash`. `sha256Hex` is a pure
implementation (no `node:crypto`).

## Lifecycle (LIF-001 to LIF-003)

```ts
const r = transition(state, { type: 'run_started', kind: 'migrate' });
if (r.ok) { r.state; r.effects; r.changed } else { r.error.code /* not_permitted | inconsistent_state | invalid_event */ }
// r.deferred === true: source_missing while running; accepted, no change; re-send after run_finished
```

`transition` is the table in `docs/spec/06-migration-lifecycle.md`: every listed pair is accepted,
every unlisted pair is rejected as a value for the caller to log. `effects` (`recompute_readiness`,
`set_verified_at`, `set_source_read_only_applied`, `reset_flags`) are data for the caller to apply.
`revoke_complete` without parity restores the last Run outcome (`lastRunStatus`), never `verified` (LIF-075). `transitionOrThrow`, `initialLifecycleState`, `isUnmigrated`, and the `MIGRATION_STATUSES`,
`RUN_KINDS`, `RUN_OUTCOMES`, `LIFECYCLE_EVENT_TYPES` constants complete the module.

## Readiness (LIF-004)

`deriveReadiness({ analysis, runBlockers, tasks })` returns `{ readiness, counts, blockerCodes }`:
`blocked` for any analysis or run-origin blocker, `needs_attention` for an open `pre` task, else
`ready`. Post tasks never count toward readiness.

## Fidelity and Route policies (ADP-040, FAC-005)

`resolveRoutePolicies(config)` validates and defaults a Route's policies. `applyLossyPolicies(facetKey,
decisions, policies)` returns the decisions with `accepted` set, the `<facet>.accept-lossy` pre tasks
(one per unaccepted policy key) and the `lossy_accepted` Expected Differences to record (deduplicated
by facet and path). `fidelityEffect` states what each fidelity means for the plan.

## Tests

Test names carry the requirement ID. The lifecycle suite generates the full status x event
cross-product against an independently written copy of the spec table. Coverage target: 90% lines and
branches (TST-005); an architecture test fails if a `core` file imports anything but a sibling file or
uses provider vocabulary (GLO-002).
