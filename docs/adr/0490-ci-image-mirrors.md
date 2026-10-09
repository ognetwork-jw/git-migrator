# ADR-0490: CI pulls container images from public mirrors

- Status: agent-decided
- Date: 2026-10-09
- Task: CI fix (no work-breakdown task)
- Affects: DEP-001, DEP-060, TST-001

## Context

GitHub-hosted runners share egress addresses, and Docker Hub refuses their anonymous pulls (`toomanyrequests: unauthenticated pull rate limit`, plus `auth.docker.io` timeouts). Jobs failed before any step ran: at "Initialize containers" (the `postgres:16` service of `checks` and `integration`), at Buildx setup (`moby/buildkit:buildx-stable-1`), and in the image build (the Dockerfile's digest-pinned `node:24-slim` and `rust:1.99.0-slim-bookworm`). `deploy/docker/smoke.sh` also pulls `postgres:16`.

## Decision

CI pulls every Docker Hub image through `mirror.gcr.io` (Google's public pull-through cache of Docker Hub). No secrets are involved.

- Service containers use `mirror.gcr.io/library/postgres:16`.
- `docker/setup-buildx-action` gets `driver-opts: image=mirror.gcr.io/moby/buildkit:buildx-stable-1` and a `buildkitd-config-inline` with `[registry."docker.io"] mirrors = ["mirror.gcr.io"]`. The Dockerfile keeps its Docker Hub names and digests; BuildKit resolves them through the mirror, so local and release builds are unchanged. This applies to `ci.yml` and `release.yml`.
- BuildKit and Postgres are pinned by digest next to the mirror name (`mirror.gcr.io/moby/buildkit:buildx-stable-1@sha256:cec9f139...ff2e3dea`, `mirror.gcr.io/library/postgres:16@sha256:ca0bd484...ecb641d`, the same Postgres digest as `compose.yaml`, ADR-0067).
- The Dockerfile's first line pins the `docker/dockerfile:1` frontend by digest (`sha256:4edf897a...fe99e`). BuildKit pulls the frontend as `docker.io/docker/dockerfile`, so it goes through the same mirror. This is the only Dockerfile edit; the digest is identical on Docker Hub and the mirror.
- `smoke.sh` reads its Postgres image from `GM_SMOKE_POSTGRES_IMAGE` (default `postgres:16`); both workflows set it to the mirror.
- `devenv.yml` pulls no images.
- Not covered: `docker/setup-qemu-action` in `release.yml` pulls `tonistiivi/binfmt` through the host Docker daemon, which the BuildKit mirror setting does not affect. No anonymous mirror serves it: `mirror.gcr.io/tonistiivi/binfmt` returns 404, `ghcr.io/tonistiivi/binfmt` returns 403, and `public.ecr.aws` only mirrors Docker's official images. That one pull stays on Docker Hub. The risk is a rate-limited arm64 release build, which only runs on version tags and can be re-run; PR CI does not use QEMU.

Verified from a dev box with the registry v2 API (`curl`, anonymous):

- `mirror.gcr.io/v2/library/node/manifests/sha256:d6aa754f...7f87b20` returns 200 with the identical `Docker-Content-Digest` (the pin).
- `mirror.gcr.io/v2/library/rust/manifests/sha256:2c3a22f0...2f1f2fa` returns 200 with the identical digest.
- `mirror.gcr.io/v2/moby/buildkit/manifests/buildx-stable-1` returns digest `sha256:cec9f139...ff2e3dea`, the same as Docker Hub's.
- `mirror.gcr.io/v2/library/postgres/manifests/sha256:ca0bd484...ecb641d` returns 200 with the identical digest (the one compose.yaml pins).
- `docker/dockerfile:1` has digest `sha256:4edf897a...fe99e` on both Docker Hub and `mirror.gcr.io`.
- `public.ecr.aws` (the alternative) answered 200 for `postgres:16` but 429 for the other manifests from the shared proxy address, so it was not chosen.

## Alternatives

- Log in to Docker Hub with a repository secret: raises the limit, but needs a secret and a Docker account; the user did not choose it.
- Wait and re-run: the limit is per shared runner address, so retries are not reliable.
- `public.ecr.aws/docker/library/*`: an equivalent mirror of the official images, but it could not be verified reliably here, and BuildKit's `docker.io` mirror setting is simplest with `mirror.gcr.io`.
- Edit the Dockerfile to name mirror images: breaks parity with local and release builds and the digest-pin convention.

## Consequences

Images BuildKit resolves (base images, the frontend) fall back to Docker Hub if the mirror lacks them. Service containers and the BuildKit image itself have no fallback, so a missing image fails the job; the host would then be switched in one place per workflow.

Bumping a pinned digest: resolve the new digest with `curl -sI -H 'Accept: application/vnd.oci.image.index.v1+json' https://mirror.gcr.io/v2/<repo>/manifests/<tag>` (read `Docker-Content-Digest`), confirm it matches Docker Hub, then update every occurrence: Postgres in `ci.yml` (two services and `GM_SMOKE_POSTGRES_IMAGE`), `release.yml` and `compose.yaml`; BuildKit in `ci.yml` and `release.yml`; the Dockerfile syntax line and base-image digests.
