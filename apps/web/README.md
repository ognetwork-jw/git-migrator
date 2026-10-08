# @git-migrator/web

Next.js app: UI and Hono API.

Status: the API is mounted (T-021) and the UI shell exists (T-080). `pnpm dev` runs `next dev` (HOST and PORT honoured).

## UI shell (UI-001, UI-010, UI-036)

- `app/` is the App Router: `layout.tsx` (next-intl, `AntdRegistry layer`, theme and query providers), `(shell)/` (signed-in pages inside the sidebar layout), `signin`, `auth/error`. Pages the later UI tasks build answer through `(shell)/[...slug]` until they exist.
- CSS: `app/globals.css` declares the layer order `theme, base, antd, components, utilities`, so Tailwind utilities beat antd, which beats Tailwind's reset. Do not reorder it. Themes follow the OS (`theme.algorithm` plus Tailwind `dark:`).
- `src/shell/navigation.ts` is the single table of sidebar items and their capability (ADR-0300). `app-shell.tsx` loads the Actor from `GET /api/v1/me`, redirects signed-out visitors to `/signin?next=` and Actors without the role to `/denied?required=<role>`. Server routes still enforce permissions.
- Strings: every text is in `messages/en.json`; a test fails on literal JSX text. The live indicator shows the `polling` mode of `useLiveInvalidation` (`shell.live.polling`).
- Sign-in: Entra button, plus the test form when `auth.testSignIn.enabled` (read on the server by `src/server/settings.ts`). `/auth/error?error=<code>` renders `auth.error.<code>`.
- Antd compound components (`Typography.Title`, ...) must be used from client components; server pages use `src/ui/page-heading.tsx`.
- Build: `pnpm --filter @git-migrator/web build` (`tsc -b && next build`, standalone output). `pnpm --filter @git-migrator/web start` runs `.next/standalone` (ADR-0301).
- Visual regression: `pnpm test:visual` (Playwright in `testing/e2e/visual`, mocked API). Update baselines with `pnpm --filter @git-migrator/e2e exec playwright test --config visual/playwright.config.ts --update-snapshots` after a build.

## Production entrypoint (DEP-002, ADR-0290)

`src/web.ts` is what the image runs as `web` (`/app/dist/web.js`). Until the Next.js app lands it serves the Hono API (`/api/healthz`, `/api/readyz`, `/api/v1`, `/api/auth`) with `@hono/node-server` on port 3000 (`PORT`, `HOST`), starts the metrics server on `metrics.port` and tracing, and on SIGTERM stops accepting connections, finishes in-flight requests, cuts streams still open after 20 s and exits 0. T-080 swaps the server for the Next.js standalone one.

## API mount (API-001)

- `app/api/[[...route]]/route.ts` is the Next.js route handler (Node.js runtime, `hono/vercel` `handle`). It forwards every method to the Hono app of `@git-migrator/api`, built on first use.
- `src/server/api.ts` is the composition root: `buildApiRuntime(env)` loads the configuration, opens the database pool and Better Auth (secrets from `POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET`), and calls `createApiApp`.
- `messages/en.json` holds every user-facing string. `problem.<code>` has the text of each API problem code; `auth.error.<code>` the sign-in error page texts.
- UI code takes display name and email from the Actor (`GET /api/v1/me`), never from `session.user`, which holds a synthetic address (ADR-0171). It must not import `@git-migrator/*/testing` from non-test files.

Declared internal dependencies (ARC-012, checked by `pnpm lint`): @git-migrator/api, @git-migrator/auth, @git-migrator/config, @git-migrator/observability, @git-migrator/db.

## Live updates (JOB-060)

`src/live/`: `createLiveConnection` (framework-free: `EventSource` with reconnect backoff 1 s to 30 s, a 45 s watchdog, polling every 10 s when SSE is silent or unavailable, a catch-up invalidation after every reconnect) and the `useLiveInvalidation({ topics, queryKeysFor? })` hook, which invalidates the TanStack Query keys of the topics that changed (default key `liveQueryKey(topic)` = `['live', topic]`) and returns the mode (`connecting`, `sse`, `polling`). Views pass `queryKeysFor` to map topics onto their ZenStack or API query keys. The server side is `GET /api/v1/events`; `src/server/api.ts` builds the one event hub of the process and closes it on shutdown.
