# ADR-0152: org-webhooks facet semantics

- Status: accepted (spec updated)
- Date: 2026-10-08
- Task: T-056
- Affects: FAC-END (org-webhooks), FAC-WEB-001..004, FAC-005, FAC-002, ADR-0141

## Context

FAC-END says workspace webhooks become organization webhooks "under the same allowlist, secret and payload rules as FAC-WEB". The repository-level `webhooks` facet (T-053, ADR-0141, folded into FAC-WEB-002/003) holds those rules, including the structural allowlist match (a raw-string glob let `?`, `#` and `\` smuggle a host past it), secret hooks created inactive with redacted task params, and hooks with no receivable events. Finding codes and policy keys must be `<facet>.<name>`.

## Decision

- **One implementation.** `org-webhooks` reuses the `webhooks` module. That module exports `translateHookSet`, `compareHookSet`, `isHookSetTaskSatisfied` and `HookSetCodes`; `translateWebhooks` / `compareWebhooks` / `isWebhookTaskSatisfied` are thin wrappers with the repository codes, and `org-webhooks` passes its own. All FAC-WEB-002/003 behaviour (structural allowlist, inactive secret hooks, `{ key, targetUrlDisplay, activateAfterSecret }` params, task satisfaction, comparison, hooks left to the human when no event can be received, target-only hooks ignored) therefore applies unchanged to organization hooks.
- Codes and policy key: `org-webhooks.recreate-manually` (post, parity), `org-webhooks.set-secret` (post, parity), `org-webhooks.accept-lossy` (pre, accept), policy key `org-webhooks.event-dropped`. All are agent-decided (the spec names the repository ones), have guidance with organization wording (the activate step is shown only when `activateAfterSecret`), and are in `AGENT_DECIDED_CODES` / `AGENT_DECIDED_POLICY_KEYS`. There is no `org-webhooks.duplicate-url`: duplicate-URL merging is done by the reader with `mergeDuplicateWebhooks`.
- Parity ignores target-only hooks (ADR-0141, ADR-0150).

## Alternatives

- A private copy of the rules (the first version of this branch): it repeated the allowlist bypass and secret-hook defects fixed in T-053.
- Reuse the policy key `webhooks.event-dropped` for both: the registry requires policy keys to carry the owning facet's key.

## Affected requirements

FAC-WEB-001, FAC-WEB-002, FAC-WEB-003, FAC-WEB-004, FAC-005, FAC-002, FAC-END.
