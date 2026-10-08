# ADR-0011: Flatten Bitbucket projects into repository names and settings

- Status: accepted
- Date: 2026-10-08

## Context

GitHub has no project level. The user chose name-prefix preservation and per-repository flattening (Q49 a+i), with no custom property (Q87).

## Decision

Project → `{projectKey lowercased}-{repo-kebab}` name. Project-level permissions, restrictions, access keys and default reviewers are flattened into each repository's effective settings.

## Consequences

Changing a project setting later on GitHub means changing every repository. Parity stays per-repository.
