# ADR-0446: Mounting the guidance catalog and the reusable guidance view

- Status: agent-decided
- Date: 2026-10-09
- Task: T-082
- Affects: UI-040, UI-001, FAC-002, GLO-002

## Context

ADR-0093 says the web app mounts the guidance catalog under its guidance namespace with `nestCatalog` and renders with `renderGuidance(code, params, { lookup: nextIntlLookup(t) })`, but nothing yet mounted it or rendered it. T-086's endpoint page shows codes only and should adopt the same renderer.

## Decision

- `@git-migrator/guidance` exports `GUIDANCE_MESSAGES_EN`, its flat English catalog. The web app depends on the package (apps may depend on anything, ARC-012).
- `apps/web/src/messages.ts` builds the one app catalog: `messages/en.json` plus `guidance: nestCatalog(GUIDANCE_MESSAGES_EN)`. Both `i18n/request.ts` and the test render helper use it, so the tests run against what ships. `GUIDANCE_NAMESPACE` names the mount point.
- `apps/web/src/guidance/guidance-view.tsx` exports `GuidanceView({ code, params, fieldPaths?, defaults?, showTitle? })`, the one component that renders guidance: title, severity, a "checked by parity" tag, summary, numbered steps with a monospace block and a copy button for each `copy` value, and the verification sentence. The Overview and Tasks tabs use it; the endpoint migration page (UI-026) can drop it in per finding.
- `guidanceParams(params, extras)` turns a finding's stored `params` into `ParamValues`: only names the guidance defines pass through, a `null` never hides a default (the caller supplies the target repository full name), and the finding's `fieldPaths` stand in for `paths`. The renderer treats a value of the wrong kind as missing, so a malformed `params` object cannot put `undefined` or `[object Object]` on screen.
- Guidance messages are Markdown templates. Only the subset they use is interpreted, by `inline-markdown.tsx`: code spans, backslash escapes and the `&#58;` / `&#46;` references that keep a URL from becoming a link. Everything is rendered as React text, so no value from the source system becomes markup.
- `CopyButton` writes with `navigator.clipboard`, announces "Copied" or "Copy failed" in a polite live region, and never claims success when the write is refused. The `copy` command is shown in full so it can be selected by hand too.
- A code with no guidance renders a short notice instead of throwing (FAC-002 makes this unreachable for Facet codes; run-origin blockers and future codes are covered).
- Interface strings of the view (labels, severity names) live in `apps/web/messages/en.json` (`guidanceView`, `copy`); guidance content stays in the package (ADR-0093).

## Alternatives

- A Markdown library for guidance text. Rejected: the messages use three constructs, and a general renderer widens the surface for injected markup.
- Pass the guidance catalog as a second next-intl provider. Rejected: a second provider per request for one namespace; mounting under a key is what ADR-0093 describes.
