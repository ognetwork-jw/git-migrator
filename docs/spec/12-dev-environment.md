# 12 — Development Environment

devenv and Docker Compose are both first-class (DEV-001). Every documented developer command MUST work under both. CI exercises the Compose path and the devenv path (a `devenv test` job), so neither rots.

## devenv (DEV-010)

`devenv.nix` / `devenv.yaml` provide:

- `languages.javascript` with Node.js 24 and pnpm (corepack disabled; pnpm comes from nixpkgs at the pinned major).
- Packages: `git`, `git-lfs`, `secretspec`, `postgresql_16` client tools, `kubernetes-helm`, `kubeconform`, `jq`.
- `services.postgres`: PostgreSQL 16, database `git_migrator`, user `git_migrator`, password from secretspec, `pg_trgm` available, listening on `127.0.0.1:5432`.
- `processes`: `web` (`pnpm --filter @git-migrator/web dev`) and `worker` (`pnpm --filter @git-migrator/worker dev -- --role all`).
- secretspec integration through devenv's built-in support (`secretspec:` in `devenv.yaml`, profile `development`, provider `keyring` by default). If the integration is unavailable in the pinned devenv version, wrap the processes with `secretspec run`.
- `enterTest` runs `pnpm turbo run lint typecheck test`.
- A `git-hooks` entry runs Biome on staged files.

## Docker Compose (DEV-020)

`compose.yaml` at the repository root:

| Service | Image | Notes |
|---|---|---|
| `postgres` | `postgres:16` | Same DB, user and port as devenv. Named volume. Healthcheck. |
| `dev` | built from `deploy/docker/Dockerfile` target `dev` (Node 24, pnpm, git, git-lfs, secretspec) | Source bind-mounted. Runs `pnpm install` then `pnpm dev` (web and worker via Turborepo). Port 3000. |
| `fakes` | same `dev` image | `pnpm --filter @git-migrator/provider-fakes start`: fake Bitbucket on 4010, fake GitHub on 4020, git http-backend on 4030. Profile `test` only. |

`compose.yaml` passes secrets with `secretspec run --profile development -- docker compose up`, or through a `.env` file that `secretspec` writes for the dotenv provider. Both are documented in `docs/README.md`.

## secretspec (DEV-030)

`secretspec.toml`:

```toml
[project]
name = "git-migrator"
revision = "1.0"

[profiles.default]
POSTGRES_PASSWORD      = { description = "Password for the git_migrator Postgres role", required = true }
BETTER_AUTH_SECRET     = { description = "Better Auth signing secret (≥32 random bytes, base64)", required = true }
ENTRA_CLIENT_ID        = { description = "Entra app registration client id", required = true }
ENTRA_CLIENT_SECRET    = { description = "Entra app registration client secret", required = true }
BITBUCKET_CREDENTIALS  = { description = "JSON array: [{id, accountId, email, apiToken}] for the Bitbucket endpoint", required = true }
GITHUB_APP_PRIVATE_KEY = { description = "PEM private key of the GitHub App", required = true }
ATLASSIAN_ADMIN_API_KEY = { description = "Atlassian Admin API key for email enrichment (optional)", required = false }
GM_TEST_USER_PASSWORD  = { description = "Password for seeded test actors (test sign-in only)", required = false }

[profiles.development]
POSTGRES_PASSWORD     = { default = "git_migrator" }
BETTER_AUTH_SECRET    = { default = "dev-only-insecure-secret-change-me-0000000000" }
ENTRA_CLIENT_ID       = { default = "dev-unused" }
ENTRA_CLIENT_SECRET   = { default = "dev-unused" }
BITBUCKET_CREDENTIALS = { default = "[{\"id\":\"fake\",\"accountId\":\"fake-user\",\"email\":\"fake@test.local\",\"apiToken\":\"fake\"}]" }
GITHUB_APP_PRIVATE_KEY = { default = "<contents of testing/fixtures/fake-github-app.pem>" }
GM_TEST_USER_PASSWORD = { default = "test-password" }

[profiles.test]
# Profiles do not inherit: T-002 repeats every development default here explicitly.

[profiles.e2e]
# live e2e against real Bitbucket/GitHub test accounts — no defaults; see docs/e2e-setup.md
```

Notes:

- Non-secret IDs (Entra tenant ID, GitHub App ID and installation ID, Bitbucket workspace) live in the config file, not in secretspec.
- In `development` and `test`, the config file points Endpoints at the provider fakes (`http://localhost:4010`, `4020`, git on `4030`).
- `testing/fixtures/fake-github-app.pem` is a committed, throwaway RSA key used only by the fakes. It is allow-listed in the gitleaks config by exact path. T-002 generates it.
- **Profile → provider:** `development` uses keyring or dotenv (developer's choice); `test` uses dotenv with the committed `.env.test`, which contains only fake values; `e2e` uses keyring or dotenv (developer's machine); `production` uses `akv://<vault>?auth=workload_identity` (DEP-020).
- The exact secretspec TOML syntax for per-profile defaults MUST be verified against the pinned secretspec version in T-002. The intent above is normative; the syntax is not.

## Commands (DEV-040)

Root `package.json` scripts, identical under devenv and Compose:

| Script | Action |
|---|---|
| `pnpm dev` | web + worker in watch mode |
| `pnpm db:migrate` / `db:seed` / `db:reset` | DATA-030 / DATA-040 / drop and recreate the dev DB |
| `pnpm generate` | ZenStack generate (client, hooks), OpenAPI emit |
| `pnpm lint` / `format` / `typecheck` | Biome check / Biome format / `tsc -b` |
| `pnpm test` | Unit tests (all packages) |
| `pnpm test:integration` | Integration tier (needs Postgres and fakes, started automatically by a Vitest global setup when not running) |
| `pnpm test:e2e` | Playwright against the app plus fakes (integration-tier UI flow, TST-021) |
| `pnpm test:e2e:live` | Playwright live e2e (`secretspec` profile `e2e`; TST-030) |
| `pnpm e2e:live:reset` | Resets live fixtures (TST-032) |
| `pnpm helm:check` | `helm lint` + `helm template` piped to `kubeconform -strict` |
