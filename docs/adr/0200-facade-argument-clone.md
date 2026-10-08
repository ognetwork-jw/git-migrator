# ADR-0200: The policy facade passes ZenStack a deep clone of its arguments

- Status: accepted (spec updated)
- Date: 2026-10-08
- Task: T-021
- Affects: AUTH-021, API-012; amends ADR-0122 item 9

## Context

ADR-0122 item 9 made `forActor` an allow-list facade whose delegates walk their arguments, refuse anything that is not data, and then pass the *original* arguments to ZenStack. T-010's review (round 5) found in-process bypasses of that inspect-then-pass design. T-021 is the first task to mount `forActor` (the RPC handler), so they are fixed here:

- `Date`, `Decimal` and `Uint8Array` leaves returned early from the walk, so `Object.assign(new Date(), { $expr: fn })` reached the expression builder (raw SQL beneath the policy plugin).
- A forged prototype (`Object.create(Date.prototype)` plus `$expr`) passed the same early return, and a `Proxy` answered the walk's traps differently from ZenStack's later `[[Get]]` and `for...in` reads.
- ZenStack reads delegate arguments lazily, so a caller could swap `args.where` for `{ $expr }` between the call and the `await`.
- Errors that are not `ORMError`s (thrown by a callback, or a driver error ZenStack did not wrap) passed through unchanged and could carry `sql`, `sqlParams` or node-postgres fields.

None of this is reachable over RPC (the body is JSON), but any in-process caller of `forActor` is affected.

## Decision

1. **Clone, then pass only the clone.** The walk is replaced by `cloneData`, which validates and builds a fresh plain-data deep clone in one pass. Only the clone is handed to the ZenStack delegate. The caller keeps no reference into what ZenStack reads, so a later edit of its arguments has no effect.
2. **Refuse Proxies first.** `util.types.isProxy` is checked before anything else touches an object, so no trap runs at all.
3. **Exact types, rebuilt.** A leaf is accepted only when its prototype is exactly `Date.prototype`, `Decimal.prototype` or `Uint8Array.prototype` (`Buffer.prototype` is accepted for bytes) *and* it has the real internal brand (`types.isDate`, `types.isUint8Array`, `instanceof Decimal`). Any own key beyond the type's own (a Decimal has exactly `constructor`, `s`, `e`, `d`; a Date has none; a Uint8Array has only its indices) is refused. The clone is built from the internal value: `new Date(+d)`, `new Decimal(d.toString())`, a fresh `Uint8Array`. Plain objects and arrays are copied with `defineProperty`, so no setter runs and no key can change the clone's prototype; an own key named `__proto__` is refused.
4. **Unchanged refusals.** Functions, class instances, Maps, Sets, symbol keys, accessors, cycles, depth over 64 and any key named `$expr` stay refused, with the same `invalid-input` error.
5. **`$transaction` options** are cloned too, and only `isolationLevel` with a known value is accepted.
6. **Error sanitizing.** An error that is not an `ORMError` but carries `sql`, `sqlParams`, `parameters`, `dbErrorMessage` or a node-postgres field (`severity`, `detail`, `hint`, `schema`, `table`, `column`, `dataType`, `constraint`, `internalQuery`, `routine`, `position`), on itself or anywhere in its `cause` chain (up to six links), is rethrown as the same generic `db-query-error` as a wrapped driver error, keeping only a five-character SQLSTATE as `dbErrorCode`. Every other error still passes through, because a callback's own domain errors must reach its caller.

## Alternatives

- Keep walking and freeze the arguments: a Proxy or getter defeats freezing, and it leaves the early returns.
- Deep-clone with `structuredClone`: it accepts Proxies' targets silently, loses Decimal and class identity, and throws opaque errors.
- Map every non-`ORMError` to a generic error: it would hide a callback's own errors from its caller.
