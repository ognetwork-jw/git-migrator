# 15 — Work Breakdown

This is the authoritative task graph for the one-shot implementation (Q72). A restarted orchestrator MUST resume from it, not re-plan. Task state is tracked in `docs/process/progress.md`, which the orchestrator updates after each merge: task ID, status, PR link, review loop count.

Rules:

- **Tier** (`L`/`M`/`H`) selects subagent models per [workflow § Model selection](../process/workflow.md#model-selection-proc-007).

- A task may start only when every task in **Depends** is merged.
- Tasks with satisfied dependencies MAY run in parallel. The orchestrator SHOULD keep at most 4 implementors in flight, so merge conflicts stay manageable.
- Every task's DoD includes the generic Definition of Done ([process/workflow](../process/workflow.md#definition-of-done)) plus its **Acceptance** bullets.
- A task's PR description lists the requirement IDs it implements.
- If a task turns out too large for one review cycle, the orchestrator MAY split it into `T-xxxa`/`T-xxxb` and record the split in `progress.md`. It MUST NOT merge tasks.

## M0 — Foundation

**T-001 Monorepo bootstrap.** Depends: —. Tier: M.
Requirements: ARC-001, ARC-002, ARC-010, ARC-011, ARC-012, TST-002, TST-005.
Acceptance:
- Every package and app from ARC-010 exists with `package.json`, `tsconfig` and `src/index.ts` (including `packages/canonical`).
- Turborepo pipelines exist for `build`, `typecheck`, `lint`, `test`.
- Biome is configured.
- The dependency-rule check fails on a deliberate violation (proved by a test fixture).
- `docs/adr/0002-versions.md` lists the exact versions chosen.
- `must-test.txt` is generated, and `pnpm spec:coverage` works.

**T-002 Development environment.** Depends: T-001. Tier: L.
Requirements: DEV-001 … DEV-040.
Acceptance:
- `devenv up` and `docker compose up` both start Postgres and run `pnpm dev` (with placeholder apps).
- The secretspec syntax has been verified against the pinned version.
- `.env.test` is committed with fake values.
- `docs/README.md` has a "Getting started" section for both paths.

**T-003 Agent tooling and CI skeleton.** Depends: T-001. Tier: L.
Requirements: PROC-007, PROC-010 … PROC-014, DEP-060 (lint, typecheck, unit only).
Acceptance:
- `.claude/settings.json` and hook scripts implement the hooks in [process/workflow](../process/workflow.md#claude-code-hooks).
- `.claude/agents/*.md` define the roles with the default models from PROC-007, and each role's instructions point to AGENTS.md and the workflow.
- `ci.yml` runs green.
- A PR template with a requirement-ID checklist exists.
- `docs/followups.md` and `docs/process/progress.md` are initialized.

**T-004 Config and observability packages.** Depends: T-001. Tier: L.
Requirements: ARC-030, DEP-040, DEP-050.
Acceptance:
- The full config Zod schema is in place, with defaults from DEP-040, env overrides and a clear error report.
- Logger redaction is tested.
- Metrics registry and tracing init exist.

## M1 — Data and core

**T-010 Database package.** Depends: T-004. Tier: H.
Requirements: DOM-001 … DOM-014, DATA-001 … DATA-011, DATA-030 (steps 1, 2, 5), DATA-031, DATA-040, API-012, AUTH-021 (policies).
Verification first: confirm that the pinned ZenStack v3 supports multi-schema (`@@schema`, `defaultSchema`), field-level `@deny` and `uuid(7)`. For any missing feature use the fallback: DOM-011/DOM-005 enforced in an RPC-layer hook, and application-generated UUIDv7. Record the outcome in an ADR.
Acceptance:
- `schema.zmodel` implements 03 with policies.
- Migrations include the raw-SQL indexes.
- A privileged client factory exists.
- Policy tests prove every role row of AUTH-020 for the RPC-writable models, and that DOM-011 fields are denied.

**T-011 Core primitives.** Depends: T-001. Tier: H.
Requirements: ADP-020, ADP-021, ADP-040, LIF-001 … LIF-004, FAC-005.
Acceptance:
- Field paths, collection normalization, JCS hashing, Expected Difference pattern matching (`*`, `**`), the lifecycle state machine (every listed transition plus rejection of unlisted ones) and readiness derivation are all done.
- Coverage meets TST-005 for `core`.

**T-012 Facet engine.** Depends: T-011. Tier: H.
Requirements: ADP-030, ADP-031, ADP-032.
Acceptance:
- The registry, translate/compare harness, policy acceptance → Expected Difference generation, and plan aggregation from findings are done.
- Tested with two synthetic facets.

**T-015 Canonical schemas.** Depends: T-011. Tier: M.
Requirements: FAC-001, ADP-002, ADP-021.
Acceptance:
- `packages/canonical` exports the TypeScript types and Zod schemas for every facet in 05-facets, with keyed-collection declarations.
- Round-trip tests (parse → normalize-free serialize) for each schema.

**T-013 Naming.** Depends: T-011. Tier: M.
Requirements: LIF-030, LIF-031.
Acceptance:
- Pipeline ops, precedence and validation against limits work.
- Collision detection is case-insensitive.
- Exhaustive unit tests.

**T-014 Guidance package.** Depends: T-011. Tier: L.
Requirements: UI-040, FAC-002.
Acceptance:
- Guidance type, templating and the en messages are done.
- The coverage test fails when a facet emits a code without guidance.

## M2 — Auth and API

**T-020 Auth.** Depends: T-010. Tier: H.
Requirements: AUTH-001 … AUTH-012, DATA-030 step 3.
Acceptance:
- Entra provider configured.
- Role mapping including denial.
- Actor provisioning and sync.
- Test sign-in, with the production guard tested.
- Better Auth migrations run in `migrate`.

**T-021 API foundation.** Depends: T-020. Tier: H.
Requirements: API-001 … API-003, API-010, API-011, AUTH-040, AUTH-022.
Acceptance:
- Hono is mounted in Next.js.
- ZenStack RPC works with session and API-key Actors.
- API key issuance and verification work.
- problem+json is used.
- The OpenAPI document is emitted.
- The audit plugin records RPC mutations.
- Health endpoints exist.

**T-022 Events and SSE.** Depends: T-021. Tier: M.
Requirements: JOB-060.
Acceptance:
- Publisher helper, LISTEN fan-out and a topic-filtered SSE endpoint.
- A React hook with invalidation and polling fallback, tested by simulating SSE failure.

## M3 — Infrastructure packages

**T-025 Quota.** Depends: T-010. Tier: H.
Requirements: JOB-040 … JOB-047.
Acceptance:
- Sliding-window ledger with advisory locks.
- Pools (0.9 / full).
- Account-keyed buckets.
- Header feedback (Bitbucket NearLimit, GitHub remaining and resource).
- `blockedUntil`.
- Pruning and metrics.
- Concurrency test: 20 parallel acquirers never exceed the limit.

**T-026 Adapter SDK.** Depends: T-011, T-025. Tier: M.
Requirements: ADP-010 … ADP-014, ADP-050, ADP-060, ADP-061, ADP-070.
Acceptance:
- Interfaces exported.
- `ProviderHttpClient` with retry matrix tests, raw capture with secret stripping, pagination helpers and host allowlist in test (TST-006).

**T-027 Git package.** Depends: T-026, T-040. Tier: H.
Requirements: ADP-071, FAC-GIT-001, FAC-GIT-004, FAC-GIT-005, LIF-044, JOB-015 (precheck).
Acceptance:
- Against the fake git server: mirror, ls-remote parsing (annotated tags), blob scan, LFS fetch and push, and batched push respecting a small `maxPushBytes`.
- Credentials never appear in argv or config (test inspects them).

**T-028 Jobs and worker runtime.** Depends: T-010, T-004, T-020. Tier: H.
Requirements: JOB-010 … JOB-015, JOB-046, JOB-050, ARC-023, LIF-046 (lease and reaper infrastructure), DATA-020 (pruning), DATA-030 step 4, DEP-002 (worker, migrate).
Acceptance:
- BullMQ on the PG backend.
- Queue definitions, payload validation, worker roles, leader election (two processes, one leader), job schedulers from config, health server, scratch cleanup.
- `migrate` entrypoint runs all DATA-030 steps.

## M4 — Provider fakes

**T-040 Fake git and LFS server.** Depends: T-001. Tier: M.
Requirements: TST-013.
Acceptance:
- Serves bare repos over smart HTTP with Basic auth.
- LFS batch API (upload, download, verify existence).
- Configurable blob and push size rejection.

**T-041 Fake Bitbucket.** Depends: T-001, T-030. Tier: M.
Requirements: TST-010.
Acceptance:
- Every endpoint in the provider doc, responses validated against Atlassian's OpenAPI in the fake's own tests.
- No rate-limit headers, and 429s at configurable limits.
- `/__reset`, `/__state`.

**T-042 Fake GitHub.** Depends: T-001, T-031. Tier: M.
Requirements: TST-011.
Acceptance:
- Every endpoint in the provider doc, including the GraphQL branch-protection subset, App auth, rate-limit headers and secondary limits, deploy-key uniqueness and the LFS existence API.

**T-043 Fixture world.** Depends: T-040, T-041, T-042. Tier: M.
Requirements: TST-012.
Acceptance:
- Every fixture repository from TST-012 is constructible by `/__reset world`.
- A doc table lists each repository's expected readiness and findings.

## M5 — Adapters

**T-030 Bitbucket API verification.** Depends: —. Tier: M.
Requirements: FAC-MRG-002, the provider doc's [verify] items.
Acceptance:
- Every [verify] item is resolved from Atlassian's published API reference and OpenAPI document (no live calls), and the provider doc is updated.
- Deviations from the spec are recorded as `agent-decided` ADRs.

**T-031 GitHub API verification.** Depends: —. Tier: M.
Requirements: the provider doc's [verify] items, FAC-BRR-002.
Acceptance: as for T-030, for GitHub.

**T-032 Bitbucket adapter.** Depends: T-015, T-026, T-030, T-041. Tier: M.
Requirements: FAC-*-Bitbucket mappings, JOB-043, ACL inheritance (FAC-ACL-001), LIF-070 writes.
Acceptance:
- Inventory, identities and groups, all facet reads (with raw fixtures of real response shapes), source read-only apply and undo, the quota resource classifier and git access.
- Unit tests for every mapper.

**T-033 GitHub adapter.** Depends: T-015, T-026, T-031, T-042. Tier: H.
Requirements: FAC-*-GitHub mappings, JOB-045, LIF-047, AUTH-060 (writer).
Acceptance:
- Inventory, all facet reads and applies (idempotent; apply twice → no mutations the second time), repo create, delete and isEmpty, Change Request writer, invitation writer, compare, LFS existence, App token caching.

**T-034 Adapter contract suite.** Depends: T-032, T-033, T-043. Tier: M.
Requirements: TST-015.
Acceptance: the read → apply → read round-trip is equal for every facet supported by each adapter.

## M6 — Facets

Facet tasks can all run in parallel once T-012, T-014 and T-015 are merged. Each one uses its T-015 schema and implements normalize, translate (including findings and policy keys), compare, guidance entries, and unit tests for every row of its mapping table.

| Task | Facets | Depends (in addition to T-012, T-014) | Tier |
|---|---|---|---|
| T-050 | git-refs, repository-settings, merge-settings | — | M |
| T-051 | access-control, code-ownership | — | M |
| T-052 | branch-rules | — | H |
| T-053 | webhooks, deploy-keys | — | M |
| T-054 | environments, variables, secrets | — | M |
| T-055 | change-requests, extras | — | L |
| T-056 | members, teams, org-variables, org-secrets, org-webhooks | — | M |
| T-057 | pipelines (bitbucket-cloud → github pair override, FAC-PIP-002) | — | H |

T-057 acceptance: a corpus of at least 15 pipeline YAML samples (in `packages/facets/test/pipelines/`) covering every supported construct and at least 8 unsupported ones, with golden workflow outputs.

**T-058 Registry and capability matrix.** Depends: T-050 … T-057, T-032, T-033. Tier: M.
Requirements: ADP-032, API-020 (capability-matrix).
Acceptance: the registry composes everything, and the computed matrix matches the mapping tables in 05 (snapshot test).

## M7 — Inventory and analysis

**T-060 Inventory processor.** Depends: T-028, T-058, T-043. Tier: M.
Requirements: JOB-030, DOM-014, AUTH-050 step 2, FAC-DKY-003 support data.
Acceptance:
- An integration test against the fixture world creates every Namespace, Repository, Identity, Group and Migration, sets presence, and runs the identity matching cascade.

**T-061 Analysis processor and feeder.** Depends: T-060, T-043. Tier: H.
Requirements: LIF-020 … LIF-022, JOB-020, JOB-022.
Acceptance:
- Every fixture repository's readiness and findings match the T-043 table.
- The feeder respects the background pool.
- Stale marking triggers work.

**T-062 Read and command endpoints, batch 1.** Depends: T-061, T-021. Tier: M.
Requirements: API-020 rows: inventory refresh, analyze, dashboard, quota, capability-matrix, diff, naming preview.
Acceptance:
- Endpoints, plus role tests (API-021).
- `docs/api-usage.md` explains RPC and v1 usage for automation.

## M8 — Execution

**T-070 Run executor.** Depends: T-061, T-027. Tier: H.
Requirements: LIF-002, LIF-040 (framework), LIF-042, LIF-043, LIF-045, LIF-046, LIF-049, DOM-010.
Acceptance:
- Step framework, resume after delay, cooperative cancel, Mutation ledger and Expected Difference derivation, concurrency guard.

**T-071 Migration steps.** Depends: T-070. Tier: H.
Requirements: LIF-040 steps 1–12, LIF-041, LIF-044, LIF-047, LIF-048, LIF-031 adoption.
Acceptance:
- `plat/auto-ok` migrates against the fakes.
- `ops/large-history` batches.
- `ops/big-blob` blocks with no target writes.
- Adoption and force-adopt work.

**T-072 Parity and verification.** Depends: T-070. Tier: H.
Requirements: LIF-060 … LIF-062, FAC-GIT-005, FAC-GIT-006.
Acceptance:
- ParityResults stored.
- Expected Differences subtracted.
- Verifiable tasks auto-complete.
- Status becomes verified per LIF-061.

**T-073 Source read-only.** Depends: T-071, T-072. Tier: H.
Requirements: LIF-070.
Acceptance: apply and undo against the fake. A following Analysis does not translate the source lock (LIF-045 filtering).

**T-074 Run and task endpoints.** Depends: T-072. Tier: M.
Requirements: API-020 rows: runs, cancel, complete, tasks, expected-differences; LIF-005, LIF-006.
Acceptance: role tests, plus 409 and 422 behaviors.

**T-075 Phase-1 integration scenario.** Depends: T-073, T-074, T-043, T-062. Tier: M.
Requirements: TST-020 (steps 1–8).
Acceptance: green in CI.

## M9 — UI Phase 1

**T-080 Web shell.** Depends: T-021, T-022. Tier: M.
Requirements: UI-001, UI-010, UI-036.
Acceptance:
- antd plus Tailwind layering verified (a visual regression screenshot test of the shell).
- i18n, themes, role-aware navigation, sign-in and denied pages.

**T-081 Dashboard and repositories list.** Depends: T-080, T-062. Tier: M.
Requirements: UI-020, UI-021.
Acceptance: filters, sorting and pagination run server-side; selection persists across pages; live updates.

**T-082 Repository and run detail.** Depends: T-081, T-074. Tier: M.
Requirements: UI-022, UI-023, UI-040.
Acceptance: every action wired to its endpoint, diff view, guidance with copy buttons, live log.

**T-083 UI e2e with fakes.** Depends: T-082, T-075. Tier: M.
Requirements: TST-021 (Phase-1 spec).
Acceptance: green in CI.

## M10 — Phase 2

**T-084 Identity and team mapping.** Depends: T-060, T-080. Tier: M.
Requirements: AUTH-050, API-020 mapping rows, UI-027, UI-028.
Acceptance: CSV dry-run and apply; exclusion creates Expected Differences; mapping changes mark Analyses stale.

**T-085 Invitation batches.** Depends: T-084, T-033. Tier: H.
Requirements: AUTH-060, AUTH-061, UI-029.
Acceptance: an integration test where a deselection is excluded from parity, acceptance is detected via inventory, and expiry is handled.

**T-086 Endpoint migration.** Depends: T-071, T-056, T-084, T-085. Tier: M.
Requirements: LIF-080, LIF-081, UI-025, UI-026.
Acceptance: teams created against the fakes; `access-control.team-missing` clears.

**T-087 NeedsAttention flows.** Depends: T-082. Tier: M.
Requirements: LIF-043 (run anyway), LIF-075, UI-022 Tasks tab, TST-021 (second spec).
Acceptance: e2e spec green.

## M11 — Phase 3

**T-088 Waves and bulk.** Depends: T-081. Tier: M.
Requirements: LIF-090, UI-024.
Acceptance: bulk migrate-ready skips non-ready with reasons; wave priority reaches the feeder.

**T-089 Drift and rollback.** Depends: T-072, T-073. Tier: H.
Requirements: LIF-065, LIF-077, API-020 drift-accept row.
Acceptance: integration scenarios from TST-020's additional list (drift, resync, both rollback kinds), and drift ignores source read-only Mutations.

**T-091 Configuration and admin pages.** Depends: T-080, T-062. Tier: L.
Requirements: UI-030 … UI-035, the API-020 actor and key rows.
Acceptance: the naming preview prevents saving a rule that introduces collisions unless explicitly confirmed; API keys are shown once.

## M12 — Deployment

**T-090 Image, chart and release.** Depends: T-028, T-021. Tier: M.
Requirements: DEP-001 … DEP-060.
Acceptance:
- The runtime image runs as UID 10001 with a read-only root filesystem (a CI smoke test does `docker run --read-only` with tmpfs mounts and hits `/api/healthz`).
- The chart passes `helm:check` and helm-unittest.
- `release.yml` is complete.
- `docs/deployment.md` covers Azure prerequisites, Key Vault secret names, workload identity, Postgres extension allow-listing and the connection-count formula.

**T-093 devenv CI.** Depends: T-002. Tier: L.
Requirements: DEV-001, DEP-060 (`devenv.yml`).
Acceptance: the workflow passes.

## M13 — Finish

**T-095 Live e2e scaffold.** Depends: T-083, T-089, T-073. Tier: M.
Requirements: TST-030 … TST-032.
Acceptance:
- The live spec, the precondition checks, the reset script and `config.e2e.example.yaml` exist.
- [e2e-setup](../e2e-setup.md) is reconciled with the code.
- The live test type-checks and runs against the fakes in a "dry" mode (`GM_E2E_TARGET=fakes`) in CI.

**T-096 Remaining integration scenarios.** Depends: T-085, T-086, T-087, T-088, T-089. Tier: M.
Requirements: TST-020's additional list.
Acceptance: every listed scenario exists and is green.

**T-097 Final adversarial review.** Depends: all. Tier: H.
Requirements: PROC-030.
Acceptance:
- A whole-repository review against the spec.
- `pnpm spec:coverage` shows no must-test gaps.
- Docs are current.
- `docs/followups.md` is complete.
- A summary of the state is written for the human, `docs/handoff.md`: what's verified, what the human must do, and the open `agent-decided` ADRs.

## Parallelism map (informative)

The task dependencies above are authoritative; this map only shows the main lanes.

```
T-001 ─┬─ T-002 ─ T-093
       ├─ T-003
       ├─ T-004 ─ T-010 ─┬─ T-020 ─┬─ T-021 ─ T-022 ─ T-080 ─ …
       │                 │         └─ T-028
       │                 └─ T-025 ─ T-026
       ├─ T-011 ─┬─ T-012
       │         ├─ T-013
       │         ├─ T-014
       │         └─ T-015
       │               T-012 + T-014 + T-015 ─ T-050 … T-057 ─┐
       │               T-015 + T-026 + fakes ─ T-032, T-033 ──┴─ T-058 ─ T-060 ─ T-061 ─ …
       ├─ T-040 ─ T-027 (also needs T-026)
       ├─ T-041 (after T-030), T-042 (after T-031)
T-030, T-031 (start immediately)
```
