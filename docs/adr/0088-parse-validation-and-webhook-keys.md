# ADR-0088: Parse-time key validation, webhook keys, URL and text rules, schema versions

- Status: accepted (spec updated)
- Date: 2026-10-08
- Task: T-015
- Affects: FAC-001, ADP-021, FAC-WEB, FAC-DKY, FAC-VAR, FAC-SEC

## Decision

- **Parse validates collections.** `parseCanonical` runs the Zod schema and then core's `validateCollections` with the facet's declarations. Duplicate or unusable keys fail at parse with `reason: 'invalid'`; each issue's path is the concrete field path (for example `/hooks[url=https://x/h]`) and its message is `<code>: <detail>`.
- **Webhook keys (revised).** Webhook URLs often carry the credential in the path (chat tools, CI servers), so the raw URL is not used as an addressable identity. `webhooks` and `org-webhooks` elements have a required derived `key` = `<origin>#<first 16 hex of sha256(new URL(url).href)>` (`webhookKey(url)`, exported for adapters; the schema checks `key === webhookKey(url)`). The collection key is `key`, so field paths read `/hooks[key=https://host#0123456789abcdef]/active` and never contain the URL path or query. Hooks with the same normalized URL (lowercased scheme and host, default port removed, WHATWG form) collide, and a document with such duplicates is rejected at parse. Providers allow duplicate URLs, so the webhook reader/translator (T-053, T-032, T-033) must detect duplicate-URL hooks on a side and report a finding instead of producing an invalid document. T-053 owns that finding.
- **Webhook URLs** (`webhooks`, `org-webhooks`) must be absolute http(s) URLs without userinfo. Query strings are accepted unchanged (real hooks use `?token=`), so a `url` value may contain credentials, in the path or the query. It is stored because the hook must be recreated. Anything that logs, diffs, reports or shows webhook URLs (findings, Expected Difference notes, logs, UI, raw captures) must redact them with `redactWebhookUrl(url)` (`<origin>/…`). Diffs on `/hooks[key=…]/url` carry the full value and need that redaction too.
- **Deploy keys** are `<type> <base64>`: exactly two whitespace-free tokens, not PEM armored. A comment must be stripped by the adapter.
- **Schema versions** are a `declareFacet` parameter (default 1). `parseCanonical(key, value, { version })` returns `reason: 'unsupported_version'` when the version differs. Migrating stored older documents is out of scope until the first version bump.
- **Variable and secret text** (`scope`, `name`, and org names) must not contain control characters or leading/trailing whitespace. Case is preserved and compared exactly in the canonical model; environment names are case-insensitive on the target, so the variables facet (T-054) must fold or flag environment names that differ only by case (see ADR-0086).

## Alternatives

- Per-schema `superRefine` for uniqueness: duplicates the collection declarations.
- Keying webhooks by (url, events): breaks the path form used by allowlists.
