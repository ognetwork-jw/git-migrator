#!/usr/bin/env bash
# PROC-010 (PostToolUse, Edit|Write|MultiEdit): biome check --write on the edited file.
# Remaining errors exit 2 so the agent fixes them.
set -o pipefail
# shellcheck source-path=SCRIPTDIR source=lib.sh
. "$(dirname "$0")/lib.sh"
require_jq
input=$(cat)
require_json "$input"

path=$(json_field "$input" '.tool_input.file_path')
cwd=$(json_field "$input" '.cwd'); [ -n "$cwd" ] || cwd=$PWD
[ -n "$path" ] || exit 0

case $path in
  *.ts|*.tsx|*.mts|*.cts|*.js|*.jsx|*.mjs|*.cjs|*.json|*.jsonc|*.css) ;;
  *) exit 0 ;;
esac

abs=$(abs_path "$path" "$cwd")
[ -f "$abs" ] || exit 0

# The repository that owns the file; the session project directory when the file is outside git.
root=$(git -C "$(dirname "$abs")" rev-parse --show-toplevel 2>/dev/null) \
  || root=${CLAUDE_PROJECT_DIR:-$cwd}
biome="$root/node_modules/.bin/biome"
if [ ! -x "$biome" ]; then
  echo "PROC-010: biome is not installed in $root (run pnpm install); skipped" >&2
  exit 0
fi

rel=${abs#"$root"/}
log=$(mktemp) || exit 2
if ! (cd "$root" && "$biome" check --write --no-errors-on-unmatched -- "$rel") >"$log" 2>&1; then
  echo "PROC-010: biome check failed for $rel. Fix the errors below." >&2
  tail -n 80 "$log" >&2
  rm -f "$log"
  exit 2
fi
rm -f "$log"
exit 0
