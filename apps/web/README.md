# @git-migrator/web

Next.js app: UI and Hono API.

Status: the API is mounted (T-021); the UI shell is a later task (T-080). `pnpm dev` still runs the placeholder server in `src/dev-server.ts`, which does not serve the API yet.

## API mount (API-001)

- `app/api/[[...route]]/route.ts` is the Next.js route handler (Node.js runtime, `hono/vercel` `handle`). It forwards every method to the Hono app of `@git-migrator/api`, built on first use.
- `src/server/api.ts` is the composition root: `buildApiRuntime(env)` loads the configuration, opens the database pool and Better Auth (secrets from `POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET`), and calls `createApiApp`.
- `messages/en.json` holds every user-facing string. `problem.<code>` has the text of each API problem code; `auth.error.<code>` the sign-in error page texts.
- UI code takes display name and email from the Actor (`GET /api/v1/me`), never from `session.user`, which holds a synthetic address (ADR-0171). It must not import `@git-migrator/*/testing` from non-test files.

Declared internal dependencies (ARC-012, checked by `pnpm lint`): @git-migrator/api, @git-migrator/auth, @git-migrator/config, @git-migrator/observability, @git-migrator/db.

## Live updates (JOB-060)

`src/live/`: `createLiveConnection` (framework-free: `EventSource` with reconnect backoff 1 s to 30 s, a 45 s watchdog, polling every 10 s when SSE is silent or unavailable, a catch-up invalidation after every reconnect) and the `useLiveInvalidation({ topics, queryKeysFor? })` hook, which invalidates the TanStack Query keys of the topics that changed (default key `liveQueryKey(topic)` = `['live', topic]`) and returns the mode (`connecting`, `sse`, `polling`). Views pass `queryKeysFor` to map topics onto their ZenStack or API query keys. The server side is `GET /api/v1/events`; `src/server/api.ts` builds the one event hub of the process and closes it on shutdown.
