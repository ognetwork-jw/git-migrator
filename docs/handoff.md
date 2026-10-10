# Handoff

This is the state of git-migrator when the agent build ended (T-097, PROC-030). It covers:

- what has been verified, and how;
- what you need to do next;
- the decisions the agents made on their own, which you still need to approve.

Every task in [docs/process/progress.md](process/progress.md) is merged into `ai-main`. Nothing has been merged to `main`; agents never push there. Promoting `ai-main` to `main` is your decision.

## What's verified

All of the following runs in CI on every pull request to `ai-main`. CI was green on every merged head.

| Check | What it covers |
|---|---|
| Lint, typecheck, unit tests | about 6,200 tests, with coverage thresholds enforced (TST-005) |
| `pnpm spec:coverage -- --strict` | Every must-test requirement ID has a test that names it. The CI run fails if one is missing (TST-002). |
| Integration tests | about 340 tests against Postgres and the provider fakes. They cover the Phase-1 scenario (TST-020) and every additional TST-020 scenario; `testing/integration/README.md` maps each scenario to its test. |
| UI e2e | Playwright against the production web build, the real API and worker, and the fakes. It runs the Phase-1 spec and the NeedsAttention spec (TST-021), and proves live updates arrive over SSE. |
| Live e2e, dry mode | The live spec runs against the fakes (`GM_E2E_TARGET=fakes`). Some assertions skip because the fakes lack those endpoints. |
| Docker image | The image is built and smoke-tested with a read-only root filesystem as UID 10001. The test checks that it serves the sign-in page, health, readiness and metrics, and exits 0 on SIGTERM. |
| Helm | lint and helm-unittest |
| gitleaks | secret scan of the full history |

The final whole-repository review (T-097, two reviewers on opus) also confirmed these points:

- **Layering.** Package layering holds (ARC-012, `tools/check-deps.ts`). The web tier makes no provider calls and has no server actions (static guards).
- **Auth.** Writes made with a cookie session require Origin to equal `publicUrl`. The tenant and role gates work. Test sign-in is refused in production. API keys are looked up by prefix and compared in constant time.
- **Provider access.** Pagination and redirects stay on the Endpoint's origin. Git remotes carry no userinfo, and the askpass helper answers only its own host.
- **Data safety.**
  - A target repository is deleted only on ledger proof plus a provider-id check.
  - Rollback is refused while the source is read-only.
  - One active Run per Migration is enforced.
  - A Route whose target is changed after the framework wrote to it no longer splits a Migration (ADR-0504).
- **Secrets.** Log redaction has tests for every reported leak shape and stays linear-time on 5 MB inputs (ADR-0052). Viewers cannot read webhook URLs that may carry credentials (ADR-0503).
- **Deployment.** The image serves the Next.js UI and the API from one process (ADR-0500). Helm sets a read-only root filesystem. Shutdown finishes within the grace period.

**Not verified.** Nothing has run against real Bitbucket, GitHub, Entra or Key Vault, because the build environment had no accounts. All provider behavior is checked against the fakes and the provider docs only.

## What you must do

### 1. Run the live e2e test first
This is the validation the spec expects (00-overview). Follow [docs/e2e-setup.md](e2e-setup.md):

- create the Bitbucket and GitHub fixtures and the GitHub App;
- copy `config.e2e.example.yaml`;
- run `pnpm test:e2e:live`, then `pnpm e2e:live:reset`.

Expect small fixes on the first run. The request shapes were never tried against the real APIs. The first run also confirms several assumptions:

- **Bitbucket:** the 11 unverified items in ADR-0036, the `fork_policy` value for "Allow only private forks", and the workspace `owner` role (T-030, T-032).
- **GitHub:**
  - push-rejection wording and the git stderr fragments that `classifyGitFailure` matches (T-040, T-027);
  - the deploy-key "already in use" body, whether a GitHub App may delete repositories, and environment protection on private Team-plan repos (T-042);
  - force-push bypass behavior (ADR-0040).
- **Timing:** whether `slow: 6` is enough for live Run timing (T-095).

### 2. Before a production release
- **Entra:** run the sign-in smoke test against a real tenant ([e2e-setup.md §5](e2e-setup.md)). The redirect URI is `<publicUrl>/api/auth/callback/microsoft`.
- **Key Vault:** check the Key Vault secret names against secretspec on a real vault (T-090).
- **Release gate:** create the GitHub environment `release` with required reviewers. Until it exists, the release workflow's approval gate does nothing (T-090).
- **Postgres:** size `max_connections` by the DATA-010 rule in [docs/deployment.md](deployment.md). The defaults need at least 137; 147 is recommended.

### 3. Decide the open security item
**The PROC-012 guard can be bypassed** (T-003, MAJOR). It can be bypassed through git subcommands that run commands: `git rebase --exec`, `git bisect run`, `git filter-branch --tree-filter` and `git submodule foreach`. The agents deliberately did not change their own guard. Either make `.claude/hooks/guard-bash.sh` fail closed on these, or accept the risk in ADR-0047.

### 4. Approve or reverse the agent-decided ADRs
These ADRs are `Status: agent-decided`. Each one records a decision where the spec was silent or contradictory. Read each, then either fold it into `docs/spec` or reverse it.

| ADR | Decision |
|---|---|
| [0425](0425-source-read-only-steps.md) | Source read-only: step 14 conditions, the two Run kinds, ledgering, undo, and what the Analysis filter removes |
| [0445](0445-repository-and-run-detail-pages.md) | Repository and Run detail pages: names instead of provider links, action rules, rollback sequencing, log bounds |
| [0446](0446-guidance-mount-and-reusable-view.md) | Mounting the guidance catalog and the reusable guidance view |
| [0455](0455-ci-outage-local-gate.md) | Local gate while GitHub Actions cannot run jobs |
| [0465](0465-rollback.md) | Rollback: guard availability and "undo first", deletion only on ledger proof, adopted targets reverted newest first, endpoint Runs unmap undone teams |
| [0466](0466-drift-checks.md) | The drift sweep, drift checks (refs-only source read, LFS skip, containment) and accepting drift |
| [0467](0467-facet-driver-undo.md) | Facet drivers revert their own records (`FacetDriver.undo`) |
| [0475](0475-integration-tier-and-phase1-scenario.md) | The integration tier (Vitest project, script, CI job) and how the Phase-1 scenario is composed |
| [0485](0485-ui-e2e-harness.md) | How the UI e2e tier (TST-021) starts its stack: global setup, fakes, in-process worker, standalone web |
| [0486](0486-bullmq-external-to-the-web-bundle.md) | The queue library is external to the web bundle, so the standalone build can enqueue |
| [0490](0490-ci-image-mirrors.md) | CI pulls container images from public mirrors (mirror.gcr.io) instead of Docker Hub |
| [0491](0491-live-e2e-target-switch.md) | The live e2e chooses its target with `GM_E2E_TARGET` and fails closed; the dry mode runs in CI |
| [0492](0492-live-e2e-stack-fixture-and-reset.md) | Live e2e stack, fixture constants and reset |
| [0500](0500-web-entrypoint-runs-next-standalone.md) | The web entrypoint runs the Next.js standalone build in process, keeping metrics, tracing and the drain |
| [0503](0503-viewers-do-not-read-snapshot-data.md) | Viewers do not read Snapshot data or Analysis translations through RPC (webhook URLs may carry credentials); amends ADR-0331 |
| [0504](0504-route-retarget-and-rollback.md) | A Route retargeted after the framework wrote its target: the place is pinned, Runs refused with a blocker, rollback where the writes went, earlier repositories left and reported |
| [0506](0506-illustrative-requirement-ids.md) | Illustrative IDs in the overview are not requirements |

Two of them change normative spec text, so they need your decision specifically:
- **ADR-0503** narrows AUTH-020 and API-012. Viewers no longer read Snapshot data, Analysis translations, or task and finding secret parameters. If you approve it, add those fields to the exception lists in the spec.
- **ADR-0504** refuses `verify` while the target is outside the Route. It is a placement check, not a readiness gate. Confirm this against LIF-005's wording.

Also decide whether you want a per-Route cap on concurrent Runs (T-070). The spec has none beyond one active Run per Migration (ADR-0343).

### 5. Review the open follow-ups
[docs/followups.md](followups.md) lists every unresolved finding and deferred item, including every review loop that reached the 5-round cap. At handoff:

- 0 BLOCKER, 1 MAJOR, 209 MINOR, 63 deferred and 6 flake entries are open.
- Open MAJOR:
  - T-003: PROC-012 guard: git subcommands that run commands bypass it — `git rebase -x/--exec "git push origin main" …`, `git bisect run sh -c …`, `gi
- Most MINOR entries are hardening, test-strength or wording items from capped review loops. The `deferred` entries are work handed between tasks, or items that need a human, staging access or real accounts (many are listed above).

## Housekeeping
- **CI images.** CI pulls container images through `mirror.gcr.io`, pinned by digest, because Docker Hub refuses the runners' anonymous pulls (ADR-0490). The release workflow's QEMU step still pulls `tonistiivi/binfmt` from Docker Hub.
- **Leftover directory.** `/tmp/gm-t096-kr08tv` (12 KB) is left over on the build machine from a crashed test run. The agents' guard blocked its removal. It only matters if that machine is reused.
