# ADR-0014: Classic branch protection via GraphQL, not rulesets

- Status: accepted
- Date: 2026-10-08

## Context

Bitbucket push restrictions name individual users. GitHub ruleset bypass lists cannot. REST branch protection accepts only literal branch names, not patterns.

## Decision

Write pattern-based classic branch protection rules through GraphQL.

## Consequences

Rulesets can be adopted later via a new adapter capability. GraphQL has its own quota resource.
