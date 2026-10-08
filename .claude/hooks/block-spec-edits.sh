#!/usr/bin/env bash
# PROC-011 (PreToolUse, Edit|Write|MultiEdit): docs/spec/** is read-only inside a task worktree.
# The orchestrator edits the spec from the main checkout, so only .worktrees/ paths are blocked.
# shellcheck source-path=SCRIPTDIR source=lib.sh
. "$(dirname "$0")/lib.sh"
require_jq
input=$(cat)
require_json "$input"

path=$(json_field "$input" '.tool_input.file_path')
cwd=$(json_field "$input" '.cwd'); [ -n "$cwd" ] || cwd=$PWD
[ -n "$path" ] || exit 0

abs=$(abs_path "$path" "$cwd")
if [[ $abs == */.worktrees/*/docs/spec/* ]]; then
  echo "PROC-011 blocked: docs/spec/** is normative and read-only for implementors (AGENTS.md). Record an agent-decided ADR in docs/adr/ instead. Path: $abs" >&2
  exit 2
fi
exit 0
