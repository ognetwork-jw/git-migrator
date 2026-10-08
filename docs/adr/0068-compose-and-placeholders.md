# ADR-0068: Compose services, install origin and placeholder processes

- Status: agent-decided
- Date: 2026-10-08

## Context

DEV-020 wants `postgres`, `dev` and `fakes` (profile `test`) in `compose.yaml`, and `pnpm dev` to run web and worker with placeholder apps (acceptance for T-002). T-021, T-028 and T-080 replace the placeholders. The spec does not say how the placeholders behave, how the container shares the checkout with the host, or how the fakes' clone links resolve from other containers.

Earlier rounds found: one bind mount shared `node_modules` between host and container (round 1 replaced it with 23 nested named volumes, which left root-owned mount points in the host checkout, round 2); `fakes` waited for `dev`; clone links only worked on the host; and `setpriv --init-groups` fails for a host UID with no passwd entry.

## Decision

1. `pnpm dev` is `turbo run dev`. The `dev` task in `turbo.json` is `persistent` and not cached. `apps/web` runs `node --watch src/dev-server.ts`, a plain HTTP server on `HOST`:`PORT` (defaults `127.0.0.1:3000`, loopback; the dev image sets `HOST=0.0.0.0` so Compose can publish the port) that answers 200 with a placeholder line. `apps/worker` runs `node --watch src/dev-worker.ts --role all`, the same command devenv runs (DEV-001 parity), and logs a JSON heartbeat every 10 s until SIGINT or SIGTERM. Both rely on Node's built-in type stripping, so no runtime dependency is added.
2. The `fakes` service runs the provider fakes' own start script (`pnpm --filter @git-migrator/provider-fakes start`). This branch adds no fake of its own.
3. **One install, in the checkout, as the host user.** There are no nested volumes. The checkout is bind-mounted at `/workspace`, and `install` runs `pnpm install --frozen-lockfile` as the host UID/GID, so `node_modules` in the checkout is owned by that user. `deploy/docker/install-deps.sh` runs `setpriv --reuid=$GM_UID --regid=$GM_GID --clear-groups`. It does not use `--init-groups`, which needs a passwd entry the host UID may not have. `dev` and `fakes` start after `install` completes. `dev` runs `exec pnpm dev` only and never installs, so two installers never run at once. This supersedes DEV-020's wording "`dev` runs `pnpm install` then `pnpm dev`": a second installer in `dev` would race the `install` service into the same checkout, so the install happens once, in `install`, and `dev` only runs `pnpm dev`.
4. **Pnpm store in a named volume.** The store is outside the checkout, in the `pnpm-store` volume at `/pnpm-store`. The image sets it with `pnpm config set --global store-dir /pnpm-store`, because pnpm 12 ignores `npm_config_store_dir`. Without that setting the store lands in `node_modules/.pnpm-store`, inside the checkout.
5. **One checkout per path, enforced.** Host and container installs must not share a checkout. Each install records its origin in `node_modules/.gm-install-origin` (`host` or `container`). `tools/install-origin.ts` runs as the root `preinstall` script. The origin is `container` when `GM_INSTALL_ORIGIN=container` (set in the dev image), otherwise `host`. The marker is written to a temp file and hard-linked into place (`linkSync`, which fails with EEXIST when a marker exists), so a reader never sees an empty marker and two installers cannot both claim it; on EEXIST the recorded origin is read back and compared. An empty or unrecognised marker is corrupt and refuses with `the install-origin marker is corrupt; remove node_modules/.gm-install-origin and reinstall`. The guard runs as a lifecycle script, so `pnpm install --ignore-scripts` skips it: do not use that flag on a checkout shared with Compose or devenv. A populated but unmarked tree is not refused (logged as a follow-up). A mismatch refuses with the fix (it skips other worktrees under `.worktrees`): `find . -path ./.worktrees -prune -o -name node_modules -prune -exec rm -rf {} +`, or use a separate clone.
6. **Host user.** Compose runs the app services as `${UID:-1000}:${GID:-1000}`. bash keeps `UID` read-only, so the documented setup is `export UID; export GID=$(id -g)`.
7. Host ports bind to `127.0.0.1`. The Postgres host port is `${POSTGRES_HOST_PORT:-5432}`. Changing `POSTGRES_PASSWORD` after the first start needs `docker compose down -v`, because the password is set when the database volume is first initialised.
8. **Fake links.** `fakes` sets `FAKES_HOST=0.0.0.0` (published ports), `FAKE_GIT_PUBLIC_URL=http://fakes:4030` (LFS links) and `FAKE_GIT_BASE_URL=http://fakes:4030/source` (Bitbucket clone links). Clone links therefore resolve from any service on the Compose network. Port 4020 (fake GitHub) is published by the `fakes` service but has no listener until T-042 lands, so connections to it are refused until then.
9. `postgres` uses `postgres:16` (digest pinned, ADR-0067), a named volume and a `pg_isready` healthcheck.

## Verification (sandbox, review round 2)

The sandbox cannot build the committed `Dockerfile` (crates.io and Debian are blocked), so the runs below use the substitution in ADR-0067. The checkouts were copies owned by the test UID, because the sandbox repository is root-owned. Each run used `-p` with its own project name.

- **UID 1234, GID 1234 (no passwd entry):** `env UID=1234 GID=1234 docker compose -p t002a -f compose.yaml -f override-test.yaml run --build --rm install` exited 0. The store was `/pnpm-store/v11`. Every file in the checkout was owned by 1234. The origin marker read `container`. Log: `proof-1234-install.log` in the scratchpad.
- **Same stack, started:** `up -d --wait postgres dev fakes` as 1234 gave dev `Healthy`. In the dev container `id` printed `uid=1234 gid=1234 groups=1234`, `HOME=/home/dev`, `pnpm config get store-dir` printed `/pnpm-store`. `pnpm dev` ran the web placeholder on `0.0.0.0:3000` (HTTP 200 from the host) and the worker heartbeat. `fakes` listened on 4010 (Bitbucket answered 401 without credentials) and `http://fakes:4030`. No file in the checkout was owned by another UID.
- **UID 501, GID 20:** the same install exited 0, with `/pnpm-store/v11` and every file owned by 501. Log: `proof-501-install.log`.
- **Guard refusal, both directions:** a host preinstall against a container-owned tree exited 1 with the fix message. A container install against a tree marked `host` refused in `preinstall` with the same message and exited 1. Log: `proof-refuse.log`.
- **Clone proof (round 1, unchanged):** a fixture repository in the `fake-git-data` volume cloned from a dev container on the Compose network with the fake token. An anonymous clone was refused.
- Teardown: `docker compose -p <project> down -v` for each project. No containers or volumes remained.
- **Sandbox limit:** the `dev` service was run as UID 1234 with the test base image. The committed base was not built here (ADR-0067).

## Affected requirements

DEV-020, DEV-040 (`pnpm dev` runs web and worker in watch mode), DEV-001.
