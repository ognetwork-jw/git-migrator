#!/usr/bin/env bash
# PROC-014 (Stop). In the main checkout, once docs/process/progress.md lists every task as merged
# (split counts as done), run the full Definition of Done. Failure exits 2 with the tail of the output
# (see gate_failure). A green run is cached in .git/ with the HEAD and working-tree state, so a stop
# with nothing changed since the last green run does not run the Definition of Done again. Untracked
# files are part of the state, so an edit to one of them re-runs the check.
#
# GM_HOOK_PROC014_CMD overrides the command (used by tools/hooks.test.ts).
# shellcheck source-path=SCRIPTDIR source=lib.sh
. "$(dirname "$0")/lib.sh"
require_jq
input=$(cat)
require_json "$input"

cwd=$(json_field "$input" '.cwd'); [ -n "$cwd" ] || cwd=$PWD
active=$(json_field "$input" '.stop_hook_active')
root=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null) || exit 0
# Only the main checkout has a .git directory; task worktrees have a .git file.
[ -d "$root/.git" ] || exit 0

progress="$root/docs/process/progress.md"
[ -f "$progress" ] || exit 0

# Task rows are "| T-xxx | status | ...". Every one must be merged or split, and there must be one.
read -r total done_count < <(
  awk -F'|' '
    /^\| T-[0-9]+ \|/ {
      total++
      status = $3; gsub(/^ +| +$/, "", status)
      if (status == "merged" || status == "split") done_count++
    }
    END { print total + 0, done_count + 0 }' "$progress"
)
[ "$total" -gt 0 ] && [ "$total" -eq "$done_count" ] || exit 0

# Skip when nothing changed since the last green run.
cache="$root/.git/gm-dod-green"
# The key covers HEAD, the tracked changes, and the contents of untracked files (not ignored ones).
state=$(
  {
    git -C "$root" rev-parse HEAD
    git -C "$root" status --porcelain
    git -C "$root" diff HEAD
    git -C "$root" ls-files -o --exclude-standard -z | while IFS= read -r -d '' f; do cksum "$root/$f"; done
  } 2>/dev/null | cksum
)
if [ -f "$cache" ] && [ "$(cat "$cache")" = "$state" ]; then exit 0; fi

cmd=${GM_HOOK_PROC014_CMD:-'pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration && pnpm test:e2e && pnpm helm:check'}
log=$(mktemp) || exit 2
if ! (cd "$root" && bash -c "$cmd") >"$log" 2>&1; then
  gate_failure "PROC-014: every task is merged or split, and the Definition of Done failed" "$log" "$active"
fi
rm -f "$log"
printf '%s\n' "$state" >"$cache"
exit 0
