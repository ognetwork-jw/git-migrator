# ADR-0363: Saving a naming rule waits for a preview, and collisions block it unless confirmed

- Status: agent-decided
- Date: 2026-10-09
- Task: T-091
- Affects: UI-030, LIF-030, LIF-031, API-020, ADR-0331

## Context

T-091's acceptance: the naming preview prevents saving a rule that introduces collisions unless explicitly confirmed. The preview (ADR-0331) answers collision groups that involve a repository in the candidate's scope, and it refuses above 20,000 repositories with 422. UI-030 asks for the preview "before saving". A rule can also be deleted, which the preview cannot express, because the endpoint takes a candidate rule only.

## Decision

- The editor runs the preview on the exact rule body it will save. The save button stays disabled until a preview of that body exists. Any edit makes the preview stale (compared by the serialized body), and the operator must preview again.
- If the preview lists collision groups, saving needs a checkbox that accepts the collisions. The checkbox resets on every new preview.
- A preview that fails (422 above the limit, 409, or a network problem) blocks the save, because the collisions cannot be known. The page says so.
- The mutation re-checks the same gate before sending, so a disabled button cannot be bypassed.
- Deleting a rule is confirmed with a dialog and is not previewed. This is recorded as a follow-up: removing a rule can also create collisions (repositories fall back to a broader name).

## Alternatives

- Block on any collision on the Route: pre-existing collisions unrelated to the rule would block every save. Rejected, since the preview already scopes collisions to the candidate.
- Allow saving after a failed preview: the operator could save a colliding rule without knowing. Rejected.

## Follow-up

Preview a deletion (for example a candidate with the rule removed, or a dedicated `DELETE` preview), so deleting a rule is gated the same way.
