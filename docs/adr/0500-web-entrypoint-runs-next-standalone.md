# ADR-0500: The web entrypoint runs the Next.js standalone build in process

- Status: agent-decided
- Date: 2026-10-09
- Task: T-097
- Affects: DEP-001, DEP-002, DEP-003, DEP-030, DEP-050, API-001, ARC-020

## Context

DEP-002 says that for `web`, `/app/dist/web.js` starts the Next.js standalone server. Until T-097, `web.js` ran `apps/web/src/web.ts`, which served only the Hono API with `@hono/node-server`. T-080 and T-090 each deferred the swap to the other (ADR-0290 point 4), so the image had no UI. The review of T-097 found this.

The image needs more than what the generated `.next/standalone/apps/web/server.js` does:

- the Prometheus metrics server on its own port (DEP-050) and OpenTelemetry tracing, started before any request is handled;
- the drain on SIGTERM (DEP-030, ADR-0290): stop accepting connections, let requests finish, cut streams still open after 20 s, close the API runtime (database pool, event hub, queue connections), exit 0. `server.js` installs its own signal handlers, which close the server and exit at once.

Two more things are not covered by the spec:

- `next build` leaves `.next/static` (and `public`) outside the standalone folder.
- The standalone server writes its cache under its own `.next/cache`, which is `.next/standalone/apps/web/.next/cache`. The chart mounts its `emptyDir` at `/app/apps/web/.next/cache` (DEP-003), and the root filesystem is read-only.

## Decision

1. **`web.ts` loads the standalone build in its own process** through Next.js's programmatic server API. `prepareNextHandler` reads the build's configuration from `.next/required-server-files.json`, sets `__NEXT_PRIVATE_STANDALONE_CONFIG` as `server.js` does, resolves `next` from the standalone folder's traced `node_modules`, and calls `next({ dev: false, dir, conf, hostname, port, customServer: true })`. `web.ts` owns the `http` server (`startWebServer`), so it keeps the metrics server, tracing and the drain. In next 16.4.0 only `startServer` (what `server.js` calls) reads `NEXT_MANUAL_SIG_HANDLE`, and the programmatic server installs no signal handlers. `web.ts` still sets `NEXT_MANUAL_SIG_HANDLE=true` as defence in depth, so that if a later release adds handlers on this path, the shutdown stays with `web.ts`. The process changes its working directory to the standalone folder, as `server.js` does. `GM_WEB_STANDALONE_DIR` can override the folder.
2. **A bounded shutdown.** On SIGTERM, `web.ts` first drains the `http` server (`DRAIN_MS`, 20 s). It then closes Next.js, the metrics server, the API runtime and the tracing exporter, each bounded by `CLOSE_STEP_TIMEOUT_MS` (1 s). An unref'd hard deadline exits 0 after `SHUTDOWN_DEADLINE_MS`, which is 23 s: the chart's `web.terminationGracePeriodSeconds` (30 s) minus the `preStop` sleep (5 s) minus 2 s. The constants live in `web.ts`, and a test ties them to `values.yaml` and the template. So the pod exits 0 inside its grace period even with open event streams or an unreachable OTLP endpoint.
3. **One API runtime per process.** `web.ts` runs from source with type stripping, and the Next.js server bundle holds its own copy of `src/server/api.ts`. The runtime is therefore kept on `globalThis` under `Symbol.for('git-migrator.web.api-runtime')`. `web.ts` builds it before Next.js loads (`setApiRuntime`). The route handler and `authorizePage` pick it up through `getApiRuntime`, and `web.ts` closes it on SIGTERM (`closeApiRuntime`). Closing leaves a marker, so from then on `getApiRuntime` throws `ApiRuntimeUnavailableError` and never builds a new runtime during shutdown. It builds one lazily only when `setApiRuntime` was never called (`next dev`, tests). The result is one database pool and one LISTEN connection, the same budget as DATA-010 counts.
4. **The build stage completes the standalone folder** after `pnpm turbo run build`. It copies `apps/web/.next/static` into `.next/standalone/apps/web/.next/static`, and `apps/web/public` if it exists. It replaces the build cache in `apps/web/.next/cache` with an empty directory, and, after checking that `next build` left no cache directory there, it links `.next/standalone/apps/web/.next/cache` to `../../../../cache`, which is `/app/apps/web/.next/cache`. The chart and the smoke test mount a writable volume there. The runtime stage already copies `apps/`, so the standalone folder is in the image.
5. **The smoke test checks the UI.** `GET /` answers 200 with HTML that sends a signed-out visitor to `/signin`. `GET /signin` answers 200 with HTML that contains the sign-in title. A `/_next/static/` script that the sign-in page references is served. A file written through the standalone folder's cache link appears on the mounted `/app/apps/web/.next/cache`.
6. `@hono/node-server` becomes a development dependency of `@git-migrator/web`. The tests still use it to adapt Hono apps to `http` handlers.

## Alternatives

- **Spawn `server.js` as a child process** (what `scripts/start-standalone.mjs` does for local runs). Rejected because the API runtime would live in the child. The parent could neither drain nor close its pools, and tracing in the parent would not see requests. Next.js's own SIGTERM handler exits without the 20 s drain.
- **Import `server.js` in process.** Rejected because Next.js's `startServer` keeps the `http` server to itself, so there is no handle to drain.
- **Run the non-standalone build (`next start` style) from `/app/apps/web`.** This would place the cache at the mounted path with no link. Rejected because DEP-002 names the standalone server, and the non-standalone server loads `next.config.ts` at run time.
- **Change the chart's mount path to the standalone cache.** Rejected because DEP-003 fixes the path.

## Consequences

- The image contains the full `apps/web/.next` output beside the standalone folder. The standalone server uses only the standalone folder and the cache link.
- ADR-0290 point 4 and ADR-0486 ("copies the standalone folder") described this state before it existed. Both now carry a correction note that points here.
- Local runs and the visual and e2e suites still use `scripts/start-standalone.mjs`. The image smoke test (`deploy/docker/smoke.sh`, CI `image` job) is what exercises `web.ts` against a real build.

## Affected requirements

DEP-001, DEP-002, DEP-003, DEP-030, DEP-050, API-001, ARC-020.
