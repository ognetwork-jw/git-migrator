#!/usr/bin/env bash
# PROC-012 (PreToolUse, Bash). Adapted to ADR-0045 (agents integrate into ai-main, never push to main).
# Policy (ADR-0047): the guard parses the common command shapes precisely and FAILS CLOSED on anything
# it cannot analyse with confidence (exit 2, "command too complex ...; rewrite it as a plain command").
# Blocked when parsed:
#   - a git push whose target is main (explicit refspec, HEAD, the current branch, a delete, a wildcard,
#     --all or --mirror), and a forced push or delete of ai-main;
#   - git commit --no-verify (and --no-v... abbreviations, -n), core.hooksPath and alias overrides,
#     and --no-verify on push, merge, rebase, cherry-pick and am;
#   - recursive rm outside .worktrees/ and the Claude scratch root (/tmp/claude-*/).
# Allowed: task-branch pushes, git worktree, heredoc and quoted messages, gh, cd followed by a command.
# shellcheck source-path=SCRIPTDIR source=lib.sh
. "$(dirname "$0")/lib.sh"
export LC_ALL=C
require_jq
input=$(cat)
require_json "$input"

[ "$(json_field "$input" '.tool_name')" = Bash ] || exit 0
cmd=$(json_field "$input" '.tool_input.command')
cwd=$(json_field "$input" '.cwd'); [ -n "$cwd" ] || cwd=$PWD
[ -n "$cmd" ] || exit 0

MAX_COMMAND_BYTES=65536

fail() {
  echo "PROC-012 blocked: $1" >&2
  echo "Command (first 200 bytes): ${cmd:0:200}" >&2
  exit 2
}
fail_complex() {
  fail "command too complex for the PROC-012 guard; rewrite it as a plain command"
}

if (( ${#cmd} > MAX_COMMAND_BYTES )); then fail_complex; fi

# Bound the work: each substitution or backtick, and each command separator, costs a pass of the parser.
# More than MAX_SUBSTITUTIONS or MAX_SEPARATORS (counted on the raw text, quoted or not) is refused.
MAX_SUBSTITUTIONS=64
MAX_SEPARATORS=512
# shellcheck disable=SC2016 # the pattern is literal text
t=${cmd//'$('/}; subs=$(( (${#cmd} - ${#t}) / 2 ))
t=${cmd//\`/}; subs=$(( subs + ${#cmd} - ${#t} ))
t=${cmd//[;\&\|\(\)]/}; seps=$(( ${#cmd} - ${#t} ))
t=${cmd//$'\n'/}; seps=$(( seps + ${#cmd} - ${#t} ))
if (( subs > MAX_SUBSTITUTIONS || seps > MAX_SEPARATORS )); then fail_complex; fi

# is_no_verify <word>: --no-verify, or any abbreviation of it from --no-v onwards.
is_no_verify() {
  [[ ${#1} -ge 6 && $1 == --* && "--no-verify" == "$1"* ]]
}

# check_commit <git-args...>: -m, -F and similar values are skipped, so text inside a message is never
# read as an option. Any other argument must be a plain word (no $, backtick, glob or brace list).
check_commit() {
  local -a a=("$@")
  local i=0 n=${#a[@]} t
  while (( i < n )); do
    t=${a[i]}
    if [[ $t != -- ]] && dynamic_word "$t"; then fail_complex; fi
    case $t in
      --) break ;;
      --message|--file|--author|--date|--fixup|--squash|--cleanup|--template|--trailer|--reuse-message|--reedit-message|--pathspec-from-file)
        i=$(( i + 2 )); continue ;;
      --*)
        if is_no_verify "$t"; then fail "git commit --no-verify is not allowed (PROC-012)"; fi ;;
      -*)
        # A cluster of short options: -n before the first value-taking letter (m F C c t) is --no-verify.
        # A value-taking letter that ends the cluster takes the next word; attached text is its value.
        local k=1 len=${#t} ch takes=0
        while (( k < len )); do
          ch=${t:k:1}
          if [[ $ch == n ]]; then fail "git commit -n is --no-verify and is not allowed (PROC-012)"; fi
          if [[ $ch == [mFCct] ]]; then takes=1; break; fi
          k=$(( k + 1 ))
        done
        if (( takes )); then
          if (( k == len - 1 )); then i=$(( i + 2 )); else i=$(( i + 1 )); fi
          continue
        fi ;;
    esac
    i=$(( i + 1 ))
  done
}

# check_no_verify <git-args...>: subcommands that run hooks, where --no-verify is refused too. Message
# values are skipped as in check_commit; any other argument must be a plain word.
check_no_verify() {
  local -a a=("$@")
  local i=0 n=${#a[@]} t
  while (( i < n )); do
    t=${a[i]}
    [[ $t == -- ]] && break
    if is_no_verify "$t"; then fail "--no-verify is not allowed (PROC-012)"; fi
    case $t in
      -m|-F|-C|-c|--message|--file) i=$(( i + 2 )); continue ;;
    esac
    if dynamic_word "$t"; then fail_complex; fi
    i=$(( i + 1 ))
  done
}

# check_push <dir> <git-args...>. RESOLVE_ARGS (caller's) are the -C/--git-dir/--work-tree options.
check_push() {
  local dir=$1; shift
  local -a args=("$@") positional=() refs=() targets=()
  local force=0 all=0 delete_flag=0 skip=0 q a current ref src dst plus del t b f
  for a in "${args[@]}"; do
    if (( skip )); then skip=0; continue; fi
    if [[ $a != -- ]] && dynamic_word "$a"; then fail_complex; fi
    case $a in
      --repo|--repo=*) fail_complex ;;   # the remote is named by an option; refspecs cannot be told apart
      -o|--push-option|--receive-pack|--exec) skip=1 ;;
      --force|--force-with-lease|--force-with-lease=*|--force-if-includes) force=1 ;;
      --mirror) force=1; all=1 ;;
      --all|--branches) all=1 ;;
      --delete) delete_flag=1 ;;
      --) ;;
      --*)
        if is_no_verify "$a"; then fail "git push --no-verify is not allowed (PROC-012)"; fi
        # git accepts any unambiguous prefix of a long option; match prefixes of the ones that matter.
        q=${a#--}
        if (( ${#q} >= 3 )); then
          [[ force-with-lease == "$q"* || force-if-includes == "$q"* || force == "$q"* ]] && force=1
          [[ delete == "$q"* ]] && delete_flag=1
          [[ mirror == "$q"* ]] && { force=1; all=1; }
          [[ all == "$q"* || branches == "$q"* ]] && all=1
        fi ;;
      -*)
        if [[ $a == *f* ]]; then force=1; fi
        if [[ $a == *d* ]]; then delete_flag=1; fi ;;
      *) positional+=("$a") ;;
    esac
  done

  current=$(git -C "$dir" "${RESOLVE_ARGS[@]}" rev-parse --abbrev-ref HEAD 2>/dev/null)
  [[ $current == HEAD ]] && current=""
  if (( ${#positional[@]} > 1 )); then refs=("${positional[@]:1}"); fi

  # Each target is "branch:forced" (forced = 1 for a forced update or a delete).
  if (( all )); then targets+=("main:1" "ai-main:1"); fi
  if (( ${#refs[@]} == 0 && all == 0 )) && [[ -n $current ]]; then
    targets+=("$current:$force")
  fi
  for ref in "${refs[@]}"; do
    plus=0; del=0
    if [[ $ref == +* ]]; then plus=1; ref=${ref#+}; fi
    if [[ $ref == *:* ]]; then src=${ref%%:*}; dst=${ref#*:}; else src=$ref; dst=$ref; fi
    if [[ $ref == *:* && -z $src ]]; then del=1; fi
    if [[ $dst == +* ]]; then plus=1; dst=${dst#+}; fi
    dst=${dst#refs/}; dst=${dst#heads/}; dst=${dst#heads/}
    if [[ $dst == HEAD ]]; then dst=$current; fi
    if [[ -z $dst || $dst == *\** ]]; then
      targets+=("main:$force" "ai-main:$force")
    else
      targets+=("$dst:$(( force || plus || del || delete_flag ))")
    fi
  done

  for t in "${targets[@]}"; do
    b=${t%:*}; f=${t##*:}
    if [[ $b == main ]]; then fail "git push to main is not allowed; agents integrate into ai-main (ADR-0045)"; fi
    if [[ $b == ai-main && $f == 1 ]]; then fail "force push or delete of ai-main is not allowed (ADR-0045, PROC-012)"; fi
  done
}

# check_rm <base-dir> <rm-args...>: recursive removal must stay inside .worktrees/ or the Claude scratch root.
check_rm() {
  local base=$1; shift
  local recursive=0 end_opts=0 a t abs
  local -a targets=()
  for a in "$@"; do
    if (( ! end_opts )); then
      case $a in
        --) end_opts=1; continue ;;
        --recursive) recursive=1; continue ;;
        --*) continue ;;
        -*[rR]*) recursive=1; continue ;;
        -*) continue ;;
      esac
    fi
    targets+=("$a")
  done
  (( recursive )) || return 0
  for t in "${targets[@]}"; do
    if [[ $t == *\$* || $t == *\`* ]]; then
      fail "rm -r with an unexpanded variable or substitution cannot be checked (PROC-012)"
    fi
    abs=$(abs_path "$t" "$base")
    case $abs in
      */.worktrees/?*) ;;
      /tmp/claude-*/*|/private/tmp/claude-*/*) ;;
      *) fail "rm -r outside .worktrees/ and the Claude scratch root (PROC-012): $abs" ;;
    esac
  done
}

# scan_command <text> <base-dir> <depth>: checks every simple command of a shell command string.
scan_command() {
  local text=$1 base=$2 depth=$3
  local -a SEGMENTS=() WORDS=() CMD_ARGS=() GIT_ARGS=() GIT_RESOLVE=() RESOLVE_ARGS=()
  local CMD_NAME="" GIT_SUB="" seg dir w j code curdir=$base rc
  local -a a
  if ! shell_segments "$text"; then fail_complex; fi
  for seg in "${SEGMENTS[@]}"; do
    split_words "$seg"
    first_command "${WORDS[@]}" || fail_complex
    case $CMD_NAME in
      "") ;;
      'case'|'esac') fail_complex ;;
      git)
        rc=0; parse_git_args "${CMD_ARGS[@]}" || rc=$?
        if (( rc == 2 )); then fail_complex; fi
        (( rc == 0 )) || continue
        RESOLVE_ARGS=("${GIT_RESOLVE[@]}")
        case $GIT_SUB in
          commit) check_commit "${GIT_ARGS[@]}" ;;
          push) check_push "$curdir" "${GIT_ARGS[@]}" ;;
          merge|rebase|cherry-pick|am) check_no_verify "${GIT_ARGS[@]}" ;;
        esac ;;
      rm) check_rm "$curdir" "${CMD_ARGS[@]}" ;;
      cd)
        a=("${CMD_ARGS[@]}"); dir=""
        for w in "${a[@]}"; do
          case $w in
            --|-P|-L) ;;
            *)
              if [[ -n $dir ]]; then fail_complex; fi
              dir=$w ;;
          esac
        done
        if [[ -z $dir || $dir == -* || $dir == *\$* || $dir == *\`* ]]; then fail_complex; fi
        curdir=$(abs_path "$dir" "$curdir") ;;
      sh|bash|zsh|dash|ksh)
        code=""
        for (( j = 0; j < ${#CMD_ARGS[@]}; j++ )); do
          w=${CMD_ARGS[j]}
          if [[ $w == -* && $w != --* && $w == *c* ]]; then code=${CMD_ARGS[j + 1]-}; break; fi
        done
        # Without -c the shell runs a script file or reads stdin, which cannot be analysed.
        if [[ -z $code ]] || [[ $code == *\$* || $code == *\`* ]] || (( depth >= 5 )); then fail_complex; fi
        scan_command "$code" "$curdir" $(( depth + 1 )) ;;
      eval)
        code="${CMD_ARGS[*]}"
        if [[ $code == *\$* || $code == *\`* ]] || (( depth >= 5 )); then fail_complex; fi
        scan_command "$code" "$curdir" $(( depth + 1 )) ;;
      find)
        for w in "${CMD_ARGS[@]}"; do
          case $w in -exec|-execdir|-ok|-okdir|-delete) fail_complex ;; esac
        done ;;
    esac
  done
}

scan_command "$cmd" "$cwd" 0
exit 0
