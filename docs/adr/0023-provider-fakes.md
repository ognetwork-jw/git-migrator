# ADR-0023: HTTP-level provider fakes instead of Gitea or Forgejo

- Status: accepted
- Date: 2026-10-08

## Context

The user declined Gitea/Forgejo (Q38). Agents can't use real providers before handoff (Q65).

## Decision

Build stateful fakes of the Bitbucket and GitHub APIs, validated against official OpenAPI documents, plus a real `git http-backend`.

## Consequences

Fakes may diverge from reality. The live e2e and contract suite mitigate this.
