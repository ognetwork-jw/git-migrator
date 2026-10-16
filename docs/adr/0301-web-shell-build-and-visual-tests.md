# ADR-0301: Web shell build, standalone server and visual test placement

- Status: accepted (no spec change needed)
- Date: 2026-10-08

## Context

T-080 adds Next.js, antd and Tailwind (pins from ADR-0002) and needs a screenshot test of the layering (UI-001). Several points are not specified.

## Decision

- `next.config.ts` sets `output: 'standalone'` with the workspace root as tracing root; the server is `.next/standalone/apps/web/server.js`. `apps/web/scripts/start-standalone.mjs` (`pnpm --filter @git-migrator/web start`) copies the static assets in and maps HOST/PORT. T-090 can replace `src/web.ts` with this server.
- `apps/web` `build` is `tsc -b && next build` (Next's own type check needs the referenced projects built). `pnpm dev` runs `next dev`; the T-002 placeholder server is removed.
- Layer order is declared first in `globals.css`: `theme, base, antd, components, utilities`; `AntdRegistry layer` emits antd styles into `antd`.
- Layout colors use Tailwind `dark:` variants (media based, matching the antd algorithm); antd components use `theme.algorithm`.
- The shell loads the Actor client-side from `GET /api/v1/me` and redirects; `/signin` reads only the configuration (`auth.testSignIn.enabled`) on the server.
- The visual suite lives in `testing/e2e/visual` (Playwright 1.64.0, mocked API, baselines in `__screenshots__`, Linux only, 1.5% pixel tolerance, fonts forced to DejaVu Sans). Playwright falls back to a Chromium in `PLAYWRIGHT_BROWSERS_PATH` when its own revision is missing. Run it with `pnpm test:visual`.
- `tsconfig.tests.json` gains the DOM lib (component tests); one cast in a provider-fakes test keeps it compiling.
- `@parcel/watcher` and `@swc/core` (optional next-intl tooling) have install scripts disabled in `pnpm-workspace.yaml`.

- **Playwright is excluded from pnpm's release-age policy.** `pnpm-workspace.yaml` lists `@playwright/test@1.64.0`, `playwright@1.64.0` and `playwright-core@1.64.0` under `minimumReleaseAgeExclude`. ADR-0002 pins `@playwright/test` 1.64.0, and that release was younger than pnpm's minimum release age when T-080 added it, so the install refused it. `playwright` and `playwright-core` are its exact-version dependencies. The exclusions name exact versions, so any other version still goes through the policy; remove them once 1.64.0 is older than the window (as for `@hono/node-server`, ADR-0061).
- **Server-only modules.** `src/server/api.ts` and `src/server/settings.ts` must never reach a browser bundle. They do not import `server-only`: `api.ts` is also loaded outside Next.js, by `src/web.ts` (ADR-0500) and the integration stack, where that package throws because the `react-server` condition is not set, and the package is not a dependency. Instead `src/server-boundary.test.ts` walks the run-time imports of every `'use client'` module, transitively, and fails if any reaches `src/server/` (type-only imports are erased and allowed). This also catches a path through a shared helper, which a marker in the two files would only catch at build time.

## Affected requirements

UI-001, UI-010, UI-036, TST-005.
