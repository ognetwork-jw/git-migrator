#!/usr/bin/env bash
# PROC-013 (SubagentStop). When the subagent ran in a task worktree (.worktrees/T-*) and its branch
# has commits beyond origin/ai-main (ADR-0045), run the affected typecheck and unit tests.
# Failure exits 2 with the tail of the output (see gate_failure). Reviewer agents are skipped
# (ADR-0048). GM_HOOK_PROC013_CMD overrides the command (used by tools/hooks.test.ts).
# shellcheck source-path=SCRIPTDIR source=lib.sh
. "$(dirname "$0")/lib.sh"
require_jq
input=$(cat)
require_json "$input"

cwd=$(json_field "$input" '.cwd'); [ -n "$cwd" ] || cwd=$PWD
active=$(json_field "$input" '.stop_hook_active')
agent=$(json_field "$input" '.agent_type // .agent_name')
case $agent in reviewer-*) exit 0 ;; esac
[[ $cwd == */.worktrees/T-* ]] || exit 0

root=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null) || exit 0

ahead=$(git -C "$root" rev-list --count origin/ai-main..HEAD 2>/dev/null)
if [ -z "$ahead" ]; then
  echo "PROC-013 blocked: cannot count commits beyond origin/ai-main in $root (run git fetch origin ai-main)" >&2
  exit 2
fi
[ "$ahead" -gt 0 ] || exit 0

cmd=${GM_HOOK_PROC013_CMD:-'pnpm turbo run typecheck test --filter=...[origin/ai-main]'}
log=$(mktemp) || exit 2
if ! (cd "$root" && bash -c "$cmd") >"$log" 2>&1; then
  gate_failure "PROC-013: typecheck and tests failed for $root. Fix them before finishing" "$log" "$active"
fi
rm -f "$log"
exit 0
