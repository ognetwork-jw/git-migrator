# ADR-0087: Endpoint-level secrets/variables/webhooks schemas; strict objects

- Status: agent-decided
- Date: 2026-10-08
- Task: T-015
- Affects: FAC-001, FAC-END (`org-variables`, `org-secrets`, `org-webhooks`), FAC-WEB, FAC-VAR

## Context

05-facets lists `org-variables`, `org-secrets` and `org-webhooks` without TypeScript schemas, saying they follow the repository facets' rules and that workspace variables become organization variables with `visibility: all`.

## Decision

- `OrgVariables = { variables: { name: string; value: string; visibility: 'all' }[] }`, key `name`.
- `OrgSecrets = { secrets: { name: string }[] }`, key `name` (values are unreadable and never stored).
- `OrgWebhooks = { hooks: Webhook[] }`, the same `Webhook` as `webhooks`, key `url`, set `/hooks/events`.
- Entries have no scope, since the endpoint is the scope.
- All object schemas are strict (unknown fields are rejected, so a stray secret value fails loudly rather than being dropped silently). Key fields and identifiers are non-empty strings. Counts and approvals are non-negative integers. SHAs and OIDs are non-empty strings, not hex-validated (hash algorithm and fake data are left to adapters); `pipelines.files[].sha256` is 64 lowercase hex.
- Each facet declares `schemaVersion: 1`.

## Alternatives

- Reusing repository `Variables` with scopes: scopes do not apply at organization level.
- Non-strict (strip) objects: hides drift between adapter output and the schema.
