# ADR-0056: Field path escaping and Expected Difference pattern semantics

- Status: agent-decided
- Date: 2026-10-08

## Context

ADP-020 shows paths such as `/rules[pattern=main]/blockForcePush` and `/refs[name=refs/heads/main]/target`, and patterns with `*` and `**`, but not how names or key values containing `/`, `]`, `=`, `*` or `\` are written, what a bare collection name means in a pattern, or what `**` adds to "equals or lies beneath".

## Decision

- **Grammar.** `path = "" | ("/" segment)*`; `segment = name | name "[" field "=" value "]"`. The empty string is the root; `/` is one segment with an empty name. A value runs to the first unescaped `]`, so it may contain `/`, `=` and `[`.
- **Escapes** (backslash plus the character). Names: `\ / [ ] *`. Selector fields: `\ = [ ] / *`. Values: `\ ] *`. Every string has exactly one rendering and any other escape or a dangling backslash is an error. Unicode is not normalized; `é` and `é` are different keys.
- **`*` is always escaped when formatting a concrete path**, so a concrete path used as a pattern matches only itself and what lies beneath it, and a branch rule whose pattern is literally `*` is `/rules[pattern=\*]`. When parsing a *concrete* path an unescaped `*` is read as a literal (lenient on input; `canonicalFieldPath` re-renders it escaped). `patternForPath(path)` is the only sanctioned way to turn a concrete path into a pattern (the same string means a literal in `parseFieldPath` but a glob in `parsePathPattern`); `applyLossyPolicies` uses it.
- **Patterns** (`parsePathPattern`): `*` as a whole selector value (any value, including empty and values containing `/`), `prefix*` as a trailing glob, `\*` as a literal star, and `**` as the entire final segment. Everything else is an **error, not a literal** (`/a*`, `/a[k=x*y]`, `/a[k=**]`, `/**/x`, `/*/x`, wildcards in names or selector fields): a mistyped pattern is reported rather than silently masking nothing. The empty pattern is an error, since the root would mask every difference; masking everything is written `/**`.
- **Matching** (`matchesPattern`): the pattern's segments must be a prefix of the path's segments (equals or beneath). Names compare exactly. A pattern segment with a selector matches only a path segment with the same name, the same field and a matching value; a pattern segment **without** a selector matches only a path segment without one (`/hooks` does not match `/hooks[url=x]`; write `/hooks[url=*]`). A pattern longer than the path never matches, so a difference at an ancestor is not masked by a pattern about one of its fields. `**` matches zero or more further segments. Since "beneath" is already implied it changes nothing, and exists to make intent explicit (`/hooks[url=*]/**` also matches the hook element itself, which a whole-element add/remove diff needs).

## Alternatives

- JSON-Pointer `~0`/`~1` escapes: they do not help the bracketed value, where `/` is allowed unescaped.
- A bare collection name matching all elements: broader than the spec's examples and masks more than intended; the explicit `[key=*]` form is available.
- Lenient pattern parsing (unknown wildcard forms literal): hides typos.

## Affected requirements

ADP-020, LIF-063 (Expected Difference matching), FAC-005 (policy-created differences).
