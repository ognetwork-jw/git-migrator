# ADR-0026: Review loop with fixup commits

- Status: accepted
- Date: 2026-10-08

## Context

The human doesn't review code along the way. History should stay meaningful (Q47, Q69, Q70).

## Decision

Two parallel reviewers (spec and adversarial), at most 5 rounds. Fixes are folded into the commits they correct with fixup and autosquash. Linear history. Unresolved issues go to `docs/followups.md`.

## Consequences

Clean history per task. More rebasing work for agents.
