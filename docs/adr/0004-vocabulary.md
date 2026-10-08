# ADR-0004: Provider-neutral vocabulary; Actor vs Identity

- Status: accepted
- Date: 2026-10-08

## Context

The framework must not depend on any provider's nomenclature. App users and provider accounts must not be conflated, and non-human principals exist.

## Decision

Use the glossary in 01-glossary. `Actor` = git-migrator principal (human or service). `Identity` = provider account. `Change Request` = PR/MR.

## Consequences

Provider terms appear only in adapters, provider docs and quoted guidance (GLO-002).
