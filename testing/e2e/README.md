# @git-migrator/e2e

Playwright tests.

- `visual/` is the visual regression suite of the web shell (T-080). It mocks the API and has its own configuration; run it with `pnpm test:visual`.
- `*.spec.ts` in this folder is the UI e2e tier with fakes (TST-021). Run it with `pnpm test:e2e`, which builds the web app first, then starts the whole stack once (`harness/`, ADR-0485): a throw-away Postgres database, the provider fakes with the fixture world, the worker, and the standalone web build on a free port. Specs sign in through the test form as `operator@test.local` and drive the browser; they never read the database or the fakes. CI runs the tier in the `e2e` job (`.github/workflows/ci.yml`).
  - `phase1.spec.ts` (T-083): the TST-020 flow through the UI. Sign in, refresh the inventory, find `auto-ok` Ready in the unmigrated list, Migrate, watch the Run page reach Succeeded through SSE without a reload, then see the Verified tag and the changed dashboard counts.
- `harness/` holds the stack (`stack.ts`), the Playwright global setup, and generic UI helpers (`ui.ts`).

Failed runs leave traces in `test-results/` and the web and worker logs in `logs/` (both git-ignored; CI uploads them). E2E credentials must stay fake, because traces and logs embed them.

Chromium: Playwright uses its own build, or a pre-installed one from `PLAYWRIGHT_BROWSERS_PATH` or `GM_CHROMIUM_PATH`. Never run `playwright install` from a script; CI installs the browser in the workflow only.

Declared internal dependencies (ARC-012, checked by `pnpm lint`): config, db, fixtures, observability, provider-fakes, worker (the harness).
