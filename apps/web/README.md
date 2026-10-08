# @git-migrator/web

Next.js app: UI and Hono API.

Status: the API is mounted (T-021); the UI shell is a later task (T-080). `pnpm dev` still runs the placeholder server in `src/dev-server.ts`, which does not serve the API yet.

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
