# ADR-0292: Release workflow and the CI image and chart jobs

- Status: agent-decided
- Date: 2026-10-08
- Task: T-090
- Affects: DEP-060, DEP-033, DEP-001, DEP-003

## Context

DEP-060 lists the jobs of `ci.yml` and the shape of `release.yml` but leaves the tag format, image tag, tool installation and the smoke test open. `integration` and `e2e` jobs belong to later tasks (T-075, T-083).

## Decision

1. **`release.yml`** runs only on pushed tags `v*`, and its first job rejects tags that are not `v<major>.<minor>.<patch>[-prerelease]`. The image is pushed as `ghcr.io/<owner>/git-migrator:<tag>` (no `latest`), multi-arch with provenance and an SBOM. The chart is then packaged with `--version <tag without v>` and `--app-version <tag>`, which is also the default image tag, and pushed to `oci://ghcr.io/<owner>/charts`. The owner is lower-cased. Only `GITHUB_TOKEN` is used, `packages: write` is granted to the two publishing jobs only, and the chart job waits for the image job.
2. **`ci.yml`** gains `helm` (runs `pnpm helm:check` with kubeconform and helm-unittest installed from release binaries whose SHA-256 is checked before unpacking) and `image` (builds the `runtime` target without pushing and runs `deploy/docker/smoke.sh`). The kubeconform checksum is the published one. helm-unittest publishes no checksum file, so the digest of the v1.0.3 tarball was computed when this was written and pinned; the binary inside the tarball is named `untt`. Helm itself is the version preinstalled on `ubuntu-latest`.
3. **Smoke test** (`deploy/docker/smoke.sh`) starts its own Postgres container on a private network instead of using the CI service container, so it runs unchanged on a developer machine with Docker.
4. All actions are pinned to commit SHAs.
5. **Release gate** (review round 1): the verify job fetches full history and requires the tagged commit to be an ancestor of `origin/main`; the publishing jobs run in the GitHub environment `release` (required reviewers are configured in the repository settings, not in code); the amd64 image is built, loaded and smoke-tested before login and push; the push is refused when `ghcr.io/<owner>/git-migrator:<tag>` already exists, and the chart push when `git-migrator` at that version already exists in `oci://ghcr.io/<owner>/charts`. arm64 is not smoke-tested. The existence checks treat any inspect error as "absent"; a registry outage then fails at the push instead.

## Alternatives

- Tagging `latest` and `<major>.<minor>`: moving tags make rollbacks harder to reason about; add later if wanted.
- `azure/setup-helm` or the helm-unittest plugin install: another third-party action, and Helm 4 plugin verification rules.

## Affected requirements

DEP-001, DEP-003, DEP-033, DEP-060.
