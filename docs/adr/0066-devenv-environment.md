# ADR-0066: devenv environment

- Status: accepted (spec updated)
- Date: 2026-10-08

## Context

DEV-010 lists the devenv contents. The spec does not settle how devenv's secretspec integration is configured in the pinned version, how the git hooks input is declared, how web and worker get secrets, or how the Postgres role gets its password without the password entering Nix evaluation (the Nix store is world-readable).

## Verification (devenv 2.4.0, nixpkgs `devenv-2.4.0`)

- `devenv.yaml` takes `secretspec: { enable, provider, profile }` (devenv docs `integrations/secretspec.mdx`, source `src/modules/integrations/secretspec.nix`). devenv exports `SECRETSPEC_PROFILE` and, when set, `SECRETSPEC_PROVIDER`. It does not export secret values to processes.
- `git-hooks` must be declared as a devenv input (`url: github:cachix/git-hooks.nix`, `nixpkgs` following `nixpkgs`). Without it, evaluation fails.
- `services.postgres` `initialDatabases` with `user` creates the role; `pass` would write the password into the Nix store output, so it is not used. devenv's setup script runs the initial databases over the Unix socket in `$DEVENV_RUNTIME/postgres`, as the OS user, which is the superuser that `initdb` created. devenv exports `PGPORT`. initdb's default writes `trust` for TCP (verified in round 2: `host all all 127.0.0.1/32 trust` and `::1/128 trust`). The role therefore needs a password only once TCP auth is scram, which this ADR sets (below).
- The nixpkgs `postgresql_16` package includes `pg_trgm` (checked: `share/postgresql/extension/pg_trgm--*.sql`).

## Decision

1. `devenv.yaml`: `secretspec` with `provider: keyring` and `profile: development` (DEV-010), and the `git-hooks` input.
2. `devenv.nix` provides the DEV-010 packages, Node 24 (`pkgs.nodejs_24`), pnpm (`pkgs.pnpm_12`, which pnpm upgrades to the `packageManager` pin 12.10.1 on first use), and PostgreSQL 16 (`pkgs.postgresql_16`) on `127.0.0.1:5432`, database and role `git_migrator`. corepack stays off.
3. **TCP is scram, socket is trust.** `services.postgres.initdbArgs` is `--locale=C --encoding=UTF8 --auth-host=scram-sha-256 --auth-local=trust`. devenv's generated `setup-postgres` runs exactly that `initdb` line (inspected in the Nix store output, round 2). The socket stays trust, because `set-postgres-password` connects over the socket before the role has a password. The locale and encoding are devenv's defaults, kept.
3a. **The password stays out of Nix.** `initialDatabases` creates the role without `pass`. A one-shot process, `postgres-password` (`restart.on = "never"`), runs `set-postgres-password` under `secretspec run`. It waits for the socket, then sets `ALTER ROLE git_migrator WITH LOGIN PASSWORD ...`. The SQL goes to `psql` on stdin, built with a bash `printf` builtin, so the password is never in argv. Single quotes in the value are doubled. The script is in the Nix store, but it reads the value from the environment at run time.
4. `processes.web` and `processes.worker` run through `secretspec run --`. devenv does not export the values.
5. `enterTest` runs `pnpm turbo run lint typecheck test`.
6. The Biome git hook is report only: `pnpm exec biome check --no-errors-on-unmatched --files-ignore-unknown=true`, no `--write`. A developer who wants formatting runs `pnpm format` before staging.

## Verification in this sandbox (committed files, flags only)

- `devenv shell` ran to completion on the committed `devenv.yaml` and `devenv.nix`, with `SECRETSPEC_REASON` set. Node 24.21.0, pnpm 12.10.1 (pnpm upgraded it from nixpkgs' 12.9.0), secretspec 0.21.1, psql 16.15. `POSTGRES_PASSWORD` is empty in the shell, as intended: devenv does not export it.
- Network workarounds, all as command-line flags (no committed file edited): `--override-input devenv git+https://github.com/cachix/devenv?ref=refs/tags/v2.4.0&shallow=1`, `--override-input nixpkgs flake:nixpkgs`, `--override-input git-hooks git+https://github.com/cachix/git-hooks.nix?shallow=1` (GitHub tarballs are blocked here), and `--secretspec-provider dotenv` (no keyring store in this container). With that override, `GITHUB_APP_PRIVATE_KEY` must come from a `.env` file, which was created for the run and removed afterwards.
- `devenv test` ran `devenv:git-hooks:run` and `enterTest` without error, then stopped at process start. `postgres` failed because initdb refuses to run as root (sandbox limit). `web` and `worker` failed with `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL`, which I did not diagnose within the time box. T-093 must reproduce this on a non-root runner.
- Round 2, scram: a throwaway cluster was initialised with the same arguments, as an unprivileged user. Its `pg_hba.conf` has `trust` for local and `scram-sha-256` for `127.0.0.1/32` and `::1/128`. Over TCP, the correct password logged in and a wrong one was rejected with `password authentication failed for user "git_migrator"`. This was a live test on a cluster initialised with the same arguments, not on devenv's own init run (which needs root to start).
- Round 2, generated script: `devenv shell` with `--option git-hooks.enable:bool false` (no hook was installed; the shared hooks directory stayed clean) produced `setup-postgres` with `initdb --locale=C --encoding=UTF8 --auth-host=scram-sha-256 --auth-local=trust`. Its temporary server listens on the socket only (`listen_addresses=`), which is why the password script waits for TCP readiness.
- Round 2, password script: `set-postgres-password` waits for TCP readiness on 127.0.0.1 and for the role to exist (`SELECT count(*) FROM pg_roles WHERE rolname = 'git_migrator'` over the socket), with a bound of 120 one-second tries, then runs `ALTER ROLE`. Tested against the scram cluster: exit 0, the correct TCP login worked, a wrong one was rejected.
- The password script was run against a throwaway PostgreSQL 16 (the nixpkgs package, started as an unprivileged user with a socket in a short directory, scram rules on TCP) with `PGUSER`, `PGPORT` and `DEVENV_RUNTIME` set as devenv sets them. The script set the password, the role logged in over TCP with it, a wrong password was rejected, and the value containing a single quote worked.
- `devenv up` was not run to completion here (root and the process failure above). T-093 must cover `devenv up` and `devenv test` on a non-root runner.

## Shared-repository caveat (important)

Round 2 note: pass `--option git-hooks.enable:bool false` on every devenv run in a shared checkout. It keeps the hook from being installed. The `.pre-commit-config.yaml` symlink is still written only when hooks are enabled. Without that option, a run installs the hook into the shared hooks directory for every worktree.

devenv's git-hooks integration installs a prek `pre-commit` hook into the repository's hooks directory. Worktrees share that directory (`git rev-parse --git-common-dir`/`hooks`), so the hook then runs for commits in every worktree and in the main checkout. Run `devenv shell` or `devenv test` in a shared checkout only with the hook in mind, and remove `$(git rev-parse --git-common-dir)/hooks/pre-commit` afterwards. Every devenv run also writes `.pre-commit-config.yaml` (a Nix store symlink) into the worktree; it is gitignored and must not be committed. devenv also writes `devenv.lock`. The lock generated in this sandbox points at override inputs, so it is not committed. A maintainer with GitHub access generates the real lock and commits it, in the T-093 change.

## Known limits

- **Headless hosts.** The keyring provider fails without a default store. `--secretspec-provider dotenv` avoids that but replaces per-secret routing, so `GITHUB_APP_PRIVATE_KEY` (routed to the `fixtures` provider in the manifest) becomes missing. A headless CI job (T-093) needs its own decision.
- **Agent reason.** secretspec 0.21.1 requires `SECRETSPEC_REASON` for agent processes during devenv evaluation.

## Affected requirements

DEV-010, DEV-001 (devenv path), DEP-060 (`devenv.yml`, owned by T-093).
