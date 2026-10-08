# ADR-0135: Headless secretspec route for the devenv CI job

- Status: accepted (spec updated)
- Date: 2026-10-08

## Context

DEV-010 makes `devenv.yaml` select the `keyring` provider for profile `development`. A GitHub runner has no keyring store, so `secretspec run` fails there. ADR-0066 recorded the consequence and left the CI route to T-093. The T-093 brief asked for a decision: use the `test` profile's dotenv provider or the profile defaults.

Checked with the nixpkgs secretspec 0.21.1 CLI (the version ADR-0065 pins), using `secretspec check --explain`:

- `SECRETSPEC_PROFILE=test` with no provider override resolves every secret, the fixture key included, through the `test` profile's own routes. Only the global provider is consulted when it is set.
- Setting any global provider overrides per-secret routing. `SECRETSPEC_PROVIDER=keyring` fails on the keyring. `dotenv` and the manifest alias `test_env` both leave `GITHUB_APP_PRIVATE_KEY` missing, because the fixture route is dropped.
- A dotenv file that carries the PEM was not parsed for `GITHUB_APP_PRIVATE_KEY` (single-line `\n` escapes and a multi-line form were both tried), so a dotenv override cannot carry the key.
- `SECRETSPEC_PROVIDER=env` (the environment provider) resolves the non-key secrets from the process environment, but not the key: its `ref` renames the lookup to `fake-github-app.pem`.
- `--provider file:./testing/fixtures` (or the alias `fixtures`) with the `test` profile resolves every secret with no environment input.

devenv 2.4.0 (the version ADR-0066 verified with; checked from the nixpkgs build) exposes `--secretspec-provider` and `--secretspec-profile` as options of `devenv test`, backed by `SECRETSPEC_PROVIDER` and `SECRETSPEC_PROFILE`. devenv exports the `devenv.yaml` provider (`keyring`) into the environment.

## Decision

1. The `devenv test` step in `.github/workflows/devenv.yml` runs `devenv test --no-tui --secretspec-provider file:./testing/fixtures --secretspec-profile test`. The flags override the `keyring` default for that command only. `devenv.yaml` keeps `keyring` for developers.
2. Why the `file` provider: a global provider overrides every per-secret route, but a secret's `ref` still renames its lookup. `GITHUB_APP_PRIVATE_KEY` has `ref = { item = "fake-github-app.pem" }`, so the `env` provider looked for a variable named `fake-github-app.pem` and the first CI run (job 113327733742) failed with "Missing required secrets: GITHUB_APP_PRIVATE_KEY". With `file:./testing/fixtures` as the global provider, the key resolves from the committed throwaway fixture through its `ref`, and every other secret takes the `test` profile's committed fake default. Checked with secretspec 0.21.1 in a clean environment: 7 found, 0 missing.
3. Nothing is exported to the job environment (no `GITHUB_ENV` writes). The earlier design exported the fixture key there, which printed it into every later step's environment dump. It was a committed fake, but logs should not carry key material at all.
4. A step runs `secretspec check --provider file:./testing/fixtures --profile test --no-prompt` inside `devenv shell` before `devenv test`. A missing secret fails there and does not look like a process failure.
5. On failure, the job prints the tail of any `*.log` under `.devenv`. Only fake values exist in the job.

## Spec departure

DEV-030 says the `test` profile "uses dotenv with the committed `.env.test`". CI does not use that route: a global provider override drops per-secret routing, and the dotenv route cannot carry `GITHUB_APP_PRIVATE_KEY` (see Context). CI uses the `file` provider plus the profile's defaults, which equal the `.env.test` values. This is a CI-only override. Developers still get the `test` profile through `.env.test` and the fixture provider.

## Hypothesis: the earlier ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL

Not reproduced. The web and worker processes run `secretspec run -- pnpm --filter ... dev`. Under `devenv test`, with the keyring provider and no keyring store, `secretspec run` fails before pnpm starts. The `pnpm --filter` wrapper then reports the first failing package as ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL. The `file` route removes the keyring dependency. The follow-up row stays open until CI confirms it.

## Alternatives

- `--secretspec-provider env` with the values exported to `GITHUB_ENV`: rejected after the first CI run. The `ref` rename leaves the key missing, and the export printed the fixture key into step logs.
- `--secretspec-provider dotenv` or `test_env`: rejected. Verified to drop `GITHUB_APP_PRIVATE_KEY`.
- A dotenv file with the PEM: rejected. Not parsed by secretspec 0.21.1.
- Removing `provider: keyring` from `devenv.yaml`: rejected. It changes the developer default that DEV-010 fixes.
- Running the CI job with the `development` profile: rejected. Its `GITHUB_APP_PRIVATE_KEY` route is the fixture provider, which the override drops too.

## Unverified

The CI path was not run on a GitHub runner. The sandbox cannot reach GitHub-hosted runners, devenv inputs or the devenv binary cache. The flag names were checked against the devenv 2.4.0 CLI help. Two assumptions remain for the first CI run, and the readiness gate and the secretspec check step are there to surface them:

- (a) devenv's exported `SECRETSPEC_PROVIDER=keyring` yields to the command-line flag inside processes.
- (b) `devenv test` starts the processes (postgres-password, web, worker) before `enterTest`. The `enterTest` gate in `devenv.nix` checks PostgreSQL and the web placeholder, and fails loudly if either is missing.

## Affected requirements

DEV-010 (devenv secretspec integration), DEV-030 (test profile; departure noted above), DEP-060 (`devenv.yml`), DEV-001 (devenv path exercised in CI).
