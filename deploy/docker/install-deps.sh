#!/bin/sh
# Runs once, as root, in the Compose `install` service (compose.yaml). It drops to the host UID/GID
# and installs the checkout there, so node_modules in the bind mount is owned by the host user and
# no root-owned mount points appear in the checkout (ADR-0068).
# Groups are cleared, not looked up: the host UID may have no passwd entry (for example 1234).
# A `preinstall` guard in the root package.json refuses an install from the other origin.
set -eu
uid="${GM_UID:-1000}"
gid="${GM_GID:-1000}"
exec setpriv --reuid="$uid" --regid="$gid" --clear-groups \
  sh -c 'cd /workspace && pnpm install --frozen-lockfile'
