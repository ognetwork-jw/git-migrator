# ADR-0001: Record architecture decisions

- Status: accepted
- Date: 2026-10-08

## Context

Decisions from the specification session and from implementation need a durable, reviewable trail, especially for agent-made decisions the human reviews at the end.

## Decision

Use one Markdown ADR per decision in `docs/adr/`, numbered sequentially. The status is one of `accepted`, `agent-decided`, `accepted (spec updated)`, `superseded by NNNN` or `rejected`. Sections: Context, Decision, Consequences.

## Consequences

Agents MUST create an ADR for every spec ambiguity they resolve (PROC-005).
