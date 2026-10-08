# 14 — Testing

## Tiers (TST-001)

| Tier | Tool | Scope | Runs in CI |
|---|---|---|---|
| Unit | Vitest | Pure logic: `core`, `facets`, naming, translation, parity, state machine, quota math, guidance coverage, config parsing, adapter mappers (fixtures of real provider JSON) | ✓ |
| Integration | Vitest | API + worker processors + Postgres + provider fakes + git http-backend; real BullMQ on Postgres | ✓ |
| UI e2e (fakes) | Playwright | The full app (web + worker) against the fakes, signed in via test sign-in | ✓ |
| Live e2e | Playwright | The same flow against real Bitbucket and GitHub test accounts | ✗ (human, on demand) |

- **TST-002** Tests name the requirement IDs they cover, as in `it('[FAC-BRR-002] maps restrictPushes to restrictions')`. A script (`pnpm spec:coverage`) lists requirement IDs from `docs/spec` with no referencing test. CI prints the list. It fails only for IDs in a `must-test.txt` allowlist that T-001 initializes with every LIF, FAC, JOB-04x and AUTH-0xx ID. Until T-097 it runs report-only in CI; `--strict` enables the gate, and T-097 switches CI to strict (ADR-0029). An ID counts only in the title of a test that actually runs (not skipped, todo or conditional).
- **TST-005 Coverage thresholds** (Vitest v8, enforced per package through glob thresholds by the root `pnpm test`, which CI runs; ADR-0030). In packages and apps only `*.test.*` files are tests; they are type-checked by `tsconfig.tests.json` through the root `pnpm typecheck`: `core` and `facets` ≥ 90% lines and branches; `quota`, `git`, adapters, `api`, `jobs` ≥ 80% lines; apps ≥ 60% lines.
- **TST-006** No test may call a real provider, except the live e2e. The provider HTTP client refuses non-allowlisted hosts when `GM_ENVIRONMENT=test`.

## Provider fakes (TST-010)

`testing/provider-fakes` is a Hono server with in-memory state, a reset endpoint (`POST /__reset` with a fixture name) and a state inspection endpoint (`GET /__state`).

- **TST-010 Fake Bitbucket Cloud.** It implements every endpoint listed in [providers/bitbucket-cloud](../providers/bitbucket-cloud.md#endpoints-used), including:
  - response shapes taken from Atlassian's published OpenAPI document (stored in `testing/provider-fakes/specs/` and used to validate fake responses in its own tests);
  - `next`-link pagination and `pagelen`;
  - Basic auth with email + API token;
  - **no rate-limit headers**, with 429s enforced at the documented limits. Limits can be configured per test so throttling can be exercised.
- **TST-011 Fake GitHub.** It implements every endpoint listed in [providers/github](../providers/github.md#endpoints-used), including:
  - response shapes validated against GitHub's published REST OpenAPI description;
  - the App JWT → installation token exchange (any key accepted, but the JWT structure is checked);
  - `x-ratelimit-*` headers and configurable secondary-limit 403s;
  - `Link` pagination;
  - branch protection, teams, invitations and the LFS batch API;
  - `key is already in use` for duplicate deploy keys.
- **TST-013 Git.** A `git http-backend` CGI behind a small Node HTTP server serves bare repositories for both fakes (separate roots per fake). It supports LFS through a minimal LFS server implementing the batch API with basic transfer. The fake GitHub side enforces a configurable max blob size (default 100 MiB, lowered in tests) and a max push size, rejecting the push like GitHub does.
- **TST-012 Fixture world** (`testing/fixtures/world.ts`). One workspace `acme` with projects `PLAT`, `DATA` and `OPS`, and repositories covering:
  - `plat/auto-ok`: Ready, and mirrors the live fixture in [e2e-setup](../e2e-setup.md). Branches, annotated and lightweight tags, LFS, branch restrictions (force and delete only, no principal lists), a repository-level deploy key used nowhere else, unsecured variables, an environment. No explicit permissions, no project-level grants or keys in project `PLAT`, no pipelines, webhooks or open PRs.
  - `data/with-grants` (project `DATA`): user and group grants plus a push restriction naming a group. Before the endpoint migration it is Blocked (`access-control.team-missing`). After the endpoint migration and identity confirmation it is Ready. This is covered by T-086, not by the Phase-1 scenario.
  - `plat/with-secrets`: Ready plus a post task (`secrets.set-value`).
  - `plat/open-pr`: Blocked (`change-requests.open`).
  - `data/unmapped-user`: NeedsAttention (`access-control.unmapped-principal`).
  - `data/pipelines-simple`: fully translatable pipelines.
  - `data/pipelines-pipes`: partially translatable.
  - `ops/hooks`: one allowlisted webhook and one non-allowlisted webhook with a secret.
  - `ops/big-blob`: a 2 MiB blob, with the fake limit set to 1 MiB. Analysis says Ready (blobs are only inspected during a Run). The first migrate Run fails at `git.prepare` with run-origin blocker `git-refs.blob-too-large` (LIF-049), after which the Migration is Blocked.
  - `ops/large-history`: many commits, with the fake push limit set low, to exercise batching (LIF-044).
  - `ops/name-collision-a` and `ops/name_collision_a`: collide after naming.
  - `keys/shared-key-1` and `-2` (their own project `KEYS`): the same project access key → `deploy-keys.key-in-use`.
  - `ops/wiki-issues`: detect-only warnings.
  - A GitHub org `acme` with no repositories, and members matching some Bitbucket members by email and by login. No teams exist.

## Contract tests (TST-015)

Each adapter has a contract suite: read every Facet, apply it, then read back to the same canonical document. It runs against the fakes in the integration tier. The suite is parameterized by a connection factory, so the same suite could run live later (not in v1 CI).

## Phase-1 scenario (TST-020)

Integration tier, `testing/integration/phase1.test.ts`. It mirrors the human's live e2e (Q5):

1. Sign in as `operator@test.local` (API session).
2. `POST /inventory/refresh`, then wait for inventory jobs to finish.
3. List Migrations, filtered to unmigrated. Assert the fixture repositories are listed with the expected readiness. `plat/auto-ok` must be `ready`, after the background feeder or an explicit analyze.
4. `POST /migrations/{auto-ok}/runs {kind: migrate}`. Wait for the Run to finish.
5. Assert the Run `succeeded`, Migration `verified`, and every written ParityResult `equal` (facets with `compareMode: none` write none).
6. Assert directly against the fake GitHub state: refs equal by SHA, LFS objects present, settings, branch protection, collaborators and teams, deploy key, variables and environment.
7. Assert the source is read-only: branch restriction `*` present, description prefixed.
8. Assert the status is reflected in `GET /dashboard` and the list.

Additional integration scenarios MUST cover:

- every fixture repository's expected readiness;
- run-anyway on `data/unmapped-user`;
- secrets post-task completion leading to verified;
- the blob blocker;
- batched push;
- drift detection after mutating fake GitHub, and resync;
- rollback of a created target and of an adopted target;
- undo source read-only;
- invitation batch with a deselection, plus parity;
- the endpoint migration creating teams;
- the quota ledger throttling with the fake's 429;
- SSE events emitted for a Run.

## UI e2e with fakes (TST-021)

`testing/e2e/phase1.spec.ts` runs the TST-020 flow through the browser:

1. Sign in with the test form.
2. Click "Refresh inventory" and wait for the progress toast.
3. Open Repositories (default filter unmigrated), find `auto-ok`, and check that the Ready tag is visible.
4. Click **Migrate**.
5. Watch the Run page reach Succeeded through SSE, without reloading.
6. Return to the repository and assert the "Verified" tag. Assert the dashboard counts changed.

A second spec covers NeedsAttention: open the task list, click Run anyway, complete a task, and see the status change.

## Live e2e (TST-030 … TST-032)

- **TST-030** `testing/e2e/live/phase1.live.spec.ts` uses the same steps as TST-021, with targets switched through config profile `e2e` (`GM_CONFIG_FILE=testing/e2e/live/config.e2e.yaml` plus secretspec profile `e2e`). Assertions against GitHub use Octokit with the App credentials; there is no fake state access.
- **TST-031** Before acting, the live test verifies its preconditions and fails with an explicit, actionable message per unmet precondition ("Bitbucket repository e2e-auto-ok not found in project E2E", "GitHub App lacks permission administration:write"). Preconditions are listed in [e2e-setup](../e2e-setup.md).
- **TST-032** `pnpm e2e:live:reset` deletes the target repository and undoes the source read-only changes, so the test can be rerun. It is idempotent and uses the app's own rollback and undo code paths when the app DB has the records, and direct provider calls otherwise.
- The live e2e uses test sign-in (Q66). Running against Entra is a separate manual smoke step described in e2e-setup.
