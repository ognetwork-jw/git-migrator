#!/usr/bin/env bash
# Release overwrite guard (DEP-060, ADR-0292). Usage: require-absent.sh <what> -- <command> [args...]
#
# Runs a registry lookup (`docker buildx imagetools inspect`, `helm show chart`) and fails closed:
#   - the lookup succeeds:                      <what> exists, exit 1 (never overwrite a release);
#   - it fails with a registry "not found":     <what> is absent, exit 0;
#   - it fails any other way (401, 5xx, DNS):   unknown, exit 1 with the lookup's output.
# Only a not-found answer lets the release continue, so an outage cannot skip the guard.
set -euo pipefail

what="${1:?usage: require-absent.sh <what> -- <command> [args...]}"
shift
if [ "${1:-}" != "--" ] || [ "$#" -lt 2 ]; then
  echo "usage: require-absent.sh <what> -- <command> [args...]" >&2
  exit 2
fi
shift

status=0
output="$("$@" 2>&1)" || status=$?
if [ "$status" -eq 0 ]; then
  echo "${what} already exists; a published release is never overwritten" >&2
  exit 1
fi
# 126/127: the lookup tool itself is missing or not executable, whatever the message says.
if [ "$status" -eq 126 ] || [ "$status" -eq 127 ]; then
  echo "could not run the lookup for ${what} (exit ${status}); refusing to publish:" >&2
  printf '%s\n' "$output" >&2
  exit 1
fi
# The registry's 404 answers, as the OCI distribution spec and the two clients word them.
if printf '%s\n' "$output" | grep -Eqi '(: not found|404 not found|manifest unknown|name unknown)'; then
  echo "${what} does not exist yet"
  exit 0
fi
echo "could not tell whether ${what} exists (the lookup exited ${status}); refusing to publish:" >&2
printf '%s\n' "$output" >&2
exit 1
