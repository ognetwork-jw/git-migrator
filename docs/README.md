# git-migrator documentation

| Area | Location | Nature |
|---|---|---|
| Specification | [spec/](spec/00-overview.md) | Normative. Orchestrator-owned. |
| Decisions | [adr/](adr/README.md) | Decision log. `agent-decided` entries need human review. |
| Process | [process/kickoff.md](process/kickoff.md), [process/workflow.md](process/workflow.md), [process/review.md](process/review.md), `process/progress.md` | How agents build this |
| Providers | [providers/bitbucket-cloud.md](providers/bitbucket-cloud.md), [providers/github.md](providers/github.md) | API usage, permissions, limits, quirks |
| Live e2e | [e2e-setup.md](e2e-setup.md) | Human setup for the live test |
| Follow-ups | [followups.md](followups.md) | Unresolved review findings, deferred work |
| Deployment | [deployment.md](deployment.md) | Azure and Helm operations |
| API usage | [api-usage.md](api-usage.md) | Automation via RPC and `/api/v1` |
| Handoff | `handoff.md` (written by T-097) | Final state for the human |

## Commands

The root [README](../README.md) lists the commands; the ones added by T-001 are `pnpm lint` (Biome plus the ARC-012 dependency check), `pnpm typecheck` (`tsc -b`), `pnpm test` (Vitest with the TST-005 coverage thresholds), `pnpm check:packages` (the same checks through Turborepo), `pnpm spec:coverage` (requirement IDs without tests; add `-- --strict` to gate) and `pnpm spec:must-test` (regenerate `must-test.txt`). `pnpm --filter @git-migrator/provider-fakes start` starts the provider fakes (fake Bitbucket on 4010; see `testing/provider-fakes/README.md`). Commands owned by later tasks currently print "not yet implemented (T-xxx)". T-002 extends the getting-started section below.

## Getting started

Two paths run the same commands (DEV-001): [devenv](https://devenv.sh) (Nix) and Docker Compose. Pick one. Both start PostgreSQL 16 on `127.0.0.1:5432` (database and role `git_migrator`) and run `pnpm dev` (web on port 3000, and the worker) with the placeholder apps.

### Secrets (secretspec)

Secrets are declared in [`secretspec.toml`](../secretspec.toml) (DEV-030; secretspec 0.21.1, see [ADR-0065](adr/0065-secretspec-manifest.md)). Most development values have a default in the manifest, so the app starts without a secret store. The exceptions: `GITHUB_APP_PRIVATE_KEY` has no default and is read from the committed fixture `testing/fixtures/fake-github-app.pem` (file provider). `ATLASSIAN_ADMIN_API_KEY` is optional and has no development default; leave it unset unless you need Atlassian email enrichment. The `e2e` profile has no defaults at all. Real secrets go through one of two providers:

- **keyring** (the default under devenv): the system keyring, for example `secretspec set POSTGRES_PASSWORD --profile development`.
- **dotenv**: a `.env` file next to `secretspec.toml`. `.gitignore` excludes it. Select it with `secretspec config global init`, or per command with `--provider dotenv`.

Install the CLI once with `nix profile install nixpkgs#secretspec` (0.21.1, the version in ADR-0065), or use the copy in the devenv shell and the Compose image. Agent sessions must pass a reason (`--reason "<why>"`) to `secretspec`; people do not need one.

### devenv path

1. Install [Nix](https://nixos.org/download) with flakes enabled, and [devenv](https://devenv.sh/getting-started/) 2.x.
2. `devenv shell` loads the development profile and provides Node 24, pnpm, git, git-lfs, secretspec, the PostgreSQL 16 client tools, Helm and kubeconform.
3. `devenv up` starts PostgreSQL. A one-shot `postgres-password` process then sets the `git_migrator` password from `POSTGRES_PASSWORD` (through `secretspec run`, never written into Nix). `web` and `worker` start through `secretspec run`.
4. `devenv test` runs `pnpm lint`, `pnpm typecheck` and `pnpm test`, in that order, as CI does.

devenv installs a `pre-commit` hook into the repository's shared hooks directory, which every worktree uses, and writes `.pre-commit-config.yaml` into the checkout. In a shared checkout, pass `--option git-hooks.enable:bool false` to every devenv command so no hook is installed. If one was installed, remove it (`rm "$(git rev-parse --git-common-dir)/hooks/pre-commit" .pre-commit-config.yaml`). Neither is committed. See ADR-0066.

On a machine without a keyring, override the provider for one command. The override replaces the per-secret routing, so `GITHUB_APP_PRIVATE_KEY` then has to come from the environment or a `.env` file; see ADR-0066. The CI job (`devenv test` in `.github/workflows/devenv.yml`) uses the `test` profile with the `env` provider, which reads the committed fake values; see ADR-0135.

### Docker Compose path

One checkout per path. Compose installs into your checkout as your host user. Never share that checkout with the host or devenv install: the install refuses and says so (ADR-0068). Use a separate clone for each path, or remove the other path's `node_modules` (`find . -path ./.worktrees -prune -o -name node_modules -prune -exec rm -rf {} +`).

1. Install Docker with the Compose plugin.
2. Export your identity so the containers run as you: `export UID; export GID=$(id -g)`. bash keeps `UID` read-only and does not export `GID` by default, so both lines matter. Without them the containers run as 1000:1000.
3. `docker compose up -d postgres` starts the database and waits for its healthcheck. Set `POSTGRES_HOST_PORT` if 5432 is already taken on the host.
4. `docker compose up --build dev` runs `install` once (`pnpm install --frozen-lockfile`, as your user), then `pnpm dev` in `dev`. Open <http://localhost:3000/>.
5. For the provider fakes, add the test profile: `docker compose --profile test up -d fakes`. Bitbucket is on 4010, git on 4030, and GitHub on 4020 is published but has no listener until T-042 lands. Clone and LFS links use the name `fakes`, so other containers on the network can follow them.
6. Secrets: run Compose through secretspec: `secretspec run --profile development -- docker compose up --build dev`. Without it, only `POSTGRES_PASSWORD` has a default.
7. Dependencies changed? Run `docker compose run --rm install`, then restart `dev` and `fakes` (`docker compose restart dev fakes`). They do not reinstall on their own.
8. Changing `POSTGRES_PASSWORD` after the first start needs `docker compose down -v`, because the database volume keeps the old password.

### First run (either path)

```sh
pnpm install             # host path. If Compose uses this checkout, use a separate clone (ADR-0068)
pnpm dev                 # web on :3000 and the worker heartbeat; placeholders until T-021 and T-028
pnpm lint && pnpm typecheck && pnpm test
```

`pnpm test` needs no services. `pnpm test:integration` (T-075) needs the PostgreSQL and fakes above.

The test profile (`secretspec` profile `test`) uses the fake values in the committed [`.env.test`](../.env.test) and the throwaway key `testing/fixtures/fake-github-app.pem` (ADR-0069). Nothing in it reaches a real provider (TST-006).
