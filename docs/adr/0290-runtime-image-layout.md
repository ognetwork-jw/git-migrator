# ADR-0290: Runtime image layout and the web entrypoint

- Status: accepted (spec updated)
- Date: 2026-10-08
- Task: T-090
- Affects: DEP-001, DEP-002, DEP-003, DEP-010, API-001

## Context

DEP-001 says the build stage runs `pnpm deploy --prod` for the worker and takes the Next.js standalone output for web, and DEP-002 starts `/app/dist/<command>.js`. In this repository:

- Workspace packages export TypeScript sources (`"exports": "./src/index.ts"`) and `tsc -b` emits declarations only. Node runs them with type stripping, which Node refuses for files under `node_modules`. `pnpm deploy` copies workspace packages into `node_modules`.
- There is no Next.js app yet: `apps/web` has the API route handler and `src/dev-server.ts`, a placeholder. T-080 adds the UI.
- `migrate` runs the ZenStack CLI (`zen migrate deploy`), which is a devDependency of `@git-migrator/db`, and the Prisma schema engine it starts.
- `main()` of the worker and web entrypoints is guarded by `import.meta.main`, which is false when another file imports them.

## Decision

1. **Layout.** The `build` stage installs everything, runs `pnpm generate` and `pnpm turbo run build`, then re-runs `pnpm install --frozen-lockfile --prod` to prune development dependencies. The `runtime` stage copies `package.json`, `pnpm-workspace.yaml`, `node_modules`, `apps`, `packages` and `dist` into `/app`. The pnpm links stay symlinks to `packages/*`, so Node resolves the real path outside `node_modules` and strips types. `pnpm deploy` is not used.
2. **`@zenstackhq/cli` moves to `dependencies`** of `@git-migrator/db`, because `migrate` needs it at run time. The install scripts stay on in the build stage so Prisma fetches its engines. The runtime stage installs `openssl`, which Prisma uses to choose its library.
3. **`/app/dist/<command>.js`** are three generated shims: `web.js` and `worker.js` import `main` from the app source and await it; `migrate.js` imports `migrate.ts`, which runs on import. `web.ts` and `worker.ts` now export `main`.
4. **Web entrypoint before the UI exists.** `apps/web/src/web.ts` serves the Hono app of API-001 with `@hono/node-server` on `0.0.0.0:3000`, plus the Prometheus metrics server (DEP-050) and tracing. SIGTERM stops accepting connections, lets requests finish, cuts streams still open after 20 s (the pod grace period is 30 s) and exits 0. T-080 replaces this file's server with the Next.js standalone server; the shim, probes and chart do not change.
5. **`tini -g`** instead of plain `tini`, so SIGTERM reaches the node process whether or not `secretspec run` forwards signals. The dev stage already does this.
6. **`entrypoint.sh`** rejects a missing or unknown command with status 64, which the spec's script does not do.
7. **The image has no user-writable path of its own.** `/home/gm` and `/scratch` exist and are owned by 10001 so that `docker run --read-only` with tmpfs mounts works; Kubernetes mounts `emptyDir` volumes over them.
8. **secretspec stays built from crates.io** (ADR-0067 item 8 is not resolved here): the release asset checksums could not be read when this was written.

## Alternatives

- `pnpm deploy --prod`: breaks type stripping. Bundling with esbuild first: a new build toolchain for no other benefit.
- Waiting for T-080 for the web entrypoint: the image, chart and smoke test could not be exercised.
- Keeping `@zenstackhq/cli` a devDependency and installing it in the runtime stage: a second install in the final image.

## Affected requirements

DEP-001, DEP-002, DEP-003, DEP-010, API-001.
