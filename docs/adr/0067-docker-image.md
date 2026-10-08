# ADR-0067: Docker image stages and secretspec installation

- Status: accepted (spec updated)
- Date: 2026-10-08

## Context

DEP-001 wants a pinned secretspec "release binary, verified by checksum". This sandbox cannot reach GitHub release assets: `github.com` release pages return 403, and the `install.secretspec.dev` script does not resolve. The npm packages `secretspec-linux-*-gnu` contain only the Node addon, not the CLI, and PyPI carries only the Python SDK. Debian mirrors return 403 from containers in this sandbox, so `apt-get` cannot run here.

## Decision

1. `deploy/docker/Dockerfile` has three stages in this task: `secretspec-cli` (builder), `base` (`node:24-slim` with git, git-lfs, ca-certificates, curl, tini) and `dev` (pnpm pinned to 12.10.1). T-090 appends `build` and `runtime` after `dev`, as DEP-001 orders them.
2. The secretspec CLI is built with `cargo install --locked --version 0.21.1 secretspec` in a `rust:1.99.0-slim-bookworm` stage and copied into `base`. cargo checks every crate against the crates.io index checksum, and `--locked` uses the crate's own `Cargo.lock`. It keeps the version pinned and the build reproducible from the registry. The crate's default features are used; keyring stays host-side, because the container gets its secrets from Compose.
3. Base images are pinned by digest (review round 1): `rust:1.99.0-slim-bookworm` at `sha256:2c3a22f0…` (the same digest as the floating `1-slim-bookworm` tag), `node:24-slim` at `sha256:d6aa754f…`, and `postgres:16` in `compose.yaml` at `sha256:ca0bd484…`. The tag stays in a comment; bumping a base means changing both.
4. The `dev` stage runs as the non-root `node` user by default, with `USER node`. Compose overrides it with the host user (`user: ${UID:-1000}:${GID:-1000}`, ADR-0068). `HOME` (`/home/dev`), the pnpm store (`/pnpm-store`) and the fake git data directory are created with mode 0777 so that any UID can write them. The `safe.directory` workaround is removed.
5. `ENTRYPOINT ["tini", "-g", "--"]` forwards signals to the whole process group. `CMD` is `["pnpm", "dev"]`. It does not install: the Compose `install` service installs once before dev and fakes start (ADR-0068), so no two installers run at once.
5a. The dev image sets `GM_INSTALL_ORIGIN=container` (ADR-0068) and `pnpm config set --global store-dir /pnpm-store`. Pnpm 12 ignores `npm_config_store_dir`. `chmod -R a+rX /home/dev/.config` keeps pnpm's config readable by any UID.
6. `.dockerignore` excludes VCS data, `node_modules`, `**/.env`, `**/.env.*` (except `**/.env.test`), `**/*.pem`, `.pre-commit-config.yaml`, devenv and turbo state, coverage and build output. The dev stage does not COPY the context, so the fixture key does not enter the image.
7. `secretspec --version` runs at build time, so a broken binary fails the build.
8. Follow-up (not done here): install the secretspec binary from the GitHub release with a SHA-256 check, once a release-download path is reachable from CI (T-090). The cargo build stays until then.

## Alternatives

- The GitHub release binary with a SHA-256 check: the right end state, but the asset URL and checksums could not be read in this sandbox, so they cannot be pinned honestly. Revisit when the release workflow (T-090) runs.
- Installing through npm or PyPI: those packages do not contain the CLI (see Context).

## Verification in this sandbox

- The committed `Dockerfile` was not built here: the `rust` stage needs `static.crates.io` (blocked) and the `base` stage needs Debian mirrors (403). CI's Docker build (T-003) is the first real build of these stages.
- Review round 1 did the same substitution again (base from nixpkgs-cached tools, the `rust` and `apt` steps removed, `USER node` kept). The non-root path was not exercised: the sandbox's repository files are owned by root, so the run used `UID=0 GID=0`. Non-root behaviour is covered by the config tests only.
- For local verification only, a copy with the `rust` and `apt` steps replaced by a base image built from nixpkgs-cached `git`, `git-lfs`, `tini`, `curl` and `secretspec` (plus the sandbox proxy CA) was built with `docker compose build dev`, started, and ran `pnpm install` and `pnpm dev` to a healthy state. That copy is not committed.

## Affected requirements

DEP-001 (image, `.dockerignore`, digest pins), DEV-020 (`dev` target), ADP-071 (no askPass helper; the image unsets `core.askPass`).
