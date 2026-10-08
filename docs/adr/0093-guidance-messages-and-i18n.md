# ADR-0093: Where guidance messages live, and how next-intl renders them

- Status: accepted (spec updated)
- Date: 2026-10-08

## Context

UI-040 says `title` and `summary` are i18n keys, and that `text` and `copy` are templates. The task brief asks for English messages in `packages/guidance`, and for the web app to render them through next-intl later.

AGENTS.md says: "Every user-facing string goes in `apps/web/messages/en.json`." This package departs from that rule. Guidance is structured data that the API and workers also consume (for example when a Migration's blockers are listed), not only the web UI. Keeping the English next to the content lets every consumer render it from one source, and the web app only passes a lookup. The orchestrator will amend AGENTS.md to say that guidance messages live with the guidance package, and that `apps/web/messages/en.json` holds UI chrome.

## Decision

- English guidance messages are in `packages/guidance/src/messages/en.json`, a flat map from dotted key to markdown template. Keys look like `finding.<code>.title`, `finding.<code>.summary`, `finding.<code>.step.<n>`, `verification.<name>` and `shared.<name>.*`.
- A step's `text` is a message key, not the English text. Its English template is the catalog value. This keeps every user-facing sentence translatable. It departs from UI-040's wording only in that `text` names a key rather than holding the template inline.
- `copy` snippets are code, so they are not translated.
- `renderGuidance(code, values, { lookup })`. The lookup is `nextIntlLookup(t)`: `t.has(key) ? t.raw(key) : undefined`.
  - `t.raw` is used, not `t(key)`. next-intl's `t` applies ICU formatting: `{path}` would be a missing argument, and an apostrophe would be quote syntax. `raw` returns the message verbatim, and the guidance renderer substitutes its own parameters.
  - A lookup that returns the key itself is an echo. The renderer falls back to English and reports `message-fallback`.
  - A key the translator does not have falls back to English silently, which is the normal case for a locale that is not finished.
- Key scheme. next-intl resolves dotted keys through nested messages. The flat catalog is converted with `nestCatalog`, and the result is mounted under the guidance namespace of the web app's messages. `nestCatalog` refuses a key that is a prefix of another.
- Tests. next-intl is not pinned in this repository, so the tests use a faithful fake translator (`FakeNextIntl` in `render.test.ts`) with its `has`, `raw` and `t` semantics. The fake shows that `t(key)` fails on guidance placeholders and that `raw` does not. When next-intl is pinned, the same tests should run against the real translator.

## Integration (for the web task)

```ts
import { nextIntlLookup, renderGuidance } from '@git-migrator/guidance';
const rendered = renderGuidance(task.code, params, { lookup: nextIntlLookup(t) });
```

Mount `nestCatalog(enMessages)` under the guidance namespace. Render `summary`, step `text` and `verification` as markdown, and show each `copy` with a copy button.

## Alternatives

- Put the messages in `apps/web/messages/en.json`. Rejected: API and worker consumers would depend on the app, and the content would live in two places.
- Keep English inline in the entries. Rejected: nothing could be translated later.
- Use `t(key)` and escape the placeholders. Rejected: ICU escaping of every placeholder is fragile, and `raw` is the exact-text API.

## Affected requirements

UI-040, GLO-002, AGENTS.md (orchestrator to amend).
