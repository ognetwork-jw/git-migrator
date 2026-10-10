#!/usr/bin/env bash
# Smoke test of the runtime image (DEP-001, DEP-002, DEP-003, DEP-010, DEP-020, DEP-050).
# Usage: smoke.sh <image>
#
# Runs the image the way the chart does: UID 10001, read-only root filesystem, tmpfs mounts where the
# chart has emptyDir volumes, no capabilities. Secrets reach the processes through `secretspec run`
# with the production profile and a dotenv provider holding fake values, which is the production
# entrypoint path with Key Vault swapped for a file (ADR-0293). Starts a throw-away Postgres on a
# private network, then checks `migrate`, `web` (the Next.js UI: `/` and the sign-in page with its
# static assets; the API: /api/healthz, /api/readyz; :9464/metrics) and `worker` (/readyz,
# :9464/metrics), and that SIGTERM stops both long-running processes with status 0.
# Needs Docker; pulls $GM_SMOKE_POSTGRES_IMAGE (default postgres:16; CI sets a registry mirror, ADR-0490). Fake values only.
set -euo pipefail

image="${1:?usage: smoke.sh <image>}"
pg_image="${GM_SMOKE_POSTGRES_IMAGE:-postgres:16}"
suffix="$$"
network="gm-smoke-${suffix}"
pg="gm-smoke-pg-${suffix}"
work="$(mktemp -d)"
containers=("$pg")

cleanup() {
  for c in "${containers[@]}"; do docker rm -f "$c" >/dev/null 2>&1 || true; done
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -r "$work"
}
trap cleanup EXIT

# The configuration the chart would mount at /etc/git-migrator/config.yaml.
cat > "$work/config.yaml" <<YAML
environment: test
publicUrl: http://localhost:3000
postgres: { host: ${pg}, port: 5432, database: git_migrator, user: git_migrator, sslmode: disable }
auth:
  entra: { tenantId: "11111111-2222-3333-4444-555555555555" }
  roleMappings:
    - { method: entra, claim: roles, value: "GitMigrator.Admin", role: admin }
YAML
# The secrets of the production profile, as fake values in a dotenv file.
mkdir "$work/secrets"
cat > "$work/secrets/prod.env" <<ENV
POSTGRES_PASSWORD=smoke-password
BETTER_AUTH_SECRET=smoke-better-auth-secret-0000000000000000
ENTRA_CLIENT_ID=smoke-unused
ENTRA_CLIENT_SECRET=smoke-unused
BITBUCKET_CREDENTIALS=[]
GITHUB_APP_PRIVATE_KEY=smoke-unused
ENV
chmod 755 "$work" "$work/secrets"
chmod 644 "$work/config.yaml" "$work/secrets/prod.env"

hardening=(
  --read-only
  --user 10001:10001
  --cap-drop ALL
  --security-opt no-new-privileges
  --network "$network"
  --tmpfs /tmp:rw,size=256m,uid=10001,gid=10001,mode=0700
  --tmpfs /home/gm:rw,size=16m,uid=10001,gid=10001,mode=0700
  -v "$work/config.yaml:/etc/git-migrator/config.yaml:ro"
  -v "$work/secrets:/run/gm-secrets:ro"
  -e GM_SECRETSPEC_PROVIDER=dotenv:/run/gm-secrets/prod.env
  -e GM_SECRETSPEC_PROFILE=production
)

docker network create "$network" >/dev/null
docker run -d --name "$pg" --network "$network" \
  -e POSTGRES_DB=git_migrator -e POSTGRES_USER=git_migrator -e POSTGRES_PASSWORD=smoke-password \
  "$pg_image" >/dev/null
# The image starts a temporary server on the unix socket while it initialises, so the probe must go
# over TCP: that only answers once the final server is up.
pg_ready=0
for _ in $(seq 1 90); do
  if docker exec "$pg" pg_isready -h 127.0.0.1 -p 5432 -U git_migrator -d git_migrator >/dev/null 2>&1; then
    pg_ready=1
    break
  fi
  sleep 1
done
if [ "$pg_ready" != 1 ]; then
  echo "postgres did not become ready" >&2
  docker logs "$pg" >&2 || true
  exit 1
fi

echo "== secretspec refuses to start without the secrets"
# A provider that holds nothing: secretspec must stop the process before node runs.
if docker run --rm "${hardening[@]}" -e GM_SECRETSPEC_PROVIDER=dotenv:/run/gm-secrets/missing.env \
  "$image" migrate >"$work/missing.log" 2>&1; then
  echo "migrate started without its secrets" >&2
  cat "$work/missing.log" >&2
  exit 1
fi

echo "== migrate"
migrated=0
for attempt in 1 2 3 4 5; do
  if docker run --rm "${hardening[@]}" "$image" migrate; then
    migrated=1
    break
  fi
  echo "migrate attempt ${attempt} failed" >&2
  sleep 3
done
if [ "$migrated" != 1 ]; then
  echo "migrate failed; postgres log follows" >&2
  docker logs "$pg" >&2 || true
  exit 1
fi

wait_for() { # <container> <url> <seconds>
  local container="$1" url="$2" seconds="$3"
  for _ in $(seq 1 "$seconds"); do
    if docker exec "$container" curl -fsS "$url" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "timeout waiting for $url" >&2
  docker logs "$container" >&2 || true
  return 1
}

echo "== web"
web="gm-smoke-web-${suffix}"
containers+=("$web")
docker run -d --name "$web" "${hardening[@]}" \
  --tmpfs /app/apps/web/.next/cache:rw,size=64m,uid=10001,gid=10001,mode=0700 \
  "$image" web >/dev/null
[ "$(docker exec "$web" id -u)" = "10001" ]
wait_for "$web" http://127.0.0.1:3000/api/healthz 60
wait_for "$web" http://127.0.0.1:3000/api/readyz 60
wait_for "$web" http://127.0.0.1:9464/metrics 30

# The UI is the Next.js standalone server (DEP-002). A signed-out visitor to `/` is sent to the
# sign-in page, which renders as HTML and loads its static assets.
page() { # <path> <file>: saves the body to <file>, prints "<status> <content type>"
  docker exec "$web" curl -sS -o /dev/stdout -w '\n%{http_code} %{content_type}' \
    "http://127.0.0.1:3000$1" >"$2"
  tail -n 1 "$2"
}
expect_html() { # <path> <status line>
  case "$2" in
    "200 text/html"*) ;;
    *)
      echo "$1 answered '$2', not 200 HTML" >&2
      docker logs "$web" >&2 || true
      exit 1
      ;;
  esac
}
expect_html / "$(page / "$work/root.html")"
if ! grep -q '/signin' "$work/root.html"; then
  echo "/ does not send a signed-out visitor to /signin" >&2
  exit 1
fi
expect_html /signin "$(page /signin "$work/signin.html")"
if ! grep -q 'Sign in to git-migrator' "$work/signin.html"; then
  echo "/signin is not the sign-in page" >&2
  exit 1
fi
# The standalone server's cache directory is the link to the mounted cache volume (DEP-003): a
# write through the link lands on the volume.
if ! docker exec "$web" sh -c 'touch /app/apps/web/.next/standalone/apps/web/.next/cache/.w && test -f /app/apps/web/.next/cache/.w'; then
  echo "the standalone cache does not reach the mounted /app/apps/web/.next/cache" >&2
  exit 1
fi
asset="$(grep -o '/_next/static/[^"]*\.js' "$work/signin.html" | head -n 1 || true)"
if [ -z "$asset" ] || ! docker exec "$web" curl -fsS -o /dev/null "http://127.0.0.1:3000${asset}"; then
  echo "static asset '${asset}' of /signin is not served" >&2
  exit 1
fi
# The root filesystem really is read-only: /scratch is owned by 10001 and is not mounted here, so
# only a read-only root can make this write fail.
[ "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$web")" = "true" ]
if docker exec "$web" sh -c 'touch /scratch/should-fail' 2>/dev/null; then
  echo "root filesystem is writable" >&2
  exit 1
fi
docker stop -t 30 "$web" >/dev/null
[ "$(docker inspect -f '{{.State.ExitCode}}' "$web")" = "0" ]

echo "== worker"
worker="gm-smoke-worker-${suffix}"
containers+=("$worker")
docker run -d --name "$worker" "${hardening[@]}" \
  --tmpfs /scratch:rw,size=256m,uid=10001,gid=10001,mode=0700 \
  "$image" worker --role standard >/dev/null
wait_for "$worker" http://127.0.0.1:8081/readyz 90
wait_for "$worker" http://127.0.0.1:9464/metrics 30
docker stop -t 60 "$worker" >/dev/null
[ "$(docker inspect -f '{{.State.ExitCode}}' "$worker")" = "0" ]

echo "smoke test passed"
