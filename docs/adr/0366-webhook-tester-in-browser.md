# ADR-0366: The webhook pattern tester runs in the browser with the facets matcher

- Status: accepted (spec updated)
- Date: 2026-10-09
- Task: T-091
- Affects: UI-031, FAC-WEB-002, ARC-012, GLO-002

## Context

UI-031 asks for "a pattern tester (enter a URL, see matches)". FAC-WEB-002 defines the match structurally (`matchesPattern` in `packages/facets/src/webhooks`). A hook URL may carry credentials in its path or query (FAC-WEB-002, `redactWebhookUrl`), so the tester must not send what the operator types to the server.

## Decision

- The tester calls `matchesPattern` from `@git-migrator/facets/webhooks-match` (a narrow subpath, so the client does not import every Facet module) in the browser, debounced by 200 ms. Nothing is sent or stored; the page says so under the tester.
- `apps/web` declares `@git-migrator/facets` as a workspace dependency and a TypeScript project reference. ARC-012 allows `apps/*` to depend on anything, and `facets` is pure (no I/O), so the client bundle carries no server code.
- Pattern validation (`patternProblem`) requires an http or https URL without spaces, with `*` allowed in place of a host label or path segment. It also refuses `**` in the host, a backslash or a control character, and more than 2048 characters, because the matcher never matches those (FAC-WEB-002). A pattern that cannot parse is refused, so the matcher is never given one it would reject silently.
- The path glob in `packages/facets` is now a linear-time matcher (a dynamic program over pattern tokens, `**` runs collapsed) instead of a regular expression, since nested `.*` took seconds on adjacent `**` segments. A pattern or URL over 2048 characters is no match. This is a Facet fix (FAC-WEB-002) as well as a UI one. The cap applies to the whole URL, query included, as FAC-WEB-002 states, not only to the path: a hook whose URL is longer than 2048 characters (for example because of a long query string) is never created automatically, also during a resync, and falls to `webhooks.recreate-manually`. That is the fail-closed direction, and the spec fixes it, so the matcher does not cap the path alone.

## Alternatives

- Ask the server to match (a `POST` tester endpoint): sends the URL to the server, and needs a new endpoint. Rejected.
- Reimplement the matcher in the page: two matchers that can disagree. Rejected.
