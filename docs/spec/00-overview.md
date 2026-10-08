# 00 — Overview

## Purpose

git-migrator is a provider-neutral framework, plus a web application built on it, for migrating repositories between git service providers. It reads a repository and its hosted configuration from a source Endpoint, determines what can be translated automatically to a target Endpoint, executes the migration, and proves the result by comparing both sides.

The first concrete use is **Bitbucket Cloud (Standard plan) → GitHub Cloud (Team plan)**: about 1,500–2,000 repositories, 2 Endpoints, most repositories under 5 GB and some up to about 20 GB.

## Goals

1. **Provider-neutral core.** The core has no provider nomenclature or behavior. Providers are build-time adapters.
2. **Per-repository readiness.** Each repository is classified as **Ready** (one-click migration), **NeedsAttention** ("Run migration anyway" plus a list of manual tasks with guidance), or **Blocked**. Every classification is explained per Facet.
3. **Verification by parity.** A repository is migrated when canonical projections of both sides are equal, after subtracting Expected Differences. An Actor can also mark it complete manually.
4. **Scale.** Inventory and analysis of every repository happen in the background within provider rate limits, and results are stored in Postgres.
5. **Operability.** Runs on Kubernetes with a read-only root filesystem, as non-root, with resource requests and limits. Uses Azure Database for PostgreSQL and Azure Key Vault.

## Non-goals (v1)

- Migrating issues, wikis, releases, Downloads, packages or Change Request history. These are detected and reported, never migrated (FAC-EXT).
- Runtime-loaded adapters, multi-tenancy, and Endpoints added at runtime.
- Blob storage. `@flystorage/file-storage` is deferred; see ADR-0012.

## Project completion

The one-shot implementation is complete when:

1. Every task in [15-work-breakdown](15-work-breakdown.md) is merged.
2. The integration-tier Phase-1 scenario (TST-020) passes against the provider fakes.
3. The live e2e test (TST-030) and [e2e setup guide](../e2e-setup.md) exist and are ready for the human to run.
4. `docs/followups.md` lists every review loop that hit the 5-loop cap, and `docs/handoff.md` lists every `agent-decided` ADR (PROC-030).

The human validates afterwards by running the live e2e test first.

## Conventions used in this spec

- **MUST / MUST NOT / SHOULD / MAY** follow RFC 2119.
- **Requirement IDs** have the form `AREA-NNN` (for example `LIF-012`). Tests reference them in their names, for example `it('[LIF-012] blocks when open change requests exist')`. IDs are never reused. A removed requirement is struck through, not deleted.
- **Area prefixes:** GLO glossary, ARC architecture, DOM domain, ADP adapter contract, FAC-* facets, LIF lifecycle, JOB jobs/quota, AUTH, API, UI, DATA, DEV, DEP deployment, TST testing, PROC process.
- `docs/spec/` is **normative**. Only the orchestrator changes it ([process](../process/workflow.md)). When the spec is silent or ambiguous, the implementor decides, records an ADR with `status: agent-decided`, and the orchestrator folds that decision into the spec.

## Document map

| File | Contents |
|---|---|
| [01-glossary](01-glossary.md) | Vocabulary used everywhere |
| [02-architecture](02-architecture.md) | Stack, monorepo layout, runtime components |
| [03-domain-model](03-domain-model.md) | Entities, storage strategy |
| [04-adapter-contract](04-adapter-contract.md) | Adapter and Facet interfaces, fidelity |
| [05-facets](05-facets.md) | Every Facet: canonical schema, Bitbucket/GitHub mapping, parity, tasks |
| [06-migration-lifecycle](06-migration-lifecycle.md) | States, analysis, runs, parity, drift, rollback |
| [07-jobs-and-quota](07-jobs-and-quota.md) | Queues, workers, schedules, rate limiting, events |
| [08-identity-and-auth](08-identity-and-auth.md) | Sign-in, roles, Actors, API keys, identity mapping, invitations |
| [09-api](09-api.md) | Hono, ZenStack RPC, custom endpoints, SSE |
| [10-web-ui](10-web-ui.md) | Pages and UI rules |
| [11-data](11-data.md) | Postgres schemas, migrations, retention |
| [12-dev-environment](12-dev-environment.md) | devenv, Docker Compose, secretspec |
| [13-deployment](13-deployment.md) | Image, Helm, Azure, CI/CD |
| [14-testing](14-testing.md) | Test tiers, provider fakes, e2e |
| [15-work-breakdown](15-work-breakdown.md) | Milestones and tasks with dependencies |
