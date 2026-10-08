# ADR-0027: Cheapest appropriate model per subagent

- Status: accepted
- Date: 2026-10-08

## Context

The one-shot build runs many subagents. The user asked for the cheapest model that is still appropriate for each one.

## Decision

- Role defaults live in `.claude/agents/*.md` frontmatter: implementor `sonnet`, spec reviewer `sonnet`, adversarial reviewer `sonnet`, merge agent `haiku`, explorer `haiku`, orchestrator `opus`.
- Each work-breakdown task carries a tier (`L`/`M`/`H`). The orchestrator passes the Agent tool's `model` per tier: `L` uses haiku implementor and reviewer; `H` raises only the adversarial reviewer to opus.
- Escalation is one tier at a time, on repeated CI failure, persistent BLOCKERs or a stuck report.
- `fable` is never used.

## Consequences

Most tokens are spent on sonnet and haiku. Opus is concentrated where errors are costliest: orchestration, adversarial review of high-risk tasks, and the final review.
