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

Declared internal dependencies (ARC-012, checked by `pnpm lint`): @git-migrator/api, @git-migrator/auth, @git-migrator/config, @git-migrator/observability, @git-migrator/db, @git-migrator/facets (T-091, ADR-0366).

## Live updates (JOB-060)

`src/live/`: `createLiveConnection` (framework-free: `EventSource` with reconnect backoff 1 s to 30 s, a 45 s watchdog, polling every 10 s when SSE is silent or unavailable, a catch-up invalidation after every reconnect) and the `useLiveInvalidation({ topics, queryKeysFor? })` hook, which invalidates the TanStack Query keys of the topics that changed (default key `liveQueryKey(topic)` = `['live', topic]`) and returns the mode (`connecting`, `sse`, `polling`). Views pass `queryKeysFor` to map topics onto their ZenStack or API query keys. The server side is `GET /api/v1/events`; `src/server/api.ts` builds the one event hub of the process and closes it on shutdown.

## Mapping pages (UI-027, UI-028, T-084)

`/people/identities` (`src/mapping/identity-mapping-view.tsx`, with the CSV import Drawer in `csv-import-drawer.tsx`) and `/people/teams` (`group-mapping-view.tsx`). Data comes only from `/api/v1` through `src/mapping/api.ts` and `src/api/http.ts` (`ApiError` carries the problem `code`). The pages are gated on the server by `authorizePage` (`src/server/authorize.ts`, ADR-0321): it resolves the Actor through the API in process with the caller's cookie and redirects to `/signin` or `/denied` before rendering. Later data pages call it the same way. Strings are under `mapping.*` in `messages/en.json`; CSV error codes render from `mapping.csv.error.<code>`.

## Configuration and admin pages (UI-030 to UI-035, T-091)

- `/config/naming` (`src/config/naming-view.tsx`, pure logic in `naming-draft.ts`): namespace and repository rules, the pipeline or literal-override editor, and the save gate. Save waits for a preview of the exact body and, when the preview lists collisions, for the operator's confirmation (ADR-0363). The Route default is shown read-only (ADR-0361).
- `/config/webhook-allowlist` (`webhook-view.tsx`): CRUD and a pattern tester that runs `matchesPattern` from `@git-migrator/facets/webhooks-match` in the browser (ADR-0366). `rules-draft.ts` holds the pattern and overlay validation.
- `/config/overlays` (`overlays-view.tsx`): a JSON object per Facet, checked in the browser against the Facet schema in deep-partial strict form and written through the validated `/api/v1/overlays` endpoints, not RPC (ADR-0362).
- `/config/capabilities` (`capabilities-view.tsx`): the static matrix pivoted per adapter pair, the non-exact fields of a chosen pair, and each Route's accepted lossy policies (ADR-0367).
- `/admin/actors` (`src/admin/actors-view.tsx`): Actors, service Actor creation, disable and enable, and API keys. A key is shown once in a dialog and kept nowhere after it closes (ADR-0365). Role changes are not offered (ADR-0369).
- `/admin/audit` (`src/admin/audit-view.tsx`): the audit log with filters and cursor paging (ADR-0368).
- Data: `src/model/rpc.ts` is the thin client for the ZenStack RPC mount (`/api/model`, ADR-0360). Writes that the API owns (actors, keys, the matrix) go through `/api/v1` and `src/api/http.ts`. The page modules `src/config/api.ts` and `src/admin/api.ts` name each call.
- Each page is gated on the server by `authorizePage` (ADR-0321) and the sidebar capability (`src/shell/navigation.ts`).
- Tests use mocked fetch (`src/test-api.ts`); no request leaves the test (TST-006).

## Dashboard and repositories (UI-020, UI-021, T-081)

`/` (`src/dashboard/`) shows per-Route counts, Wave progress, quota gauges and the last 20 Runs from `GET /api/v1/dashboard` and `GET /api/v1/quota`; it renders `wavesTruncated` and `backlogTruncated` as notices. `/repositories` (`src/repositories/`) reads the Model API: `query.ts` builds the `findMany` arguments (filters, sort, `skip`/`take` of 50) so the server filters, sorts and pages; `selection.ts` keeps the selected Migration ids across pages, sorts and filters and `RepositoriesView` passes them to a `bulkBar(selection)` render prop for T-088. Row actions are Analyze only: Migrate and Run anyway arrive with the Run endpoint (T-074), together with the typed `confirm` and the 409/422 messages. `/repositories?route=&status=&readiness=` opens a pre-filtered list. Both pages call `authorizePage` first. Live updates: the shell owns the one connection (`src/shell/live-topics.tsx`); a view adds its topics with `useLiveTopics(topics, queryKeysFor)`. Never open a stream per page or row (16 per Actor, ADR-0270). Decisions: ADR-0350.
