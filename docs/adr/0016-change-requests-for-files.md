# ADR-0016: In-repo changes only via Change Requests; post-cutover containment

- Status: accepted
- Date: 2026-10-08

## Context

Committing generated files (CODEOWNERS, workflows) to the target default branch breaks SHA parity.

## Decision

File changes go to `git-migrator/*` branches with Change Requests. After source read-only is applied, git drift uses containment (target equal or ahead) rather than equality.

## Consequences

Humans merge generated changes. Normal development after cutover does not raise drift.
