# devenv (DEV-010, ADR-0066). The same database, user and port as compose.yaml (DEV-020).
{ pkgs, ... }:

let
  # Sets the git_migrator role password at startup, from POSTGRES_PASSWORD under `secretspec run`.
  # The password never enters Nix evaluation (ADR-0066). It goes to psql on stdin, not argv, and
  # the socket connection uses the OS user, which is the PostgreSQL superuser from initdb.
  setPostgresPassword = pkgs.writeShellScript "set-postgres-password" ''
    set -euo pipefail
    socket="$DEVENV_RUNTIME/postgres"
    port="''${PGPORT:-5432}"
    pw="''${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is not set; start through secretspec run}"
    # devenv runs a temporary server on the socket only while it creates the role, so wait for the
    # final server on TCP and for the role to exist. Bounded: about two minutes.
    ready=0
    for _ in $(seq 1 120); do
      if pg_isready -q -h 127.0.0.1 -p "$port" -d postgres \
        && [ "$(psql -X -q -tA -h "$socket" -p "$port" -d postgres \
             -c "SELECT count(*) FROM pg_roles WHERE rolname = 'git_migrator'" 2>/dev/null)" = 1 ]; then
        ready=1
        break
      fi
      sleep 1
    done
    if [ "$ready" != 1 ]; then
      echo "set-postgres-password: server or role git_migrator not ready after 120 s" >&2
      exit 1
    fi
    # The password never enters Nix evaluation (ADR-0066). SQL goes to psql on stdin (not argv), built
    # by a bash builtin; single quotes are doubled. Socket connections are trust (initdb local rule).
    pw_sql="''${pw//\'/\'\'}"
    printf "ALTER ROLE git_migrator WITH LOGIN PASSWORD '%s';\n" "$pw_sql" \
      | psql -q -X -v ON_ERROR_STOP=1 -h "$socket" -p "$port" -d postgres
  '';
in
{
  packages = with pkgs; [
    git
    git-lfs
    secretspec
    postgresql_16
    kubernetes-helm
    kubeconform
    jq
  ];

  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_24;
    # corepack stays disabled; pnpm comes from nixpkgs at the pinned major (ADR-0002 pins 12.10.1).
    pnpm = {
      enable = true;
      package = pkgs.pnpm_12;
      install.enable = true;
    };
  };

  services.postgres = {
    enable = true;
    package = pkgs.postgresql_16;
    listen_addresses = "127.0.0.1";
    port = 5432;
    # initdb's default writes `trust` for TCP. Scram for TCP (127.0.0.1 and ::1); the Unix socket stays
    # trust, which set-postgres-password relies on before the role has a password (ADR-0066).
    initdbArgs = [
      "--locale=C"
      "--encoding=UTF8"
      "--auth-host=scram-sha-256"
      "--auth-local=trust"
    ];
    # The role has no password here. set-postgres-password sets it from the environment.
    initialDatabases = [
      {
        name = "git_migrator";
        user = "git_migrator";
      }
    ];
  };

  processes = {
    postgres-password = {
      exec = "secretspec run -- ${setPostgresPassword}";
      restart.on = "never";
    };
    # Each app process runs through `secretspec run`: devenv exports only the profile and provider, not the values.
    web.exec = "secretspec run -- pnpm --filter @git-migrator/web dev";
    worker.exec = "secretspec run -- pnpm --filter @git-migrator/worker dev -- --role all";
  };

  enterTest = ''
    pnpm turbo run lint typecheck test
  '';

  # Report only: the hook never rewrites staged files (ADR-0066).
  git-hooks.hooks.biome = {
    enable = true;
    name = "biome";
    entry = "pnpm exec biome check --no-errors-on-unmatched --files-ignore-unknown=true";
    files = "\\.(ts|tsx|mts|js|jsx|mjs|json|jsonc|css)$";
    pass_filenames = true;
    language = "system";
  };
}
