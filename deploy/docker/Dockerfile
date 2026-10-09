# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
#
# Image (DEP-001, ADR-0067, ADR-0290). Stages in order: secretspec-cli (builder), base, dev, build,
# runtime. `base` is shared by all of them. The last stage is the default target, so a plain
# `docker build` produces the runtime image; Compose selects `dev` explicitly.
# Base images are pinned by digest. The tag is kept in a comment for humans; bump both together.

ARG SECRETSPEC_VERSION=0.21.1
ARG PNPM_VERSION=12.10.1

# secretspec CLI from crates.io, pinned by version. `--locked` uses the crate's own Cargo.lock and
# cargo checks every crate against the checksum in the crates.io index.
# rust:1.99.0-slim-bookworm
FROM rust:1.99.0-slim-bookworm@sha256:2c3a22f0a5533ea2dd5a16627bc841228151faa2d4de2644ac9987e4a2f1f2fa AS secretspec-cli
ARG SECRETSPEC_VERSION
RUN cargo install --locked --version "${SECRETSPEC_VERSION}" --root /out secretspec

# node:24-slim
FROM node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS base
ARG SECRETSPEC_VERSION
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git git-lfs tini \
 && rm -rf /var/lib/apt/lists/*
COPY --from=secretspec-cli /out/bin/secretspec /usr/local/bin/secretspec
RUN secretspec --version
# ADP-071: no askPass helper in the image; the unset may find nothing to unset.
RUN git config --system init.defaultBranch main \
 && git config --system lfs.concurrenttransfers 8 \
 && { git config --system --unset-all core.askPass || true; }

FROM base AS dev
ARG PNPM_VERSION
RUN npm install --global "pnpm@${PNPM_VERSION}" \
 && pnpm --version
# Compose runs the container as the host user (`user:` in compose.yaml), which may not be UID 1000.
# HOME, the pnpm store and the fake git data must therefore be writable by any UID.
RUN install -d -m 0777 /home/dev /pnpm-store /var/lib/fake-git \
 && HOME=/home/dev pnpm config set --global store-dir /pnpm-store \
 && chmod -R a+rX /home/dev/.config
# pnpm reads its store location from its own config, not from npm_config_* variables. Without this
# the store lands inside the checkout (node_modules/.pnpm-store), outside the named volume.
ENV HOME=/home/dev \
    GM_INSTALL_ORIGIN=container \
    HOST=0.0.0.0 \
    PORT=3000
WORKDIR /workspace
# tini -g forwards signals to the whole process group, so SIGTERM reaches turbo and both apps.
ENTRYPOINT ["tini", "-g", "--"]
# No install here: the `install` service installs once, before dev and fakes start (compose.yaml).
CMD ["pnpm", "dev"]
USER node

# Build: install everything, generate, build, then prune to production dependencies. The workspace
# packages are TypeScript sources that Node runs with type stripping (ADR-0123), so the runtime
# image keeps the workspace layout and the pnpm links; `pnpm deploy` would copy packages into
# node_modules, where Node refuses to strip types.
FROM base AS build
ARG PNPM_VERSION
ENV CI=true \
    GM_INSTALL_ORIGIN=container
RUN npm install --global "pnpm@${PNPM_VERSION}" \
 && pnpm --version
WORKDIR /app
COPY . .
RUN --mount=type=cache,target=/pnpm-store \
    pnpm config set --global store-dir /pnpm-store \
 && pnpm install --frozen-lockfile
RUN pnpm generate \
 && pnpm turbo run build
# The ZenStack CLI (a production dependency of the db package) runs `migrate`, and the Prisma
# engines it needs are fetched by the install scripts, so scripts stay on for this install.
RUN --mount=type=cache,target=/pnpm-store \
    pnpm config set --global store-dir /pnpm-store \
 && pnpm install --frozen-lockfile --prod
# /app/dist/<command>.js is what entrypoint.sh starts (DEP-002).
RUN mkdir -p /app/dist \
 && printf "import { main } from '../apps/web/src/web.ts';\nawait main();\n" > /app/dist/web.js \
 && printf "import { main } from '../apps/worker/src/worker.ts';\nawait main();\n" > /app/dist/worker.js \
 && printf "import '../apps/worker/src/migrate.ts';\n" > /app/dist/migrate.js

# Runtime: base + the built tree under /app. Non-root, no writable paths of its own (DEP-003): the
# chart mounts emptyDir volumes at /tmp, /home/gm, /scratch and the Next.js cache.
FROM base AS runtime
# Prisma's schema engine (used by `migrate`) looks for the openssl binary to pick its library.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 gm \
 && useradd --uid 10001 --gid 10001 --home-dir /home/gm --create-home --shell /usr/sbin/nologin gm \
 && install -d -o 10001 -g 10001 -m 0755 /scratch /etc/git-migrator
WORKDIR /app
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
# `secretspec run` finds the manifest in the working directory (/app). Without it the production
# entrypoint cannot start (DEP-002, DEP-020, ADR-0293).
COPY --from=build /app/secretspec.toml ./secretspec.toml
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps ./apps
COPY --from=build /app/packages ./packages
COPY --from=build /app/dist ./dist
COPY --chmod=0755 deploy/docker/entrypoint.sh /app/bin/entrypoint.sh
ENV NODE_ENV=production \
    HOME=/home/gm \
    GM_SCRATCH_DIR=/scratch \
    TMPDIR=/tmp \
    GM_CONFIG_FILE=/etc/git-migrator/config.yaml \
    PORT=3000
EXPOSE 3000 8081 9464
USER 10001:10001
# tini -g sends signals to the whole process group, so SIGTERM reaches the node process that
# `secretspec run` starts, whether or not secretspec forwards signals itself.
ENTRYPOINT ["tini", "-g", "--", "/app/bin/entrypoint.sh"]
CMD ["web"]
