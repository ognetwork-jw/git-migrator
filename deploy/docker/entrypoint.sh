#!/bin/sh
# Image entrypoint (DEP-002): entrypoint.sh <web|worker|migrate> [args]
# With GM_SECRETSPEC_PROVIDER set (the chart sets akv://<vault>?auth=workload_identity), secretspec
# fetches the secrets of the profile and starts the process with them in its environment. Without
# it the process starts with the environment it was given (Compose, the smoke test).
set -eu
if [ "$#" -lt 1 ]; then
  echo "usage: entrypoint.sh <web|worker|migrate> [args]" >&2
  exit 64
fi
cmd="$1"; shift
case "$cmd" in
  web|worker|migrate) ;;
  *) echo "entrypoint.sh: unknown command '$cmd' (expected web, worker or migrate)" >&2; exit 64 ;;
esac
if [ -n "${GM_SECRETSPEC_PROVIDER:-}" ]; then
  exec secretspec run --profile "${GM_SECRETSPEC_PROFILE:-production}" \
       --provider "$GM_SECRETSPEC_PROVIDER" -- node "/app/dist/$cmd.js" "$@"
else
  exec node "/app/dist/$cmd.js" "$@"
fi
