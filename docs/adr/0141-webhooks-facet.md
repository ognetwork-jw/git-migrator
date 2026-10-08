# ADR-0141: webhooks facet semantics

- Status: accepted (spec updated)
- Date: 2026-10-08
- Task: T-053
- Affects: FAC-WEB-001, FAC-WEB-002, FAC-WEB-003, FAC-WEB-004, FAC-005, ADR-0088

## Context

FAC-WEB leaves open where the allowlist and the target's event support reach the facet, how the allowlist glob is evaluated safely, what "created inactive" means for `desired` and parity, how events compare when the target is coarser, and which finding reports duplicate-URL hooks (ADR-0088 assigns it to T-053).

## Decision

- **Allowlist source.** `ctx.route.webhookAllowlist` is the array of `WebhookAllowlistEntry.pattern` strings. When `policies.webhookAllowlistEnabled` is false every hook is auto-created. A malformed list throws.
- **Allowlist matching is structural, not textual.** Matching the glob against the raw URL string let `https://evil.com?.example.com/hook` or a `#` or `\` pass `https://*.example.com/hook`. Now the hook URL and the pattern are both parsed as WHATWG URLs. A hook URL that contains a backslash, whitespace or a control character, or does not parse, never matches (fail closed). The scheme must be equal and the port equal once defaults are removed. The host is compared case-insensitively after the parser's IDN-to-ASCII conversion; a `*` in a host matches exactly one label and `**` is not valid in a host. `*` and `**` in the path match against the parsed pathname only (`*` stays inside a segment, `**` crosses segments, other characters are literal; a trailing slash is significant). The query and the fragment are ignored. A pattern that does not parse never matches.
- **Not allowlisted.** The hook is omitted from `desired` and gets post task `webhooks.recreate-manually` with params `{ targetUrl, events }`. The full URL is there because the guidance copy snippet needs it (ADR-0092). A hook whose events are all unsupported by the target (see below) is treated the same way, with an empty event list.
- **Secrets (FAC-WEB-003).** A hook with a secret is created inactive, so `translate` puts `active: false` in `desired` and records a `translated` decision at `/active` with the note "inactive until the secret is set". Every `hasSecret` hook (allowlisted or not) gets `webhooks.set-secret` with params `{ key, targetUrlDisplay, activateAfterSecret }`: no full URL, because it may carry a credential, and `activateAfterSecret` is the source `active`. Guidance shows the activation step only when it is true (new `flag` parameter kind in guidance). The task is satisfied when the target hook (found by `key`) has a secret and is active; if the source hook was inactive (`activateAfterSecret: false`) a secret alone satisfies it.
- **Parity of `active` for a secret hook.** `compare` treats `active` as equal whatever the target holds when the desired hook has a secret and `active: false`: before the task the target is inactive, after it the human has set the source value. All other fields still compare, so the outstanding secret shows as a `hasSecret` difference until the task is done.
- **Target-only hooks are not drift.** `compare` ignores hooks that exist only on the target. A hook the human recreated by hand for a non-allowlisted URL would otherwise be a permanent difference. This matches FAC-GIT-006, which allows extra target refs.
- **Events.** The facet works on canonical events. The mapping to the target's event names is the adapter's (provider docs). Because the target's events are coarser, a `translated` decision is recorded at `/hooks[key=…]/events` for `cr.*` and `build.status` events (exact for `push`, `repo.updated`, `repo.fork`, `issue.any`). `compare` treats a target hook whose events are a superset of the desired ones as equal; `recreate-manually` is satisfied by the same superset rule (FAC-WEB says "same event set", but a reader of the target can only report the covering set).
- **`webhooks.event-dropped`.** A source event the canonical model cannot name is dropped by the reader before the document exists. For events the target cannot receive, the facet reads `ctx.targetCaps.fields['/hooks/events']` as `{ kind: 'constrained', constraint: 'only:<csv of canonical events>' }`, removes the others from `desired` and records one lossy decision per hook with policy key `webhooks.event-dropped`.
- **`url` is not compared.** The key is derived from the URL and the URL carries credentials (ADR-0088), so `compare` removes `url` from both sides.
- **Duplicate URLs.** A canonical document cannot hold two hooks with one normalized URL, so the facet never sees them. `mergeDuplicateWebhooks(raw)` is for readers: it merges the group (events united, `active` and `hasSecret` if any hook has them, `verifyTls` only if all do), takes the lexicographically smallest raw URL as the group's `url` so the result does not depend on input order, and returns a `webhooks.duplicate-url` warning per group with params `{ targetUrlDisplay, count }` (redacted). An invalid URL throws `Error('invalid webhook url')`, never the native `TypeError`, whose `input` property holds the raw URL. The code is declared in `findingCodes` as a warning, has guidance, and is not named in the spec, so it is in the agent-decided exemption of `spec-crosscheck.test.ts`.
- Events are sorted alphabetically (ADP-021 set order).

## Alternatives

- Keep the source `active` in `desired` and let `compare` compute the effective value: needs the secret state of the target to define `desired`, which made parity depend on the thing it compares.
- Report duplicates from `translate`: unreachable, since the schema rejects duplicates first.
- Compare events for equality: the target cannot report which of the `cr.*` events a hook was created for, so parity would never settle.
- Normalize the raw URL string before the glob: still ambiguous between parsers; parsing both sides is the safe form.
