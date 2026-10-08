# @git-migrator/guidance

Guidance for Manual Tasks and Blockers: one entry per Finding code (FAC-002), rendered with typed
parameters (UI-040). Pure data and templating: no I/O. Provider names appear only in message text,
which may quote the provider UI (GLO-002).

Status: complete for T-014. Facets add their codes to `src/codes.ts` and their guidance is already
in this package. Declared internal dependencies (ARC-012, checked by `pnpm lint`): `@git-migrator/core`,
`@git-migrator/canonical`. Neither is imported yet.

## Layout

| File | Role |
|---|---|
| `src/codes.ts` | The single source list of Finding codes: facet, severity, `(v)` flag and spec section (ADR-0090). |
| `src/entries.ts` | `GUIDANCE`: one `Guidance` per code, typed `Record<FindingCode, Guidance>`, so a missing entry fails `pnpm typecheck`. |
| `src/params.ts` | `PARAMS`: every template parameter with its kind (`text`, `url`, `integer`, `list`). |
| `src/template.ts` | Placeholder rendering, escaping and problem reporting (ADR-0092). |
| `src/render.ts` | `renderGuidance(code, values, { lookup })`. |
| `src/coverage.ts` | `assertGuidanceCoverage(codes)` and `findMissingGuidance(codes)` (FAC-002). |
| `src/messages/en.json` | English messages, a flat key-to-markdown-template map (ADR-0093). |
| `src/*.test.ts` | Templating, rendering, coverage, the spec cross-check and catalog integrity. |

## Guidance shape

```ts
renderGuidance('secrets.set-value', {
  repository: 'acme/payments',
  scope: 'repository',
  names: ['API_TOKEN', 'DB_PASSWORD'],
});
// {
//   code: 'secrets.set-value', severity: 'post', verifiable: true,
//   title: 'Set secret values', summary: 'git-migrator does not set secret values. ...',
//   steps: [{ text: '...', copy: 'gh secret set API_TOKEN --repo acme/payments\ngh secret set DB_PASSWORD --repo acme/payments' }],
//   verification: 'Parity completes this task once every listed secret name exists on the target.',
//   problems: [],
// }
```

- `severity` is `blocker`, `pre`, `post` or `warning` (the spec's B, pre, post and W). `verifiable` is the spec's `(v)`.
- `steps[].copy` is a copy-ready snippet. It is omitted when a parameter it needs is missing or invalid, and the problem is listed in `problems`.
- `steps[].when` and `steps[].unless` select a step by whether a parameter is supplied.
- Missing or invalid parameters render as `‹name›`. Nothing renders as `undefined`, `null` or `NaN`.

## Templates

Placeholders are `{name}` or `{name:context}`. Contexts: `markdown` (default, for prose), `shell` (POSIX
single-quoting, for copy snippets) and `raw` (for URLs in copy snippets). Parameter kinds: `text`
(non-blank, up to 1024 characters, no control characters), `url` (absolute http or https, no
credentials), `integer` (non-negative safe integer) and `list` (1 to 500 text items, joined in prose,
one copy line per item in a snippet).

## Adding guidance for a code

1. Add the code to `FINDING_SPECS` in `src/codes.ts` with its facet, severity, `(v)` flag and spec section.
2. Add its entry to `GUIDANCE` in `src/entries.ts`. The compiler requires it.
3. Add the English keys to `src/messages/en.json` (`finding.<code>.title`, `.summary`, `.step.<n>`).
   Reuse a `shared.*` or `verification.*` key where the guidance is the same.
4. Add any new parameter to `PARAMS` in `src/params.ts`, and use it only with a kind it fits.
5. Run `pnpm test`. The coverage and cross-check tests fail until the code, the spec and the entry agree.

The spec remains normative (AGENTS.md). If the code is not in `docs/spec/05-facets.md`, the
cross-check test fails, and the spec change goes through the orchestrator.

## Using guidance in the web app (UI-040, ADR-0093)

Guidance renders with next-intl. The lookup uses `t.has` and `t.raw`, not `t(key)`: next-intl's `t`
applies ICU formatting, which would reject the `{path}` placeholders and treat apostrophes as quoting.

```ts
import { nestCatalog, nextIntlLookup, renderGuidance } from '@git-migrator/guidance';

// Mount once under the guidance namespace of the web app's messages:
const guidanceMessages = nestCatalog(enFlatCatalog); // enFlatCatalog = messages/en.json

const rendered = renderGuidance(task.code, params, { lookup: nextIntlLookup(t) });
```

Render `summary`, step `text` and `verification` as markdown, and show each `copy` with a copy button.
`apps/web/messages/en.json` holds UI chrome only. Guidance messages live here (AGENTS.md is to be
amended by the orchestrator). next-intl is not pinned in this repository, so the tests use a fake
translator with `has`/`raw`/`t` semantics.

## Coverage (FAC-002)

Facets call `assertGuidanceCoverage(emittedCodes)` in their tests. It throws `GuidanceCoverageError`
listing every code without guidance. The test over `FINDING_CODES` checks the built-in list against
the spec (`docs/spec/05-facets.md`), in both directions (ADR-0091). The generic FAC-006 codes
(`<facet>.unmapped-principal`, `<facet>.pending-invitation`) are listed for `access-control`,
`branch-rules`, `code-ownership` and `teams` (ADR-0090).

## Open items

- No external documentation links yet. The agent proxy could not reach the vendor documentation, so no
  link was verified (ADR-0094). The `link` field is supported.
- Webhook URLs are shown with canonical's `redactWebhookUrl` (T-015). Only http(s) URLs are displayed; the
  rest show the `‹targetUrlDisplay›` marker (ADR-0092).
- `target.owned-by-other-migration` (LIF-031, from T-013) is now named in the lifecycle spec, so it is no
  longer pending.
