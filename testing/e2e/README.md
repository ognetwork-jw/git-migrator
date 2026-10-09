# @git-migrator/e2e

Playwright tests.

- `visual/` is the visual regression suite of the web shell (T-080). It mocks the API and has its own configuration; run it with `pnpm test:visual`.
- `*.spec.ts` in this folder is the UI e2e tier with fakes (TST-021). Run it with `pnpm test:e2e`, which builds the web app first, then starts the whole stack once (`harness/`, ADR-0485): a throw-away Postgres database, the provider fakes with the fixture world, the worker, and the standalone web build on a free port. Specs sign in through the test form as `operator@test.local` and drive the browser; they never read the database or the fakes. CI runs the tier in the `e2e` job (`.github/workflows/ci.yml`).
  - `phase1.spec.ts` (T-083): the TST-020 flow through the UI. Sign in, refresh the inventory, find `auto-ok` Ready in the unmigrated list, Migrate, watch the Run page reach Succeeded through SSE without a reload, then see the Verified tag and the changed dashboard counts.
  - `needs-attention.spec.ts` (T-087): the NeedsAttention flow on `data/unmapped-user`. It finds the repository listed as Needs attention, opens the Tasks tab (guidance, a note, the refused "Mark done" of a resolution task), runs the repository anyway (LIF-043) and watches the Run succeed over SSE, dismisses the open task so the status becomes Verified, reopens and dismisses it again, then marks the repository complete by hand and revokes it (LIF-075).
- `live/` is the live e2e (T-095, TST-030 to TST-032, ADR-0491, ADR-0492): `phase1.live.spec.ts` runs the same browser flow (`harness/phase1-flow.ts`) with the target chosen by `GM_E2E_TARGET`, then checks both providers through their own APIs (Octokit with the App credentials for GitHub).
  - `fakes` is the dry mode: the stack above, with the fakes behind the provider clients. CI runs it after the UI tier (`pnpm test:e2e:live:dry`). The fakes lack a few endpoints, so some provider assertions skip there (`skipChecks`).
  - `live` calls real Bitbucket and GitHub test accounts, only on a human's machine: `pnpm test:e2e:live` and `pnpm e2e:live:reset` (secretspec profile `e2e`, `live/config.e2e.yaml` copied from `live/config.e2e.example.yaml`; see [docs/e2e-setup.md](../../docs/e2e-setup.md)). It refuses to start in CI, without the configuration or a secret, or when a precondition of the fixture is unmet.
  - `src/live/` holds the logic, unit-tested without any network: the target guard (`target.ts`), the context (`context.ts`), the preconditions (`preconditions.ts`, TST-031), the reset (`reset.ts`, TST-032) and the clients (`ports.ts`, `app.ts`).
- `harness/` holds the stack (`stack.ts`, fakes and live), the Playwright global setup, the shared browser flow (`phase1-flow.ts`), the Chromium lookup (`chromium.ts`) and generic UI helpers (`ui.ts`).

Failed runs leave traces in `test-results/` and the web and worker logs in `logs/` (both git-ignored; CI uploads them). E2E credentials must stay fake, because traces and logs embed them.

Chromium: Playwright uses its own build, or a pre-installed one from `PLAYWRIGHT_BROWSERS_PATH` or `GM_CHROMIUM_PATH`. Never run `playwright install` from a script; CI installs the browser in the workflow only.

Declared internal dependencies (ARC-012, checked by `pnpm lint`): config, db, fixtures, observability, provider-fakes, worker (the harness and `src/live/`).

A live run writes its logs and failure screenshots to `live-artifacts/` (git-ignored, never uploaded) and records no trace: they can hold real secrets, and the web log is raw Next.js output. Read before sharing.
