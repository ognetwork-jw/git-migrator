# ADR-0155: change-requests facet: blocker parameters and desired state

- Status: accepted (no spec change needed)
- Date: 2026-10-08
- Task: T-055
- Affects: FAC-CRQ, FAC-002, UI-040

## Context

FAC-CRQ says any open source Change Request raises blocker `change-requests.open` "with params
listing them", and that `compareMode` is `none`. It does not say:

- which parameters the blocker carries (the guidance entry in `packages/guidance` uses `count` and `ids`,
  where `ids` is "identifiers and titles", see `params.ts`);
- what happens to the list when there are more items than a guidance `list` parameter accepts
  (1 to 500 items, `MAX_LIST_LENGTH`);
- how a title with control characters or a very long title is shown (guidance text forbids control
  characters and caps text at 1024 characters, so an unchecked title makes the parameter invalid);
- which `desired` document the facet produces, since nothing is migrated.

## Decision

- `translate` raises one blocker per Route analysis when `open` is not empty, with path `/open` and
  params `{ count, ids }`. `count` is the total number of open Change Requests.
- `ids` holds one label per Change Request, `<id>: <title>`. The title is omitted when blank. A blank
  id falls back to the URL. Each run of the characters the guidance validator refuses, and of
  whitespace, becomes one space. That set is exactly `hasForbiddenCharacter` in
  `packages/guidance/src/template.ts`: C0 (U+0000-U+001F), DEL (U+007F), C1 (U+0080-U+009F), U+2028,
  U+2029, U+202A-U+202E and U+2066-U+2069. Other format characters, such as the zero-width joiner in
  emoji sequences, are kept. Lone surrogates become U+FFFD, so the text is well formed. The id is cut
  at 100 code points, the title at 200 and the URL at 300, so a label stays within the guidance text
  limit of 1024 UTF-16 units. A label that is blank after cleaning is dropped.
- The set is kept in sync with the validator by a table-driven test in `testing/integration`
  (`facets-cr-extras-guidance.test.ts`). It runs hostile titles and ids (bidi override and isolate, C1,
  U+2028, lone surrogate, 5000 characters, 300 astral characters, markdown with backticks and links, NUL)
  through `translateChangeRequests` and `renderGuidance`, and asserts that `problems` is empty.
- `ids` is cut at 500 entries (`MAX_LISTED`). `count` still carries the real total.
- `count` can therefore exceed the number of listed entries, for two reasons: the 500-entry cap, and
  dropped blank entries. The guidance text reads the total from `count`, not from the list length.
- `desired` is `{ open: [] }`: no Change Request is migrated.
- `compareMode` is `none` (from the spec), so `compare` is never called. It is still declared, as the
  engine requires the member, and returns no diffs.
- The facet declares no `isTaskSatisfied`: it has no `parity` completion code, so no task can be
  satisfied by parity. The registry only requires the predicate for `parity` codes.
- The facet is in scope (`inScope: true`), since it is blocking only.

## Alternatives

- One blocker per Change Request: rejected, the spec describes one blocker with a list, and a Route with
  hundreds of open requests would produce hundreds of tasks.
- Put the Change Request IDs in `paths` as keyed collection paths (`/open[id=…]`): rejected, the
  guidance text is about the list of CRs, not about each field; keys with arbitrary characters would need
  escaping in field paths.
- Truncate the list without the total count: rejected, the guidance says "{count} open Change Request(s)".
