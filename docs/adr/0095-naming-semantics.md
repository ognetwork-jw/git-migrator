# ADR-0095: Naming pipeline semantics, validation and collision keys

- Status: accepted (spec updated)
- Date: 2026-10-08
- Task: T-013
- Affects: LIF-030, LIF-031

## Context

LIF-030 lists the pipeline ops, precedence and the limits check, but is silent on several details: which source field each init op reads, argument rules for `truncate`, `replace` semantics, what happens to a step that uses an uninitialized variable, "reserved names", and how "case-insensitive" collisions treat Unicode.

## Decision

- **Init ops** (`projectKey`, `slug`, `name`) only apply to `namespace`, `repository` and `group`. They read `key`, `slug`, `name` of the same-named source object. A missing object or an absent/empty field is a pipeline error (`naming.invalid`, reason `pipeline`), never an empty string. Transform ops on a variable that has not been initialized, and templates naming an uninitialized variable, are pipeline errors.
- **`truncate`** needs an integer `arg >= 1` and counts code points. **`replace`** replaces every match of an RE2 pattern (case-insensitivity via `(?i)`); see the next item.
- **ReDoS (round 2 decision):** `replace` runs on repository names a source user can influence, so patterns execute on `re2js` 2.8.6 (pure-JavaScript RE2, linear time, no I/O, pinned exactly, see ADR-0002; the only external dependency of `core`). RE2 syntax has no back references or lookarounds; those fail to compile and become an `unsafe-pattern` pipeline issue. `with` uses RE2J replacement syntax, **not** `String.replace`: `$1` (group number), `$<name>` (named group) and `$$` (a literal `$`); `$&`, `${1}`, `${name}` and a lone `$` stay literal. Unresolved references are rejected at compile time (`unsafe-pattern`): `$n` must satisfy 1 <= n <= the pattern's group count (digits are read greedily, so `$10` needs ten groups, and `$0` is rejected), and `$<name>` must name a group of the pattern. Further bounds: pattern and `with` at most 200 characters, the empty pattern is rejected, source values are capped at 256 code points and so is every variable after every step (`input-too-long`), so a replace chain cannot grow a value. `validateReplacePattern` and `compileReplacePattern` are exported for config validation and previews. `runNamingPipeline` never throws: any unexpected fault becomes a `pipeline` issue with cause `internal`.
- **Empty and edge results:** a variable that becomes empty after any step is a pipeline error (`empty-result`), and a pipeline-generated name that starts or ends with `-`, `_` or `.` is a pipeline error (`edge-separator`). Overrides are exempt from the edge-separator rule.
- **Pipeline issues carry a `cause` code** (plus `variable`/`op`) in `params`; the English `message` is developer-only and is not copied into finding params. Guidance renders from `code`, `reason`, `cause` and params.
- **Template** placeholders are `{var}`; there is no escape syntax (braces are never valid in a target name anyway).
- **Override** (repository scope) is used verbatim and validated like any other name. An empty-string override counts as unset.
- **Validation** runs against `{maxLength, pattern, caseInsensitiveUnique}` (the adapter contract's `repositoryName`), reporting every violated rule at once. Length counts code points. `.` and `..` are always reserved, and a trailing `.git` (case-insensitive, judged after NFKC so fullwidth forms count; `collisionKey` strips it after NFKC as well) is always rejected so core fails safe without adapter input; `NamingLimits` also accepts optional `reservedNames` and `reservedSuffixes` (case-insensitive) so an adapter can add provider rules without core knowing them. The contract's `ProviderLimits.repositoryName` does not carry these yet (follow-up: adapter-contract change, which an implementor cannot make in the spec).
- **Collision key:** a single trailing `.git` is dropped, then (case-insensitive targets) lowercase, NFKC, upper-then-lower (so `ß` meets `SS`) and NFKC again. Case-folding follows the target's `caseInsensitiveUnique` flag: this is a deliberate reading of LIF-031's "case-insensitively", which core takes from the limit rather than hard-coding. Case-sensitive targets only normalize. Groups are sorted by key and members by id for determinism. Invalid names take no part in collisions. Every group is reported and every member is blocked.
- **Existing targets:** looked up by `targetRepositoryId` first; when that id is set but not found among the existing targets, the lookup falls back to the planned name. A target found by id is `owned` only if no *different* repository holds the planned name; otherwise the result is the blocker `target.exists-nonempty` (with `ownedTargetId`). This deliberately narrows spec 06 analysis step 3 ("an owned target never raises `target.exists-*` blockers"): ownership of one repository cannot excuse a different repository holding the planned name. Several existing targets sharing the key also fail safe as `exists-nonempty` (`ambiguous`).
- **Ownership across Migrations (new finding code `target.owned-by-other-migration`):** `planRouteNaming` collects the `targetRepositoryId`s claimed by the Route's Migrations. The same id on two Migrations, or a name match on a target claimed by another Migration, blocks every Migration involved with this code (guidance needed). Otherwise: Non-empty (has refs) gives `target.exists-nonempty`; empty gives the informational `target.exists-foreign-adopted`.

## Alternatives

- Static ReDoS checks on JavaScript regular expressions: tried in round 1 and rejected, they cannot be made complete. Literal `with`: rejected, capture groups are useful for renames.
- NFC only: rejected, compatibility forms (full-width letters) would slip through; the strict charset makes this moot on GitHub but not on other targets.

## Consequences

`packages/core/src/naming.ts` is pure and provider-neutral; the Analysis job (T-050+) feeds it source objects, limits and existing targets.
