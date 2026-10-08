# ADR-0293: secretspec production profile and manifest in the image

- Status: accepted (spec updated)
- Date: 2026-10-08
- Task: T-090
- Affects: DEP-002, DEP-020, DEV-030

## Context

DEP-002 runs `secretspec run --profile production --provider akv://...`. Review found two gaps: `secretspec.toml` was not in the runtime image, and the manifest (ADR-0065) declares the profiles `default`, `development`, `test` and `e2e` but not `production`. secretspec 0.21.1 rejects an undeclared profile (`Invalid profile: 'production' is not defined in secretspec.toml. Available profiles: default, development, e2e, test`), checked with the nixpkgs 0.21.1 binary.

## Decision

1. `secretspec.toml` declares an empty `[profiles.production]`. Profiles inherit `default` unless they set `inherit = false` (ADR-0065), so production requires the same secrets and has no values of its own. With the binary: `secretspec run -P production --provider dotenv:<file> -- printenv POSTGRES_PASSWORD` prints the value.
2. The runtime stage copies `secretspec.toml` to `/app`, the working directory where `secretspec run` looks for it.
3. `deploy/docker/smoke.sh` runs `migrate`, `web` and `worker` through the real entrypoint path: `GM_SECRETSPEC_PROVIDER=dotenv:/run/gm-secrets/prod.env`, profile `production`, fake values in a read-only mount. It also checks that a missing provider file stops `migrate` before node starts. The SIGTERM exit-0 checks therefore cover signal forwarding through `tini -g` and `secretspec run`.

## Alternatives

- `--config`/an environment variable naming the manifest elsewhere: a second location to keep in sync.
- Inline `required = true` declarations in `production`: duplicates `default`.

## Affected requirements

DEP-002, DEP-020, DEV-030.
