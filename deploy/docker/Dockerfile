# syntax=docker/dockerfile:1
#
# Image (DEP-001, ADR-0067). Stages in order: secretspec-cli (builder), base, dev.
# T-090 adds the build and runtime stages after dev; base stays shared by all of them.
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
