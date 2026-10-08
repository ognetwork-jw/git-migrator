# ADR-0065: secretspec 0.21.1 manifest syntax and profile inheritance

- Status: agent-decided
- Date: 2026-10-08

## Context

DEV-030 gives the intended `secretspec.toml` and says: "Profiles do not inherit: T-002 repeats every development default here explicitly" and "The exact secretspec TOML syntax ... MUST be verified against the pinned secretspec version in T-002." The spec's own GitHub App key default is a placeholder, `<contents of testing/fixtures/fake-github-app.pem>`, which secretspec would store literally.

## Verification (secretspec 0.21.1)

- Pinned version: `secretspec` 0.21.1 (crates.io, published 2026-09-27, latest stable on 2026-10-08). Binary used for checks: nixpkgs `secretspec-0.21.1`, from `cache.nixos.org`, run as `secretspec --version`.
- Sources read at tag `v0.21.1`: `docs/src/content/docs/reference/configuration.mdx`, `docs/src/content/docs/providers/file.mdx`, `secretspec/src/config.rs`.
- Findings:
  - **Inheritance is on by default.** A non-default profile inherits `[profiles.default]` declarations unless `[profiles.<name>.defaults] inherit = false` (since 0.19). The DEV-030 comment "profiles do not inherit" is therefore only true for profiles that set `inherit = false`. `development` keeps inheriting (it gets its descriptions from `default`); `test` sets `inherit = false` and repeats every development default with its own description.
  - `default = "..."` with `required = true` on the same secret is rejected; the spec's `development` block has no explicit `required`, and it validates (`check --explain` reports `ok default value`).
  - `[profiles.<name>.defaults] providers = [...]` sets the provider chain for a profile; a per-secret `providers` overrides it.
  - `default` values are returned verbatim. `encoding = "base64"` does not decode a default (checked: the base64 text came back unchanged), so it cannot carry the PEM.
  - Since 0.20/0.21 the CLI requires a reason when the process looks like an agent (`--reason`, `SECRETSPEC_REASON`, or `[project] require_reason`). The default policy is `"agents"`; the manifest does not change it.
- Checks run: `secretspec check --explain -n -P <profile>` for `development`, `test`, `e2e`; `secretspec run -P development` and `-P test` with `printenv GITHUB_APP_PRIVATE_KEY`, which returned the 1679-byte fixture file (only the trailing newline from `printenv` differs).

## Decision

1. `[profiles.test.defaults] inherit = false` and `providers = ["test_env"]`, where `test_env = "dotenv:.env.test"`. Every development default is repeated in `test` with its description. Values come from `.env.test` first, then the defaults.
2. `GITHUB_APP_PRIVATE_KEY` in `development` and `test` is not an inline default. It is resolved by the `file` provider from the committed fixture: `providers = ["fixtures"]` with `fixtures = "file:./testing/fixtures"` and `ref = { item = "fake-github-app.pem" }`. This keeps the key out of the manifest. An inline PEM would also trip gitleaks on `secretspec.toml`, which the allowlist for T-003 covers only by exact path (for the `.pem` file).
3. The `e2e` profile is left without defaults. It inherits `default`, so it requires the same secrets as `development` and has no fake values.
4. `secretspec.toml` keeps `revision = "1.0"`, and no `require_reason` change.

## Test parsers (review round 1)

The manifest, `.env.test`, `devenv.yaml` and `compose.yaml` are checked by parsers, not by string matching:

- `yaml` 2.9.1 (exact; the version ADR-0002 pins for `packages/config`) parses `compose.yaml` and `devenv.yaml`.
- `smol-toml` 1.9.0 (exact; a root devDependency added by T-002, published 2026-09-22) parses `secretspec.toml`. ADR-0002 does not list it yet; this is the record.
- `devenv.nix` is a Nix file and has no JS parser here. Its attributes are checked by name.

The test profile now also declares `ATLASSIAN_ADMIN_API_KEY` (optional), because `inherit = false` means every DEV-030 secret must be declared in `test` itself. The test asserts that every DEV-030 secret is in every profile, counting inheritance where it applies.

## Alternatives

- Inline PEM in `development` (exactly as a literal default): rejected, see point 2.
- `encoding = "base64"` on the default: does not decode, rejected.
- Setting `require_reason = false` so agents do not need `--reason`: rejected, it weakens an access policy that is not ours to change.

## Affected requirements

DEV-030 (manifest, profiles, fixture key, `.env.test`), DEV-010 (devenv secretspec integration), DEV-020 (Compose passes secrets through).
