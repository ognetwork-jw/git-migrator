# ADR-0092: Guidance template syntax, typed parameters, escaping and value hardening

- Status: agent-decided
- Date: 2026-10-08

## Context

UI-040 says guidance `text` and `copy` are templates over parameters, such as `{repository}` and `{targetUrl}`. Copy snippets are shell commands, so a repository name or a secret name with spaces, `$`, quotes or leading dashes must not break or inject into them. Missing values must never print as `undefined`. Provider data can also carry hostile text: bidi overrides, line separators, autolinks, and webhook URLs with secrets in the path or query.

## Decision

- Placeholders are `{name}` or `{name:context}`. Names are declared in `params.ts` with a kind: `text`, `url`, `integer` or `list`.
- A value is accepted only if it matches its kind. Text is a non-blank string of at most 1024 characters. It may not contain C0 or C1 controls, DEL, U+2028, U+2029, or bidi embedding, override or isolate controls (U+202A–202E, U+2066–2069). A URL must be an absolute `http(s)` URL with no credentials. An integer must be a non-negative safe integer. A list has 1 to 500 valid text items.
- Contexts:
  - `markdown` (default) escapes Markdown control characters and neutralises bare autolinks (`https://`, `www.`) by writing the separator as an HTML character reference, so they render the same but do not link.
  - `shell` POSIX-quotes a value unless it is a plain word. A value that starts with `-` is refused in this context, because a copied command would read it as an option. Earlier code quoted these; the quoting branch is removed.
  - `raw` inserts a URL unchanged, with `'` percent-encoded so it cannot end a shell word. It is valid only for `url` parameters. Any other use is a `context-mismatch` problem, and the catalog test enforces it.
- A missing, invalid, unknown or mis-contexted placeholder renders as `‹name›` and is listed in `problems`. Nothing throws at runtime. Developer errors (a snippet with two list parameters) throw `TemplateError`.
- Inserted values are not scanned again, so a value containing `{x}` prints literally.
- A step's `copy` is omitted when any of its parameters is missing or invalid, so the UI never offers a command that is not ready to run.
- A copy snippet that names one list parameter is repeated once per item, one line each. Two list parameters in one snippet are refused.
- A step is included only when a parameter is supplied (`when`) or only when it is not (`unless`).
- Deploy keys: the key title is used only as the `ssh-keygen -C` comment. The output file name is fixed (`deploy_key_ed25519`), and no provider data is ever a file path. The command does not pass `-N ""`, so the passphrase is chosen by the user. The steps tell the user to store the private key in a secret manager and delete the local copy.
- Webhook URLs: a summary shows only `targetUrlDisplay`, which is canonical's `redactWebhookUrl` (`<origin>/…`), so secrets in the path or query stay out of prose. The guidance adds one check on top: only `http(s)` URLs are displayed. For `javascript:`, `data:` and `mailto:` URLs (which have no meaningful origin, and which `redactWebhookUrl` would render as `null/…`), and for unparsable URLs, the marker `‹targetUrlDisplay›` is shown instead.
- The webhook copy snippet that recreates the hook carries the full URL, because the user needs it, in the `shell` context. It is always single-quoted (an embedded `'` becomes `'\''`), so `;`, `|`, `&`, `$()`, backticks and quotes stay literal. A newline is refused by the control-character rule, which drops the snippet.
- Autolink neutralisation has no word boundary, and covers the general RFC 3986 scheme form `scheme://` (so `https://`, `ssh://`, `git://` and `file:///` are all neutralised), plus `www.`. Those are the forms that make a value into a link. A value glued to a preceding word character is still neutralised.
- Scope: bare email addresses and `mailto:` URIs are not neutralised. Emails in provider values (for example a member's address in an invitation candidate) are accepted as low risk: they are plain text in prose, and a Markdown renderer does not turn them into links without an `@`-based autolink extension, which the guidance renderer does not depend on. No code change; the rule is recorded here so a later reviewer does not treat the gap as an oversight.

## Alternatives

- Throw on a missing parameter. Rejected: a single bad value would fail the whole render. The test suite renders every entry in full, so a missing parameter still fails the build.
- Use an ICU MessageFormat library. Rejected for now: it adds a dependency, and next-intl is the runtime integration (ADR-0093).
- Show full webhook URLs in summaries. Rejected: they can carry secrets.

## Affected requirements

UI-040, FAC-002, FAC-WEB-002, FAC-DKY-002, FAC-SEC-001.
