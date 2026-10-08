# ADR-0094: Guidance severity model, and links that could not be verified

- Status: agent-decided
- Date: 2026-10-08

## Context

Each guidance entry needs a severity (the spec's B, pre, post and W notation) and an optional link. The implementation environment could not reach the vendor documentation: the agent proxy returned 403 for `docs.github.com`, so no external URL could be checked before it went into guidance.

## Decision

- Severity is one of `blocker`, `pre`, `post` or `warning`, and is copied from the source list. The verifiable flag (the spec's `(v)`) is a separate boolean. Parity completes a verifiable task, so the UI can say so.
- The `Guidance` and `GuidanceStep` types support `link`. The catalog contains no external links. An unverified URL is worse than none, and the vendor UI wording is quoted in the text instead.
- A verification text is shared where several codes complete the same way. For example, `verification.secrets` applies to `secrets.set-value` and `org-secrets.set-value`.
- Follow-up: once outside HTTPS to the vendor documentation works, the orchestrator (or a later task) adds links for secrets, deploy keys, webhooks, CODEOWNERS and large files, and checks them.

## Affected requirements

UI-040, FAC-002.
