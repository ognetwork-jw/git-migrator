#!/usr/bin/env bash
# Shared helpers for the Claude Code hooks (PROC-010 … PROC-014, docs/process/workflow.md).
# Hooks read the hook JSON from stdin, and block by exiting 2 with the reason on stderr.
# Sourced, never executed directly.
# shellcheck disable=SC2034 # the GIT_*, CMD_* and WORDS/SEGMENTS globals are read by the sourcing hooks
# shellcheck disable=SC2088 # "~/"* is a case pattern, not a path

# Fail closed: a guard that cannot read its input must block, not allow.
require_jq() {
  command -v jq >/dev/null 2>&1 || { echo "hook: jq is required and was not found" >&2; exit 2; }
}

# require_json <payload>: blocks (exit 2) when the hook payload is not valid JSON.
require_json() {
  printf '%s' "$1" | jq -e . >/dev/null 2>&1 || { echo "hook: stdin is not valid JSON" >&2; exit 2; }
}

# json_field <json> <jq-path>: prints the value, or nothing when it is absent.
json_field() {
  printf '%s' "$1" | jq -r "$2 // empty"
}

# abs_path <path> <base>: absolute, normalized (.. and symlinks resolved where they exist).
# Expands a leading ~ to $HOME. Relative paths are resolved against <base>.
abs_path() {
  local p=$1 base=$2
  case $p in
    "~") p=$HOME ;;
    "~/"*) p="$HOME/${p#\~/}" ;;
  esac
  case $p in
    /*) ;;
    *) p="$base/$p" ;;
  esac
  realpath -m -- "$p" 2>/dev/null || printf '%s\n' "$p"
}

# shell_segments <command>: splits a shell command into simple commands and each simple command into
# its words, with quotes removed. Sets SEGMENTS (caller's variable): one entry per simple command, words
# joined by US (0x1f). Returns 2 when the command is outside what the guard can analyse with confidence:
#   - unterminated quote, $(...), backtick, heredoc or process substitution at the end of input;
#   - ANSI-C quoting ($'...') outside quotes;
#   - process substitution (<(...) or >(...));
#   - an unquoted-delimiter heredoc whose body contains $( or a backtick (the body is expanded).
# Quoted text is never split. A quoted-delimiter heredoc body is inert and skipped.
# A $(...) or backtick body is scanned as commands, also inside double quotes; the words of the
# enclosing command wait while it is scanned.
shell_segments() {
  local s=$1 n=${#1} i=0 c d rest line len top word="" inword=0 mode=N wq=0
  local hd_next=0 hd_strip=0 hd_quoted=0 skip_word=0 cmp k body
  local -a stack=() pend=() pend_strip=() pend_quoted=() cur=() savecur=()
  SEGMENTS=()

  _sh_top() {
    top=""
    if (( ${#stack[@]} )); then top=${stack[-1]}; fi
  }
  _sh_push_cur() {
    local j="" t
    for t in "${cur[@]}"; do j+="$t"$'\x1f'; done
    savecur+=("$j"); cur=()
  }
  _sh_pop_cur() {
    local r=""
    if (( ${#savecur[@]} )); then r=${savecur[-1]}; unset "savecur[${#savecur[@]}-1]"; fi
    cur=()
    while [[ $r == *$'\x1f'* ]]; do cur+=("${r%%$'\x1f'*}"); r=${r#*$'\x1f'}; done
    # The substitution's output is a word the guard cannot know: keep a marker containing $, so the
    # rm, push and command checks see a dynamic word and fail closed.
    # shellcheck disable=SC2016 # the marker is literal text
    word='$(sub)'; inword=1
  }
  # A substitution opens: an empty pending word (the opening quote) is dropped, so the substitution's
  # marker is the word itself (for -m "$(...)" the marker is the message value).
  _sh_open_subst() {
    if [[ -z $word ]]; then inword=0; wq=0; fi
    _sh_end_word
    _sh_push_cur
  }
  _sh_end_word() {
    if (( inword )); then
      if (( hd_next )); then
        pend+=("$word"); pend_strip+=("$hd_strip"); pend_quoted+=("$wq")
        hd_next=0; hd_strip=0
      elif (( skip_word )); then
        skip_word=0
      else
        cur+=("$word")
      fi
    fi
    word=""; inword=0; wq=0
  }
  _sh_end_seg() {
    _sh_end_word
    if (( ${#cur[@]} )); then
      local joined="" t
      for t in "${cur[@]}"; do joined+="$t"$'\x1f'; done
      SEGMENTS+=("$joined")
      cur=()
    fi
  }
  # Skips the pending heredoc bodies that start after the current newline (position i).
  _sh_skip_heredocs() {
    for k in "${!pend[@]}"; do
      body=""
      local found=0
      while (( i < n )); do
        rest=${s:i}; line=${rest%%$'\n'*}; len=${#line}
        i=$(( i + len + 1 ))
        body+="$line"$'\n'
        cmp=$line
        if (( pend_strip[k] )); then cmp=${cmp#"${cmp%%[!$'\t']*}"}; fi
        if [[ $cmp == "${pend[k]}" ]]; then found=1; break; fi
      done
      (( found )) || return 2
      # shellcheck disable=SC2016 # the patterns are literal text
      if (( ! pend_quoted[k] )) && [[ $body == *'$('* || $body == *'`'* ]]; then return 2; fi
    done
    pend=(); pend_strip=(); pend_quoted=()
    return 0
  }

  while (( i < n )); do
    c=${s:i:1}
    if [[ $mode == S ]]; then
      if [[ $c == "'" ]]; then mode=N; else word+=$c; fi
      i=$(( i + 1 )); continue
    fi

    if [[ $mode == D ]]; then
      case $c in
        '"') mode=N ;;
        "\\")
          d=${s:i+1:1}
          case $d in
            '"'|"\\"|'$'|'`') word+=$d; i=$(( i + 1 )) ;;
            $'\n') i=$(( i + 1 )) ;;
            *) word+="\\" ;;
          esac ;;
        '$')
          if [[ ${s:i+1:1} == '(' ]]; then
            _sh_open_subst
            stack+=("D"); mode=N; i=$(( i + 2 )); continue
          fi
          word+=$c; inword=1 ;;
        '`')
          _sh_open_subst
          stack+=("DB"); mode=N ;;
        *) word+=$c; inword=1 ;;
      esac
      i=$(( i + 1 )); continue
    fi

    # Unquoted context.
    case $c in
      ' '|$'\t') _sh_end_word ;;
      $'\n')
        _sh_end_seg; i=$(( i + 1 ))
        if (( ${#pend[@]} )); then _sh_skip_heredocs || return 2; fi
        continue ;;
      "'") inword=1; wq=1; mode=S ;;
      '"') inword=1; wq=1; mode=D ;;
      "\\")
        d=${s:i+1:1}
        if [[ $d == $'\n' ]]; then i=$(( i + 2 )); continue; fi
        if [[ -n $d ]]; then word+=$d; inword=1; wq=1; i=$(( i + 2 )); continue; fi
        word+=$c; inword=1 ;;
      '#')
        if (( inword )); then word+=$c
        else
          rest=${s:i}; line=${rest%%$'\n'*}
          i=$(( i + ${#line} )); continue
        fi ;;
      ';'|'&'|'|') _sh_end_seg ;;
      '(') _sh_end_seg; if (( ${#stack[@]} )); then stack+=("P"); fi ;;
      ')')
        _sh_end_seg
        _sh_top
        case $top in
          P) unset "stack[${#stack[@]}-1]" ;;
          D|N)
            unset "stack[${#stack[@]}-1]"
            if [[ $top == D ]]; then mode=D; else mode=N; fi
            _sh_pop_cur ;;
        esac ;;
      '`')
        _sh_top
        case $top in
          DB|NB)
            _sh_end_seg
            unset "stack[${#stack[@]}-1]"
            if [[ $top == DB ]]; then mode=D; else mode=N; fi
            _sh_pop_cur ;;
          *) _sh_open_subst; stack+=("NB"); mode=N ;;
        esac ;;
      '$')
        case ${s:i+1:1} in
          "'") return 2 ;;
          '(') _sh_open_subst; stack+=("N"); i=$(( i + 2 )); continue ;;
        esac
        word+=$c; inword=1 ;;
      '<'|'>')
        if [[ ${s:i+1:1} == '(' ]]; then return 2; fi
        if [[ $word =~ ^[0-9]+$ ]]; then word=""; inword=0; fi
        _sh_end_word
        if [[ $c == '<' && ${s:i+1:1} == '<' ]]; then
          if [[ ${s:i+2:1} == '<' ]]; then i=$(( i + 3 )); continue; fi
          hd_next=1; i=$(( i + 2 ))
          if [[ ${s:i:1} == '-' ]]; then hd_strip=1; i=$(( i + 1 )); fi
          continue
        fi
        i=$(( i + 1 ))
        if [[ ${s:i:1} == '>' || ${s:i:1} == '<' ]]; then i=$(( i + 1 )); fi
        if [[ ${s:i:1} == '&' ]]; then
          i=$(( i + 1 ))
          # The file descriptor of a duplication (2>&1, >&-) is part of the redirection, not a word.
          while [[ ${s:i:1} == [0-9] ]]; do i=$(( i + 1 )); done
          if [[ ${s:i:1} == '-' ]]; then i=$(( i + 1 )); fi
        else
          skip_word=1
        fi
        continue ;;
      *) word+=$c; inword=1 ;;
    esac
    i=$(( i + 1 ))
  done

  # Input ended: anything still open is unparseable.
  if [[ $mode != N ]] || (( ${#stack[@]} )) || (( ${#pend[@]} )); then return 2; fi
  _sh_end_seg
  return 0
}

# split_words <simple-command>: sets WORDS (caller's variable) to the words of one entry from SEGMENTS.
split_words() {
  local rest=$1 w
  WORDS=()
  while [[ $rest == *$'\x1f'* ]]; do
    w=${rest%%$'\x1f'*}
    WORDS+=("$w")
    rest=${rest#*$'\x1f'}
  done
  [[ -n $rest ]] && WORDS+=("$rest")
  return 0
}

# denied_env <NAME>: 0 when the variable changes which repository, configuration, hooks or transport git
# uses. Other GIT_* variables (GIT_SEQUENCE_EDITOR, GIT_EDITOR, GIT_AUTHOR_*, GIT_TRACE...) are harmless.
denied_env() {
  case $1 in
    GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_CONFIG|GIT_CONFIG_*|GIT_EXEC_PATH|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_OBJECT_DIRECTORY|GIT_INDEX_FILE|GIT_NAMESPACE|GIT_SSH|GIT_SSH_COMMAND|GIT_SSH_VARIANT|GIT_PROXY_COMMAND|GIT_TEMPLATE_DIR|GIT_CEILING_DIRECTORIES|GIT_DISCOVERY_ACROSS_FILESYSTEM)
      return 0 ;;
  esac
  return 1
}

# dynamic_word <word>: 0 when the word is computed at run time or expanded by the shell: it contains
# $, a backtick, a glob character, or a brace list. Such a word cannot be checked, so the guard fails closed.
dynamic_word() {
  local t
  case $1 in
    *'$'*|*'`'*|*'*'*|*'?'*|*'['*) return 0 ;;
  esac
  t=${1//'@{'/}          # HEAD@{1} and @{u} are reflog and upstream syntax, not brace lists
  case $t in
    *'{'*'}'*) return 0 ;;
  esac
  return 1
}

# first_command "${WORDS[@]}": sets CMD_NAME (basename of the command word) and CMD_ARGS (the words after
# it). Assignments, and the wrappers env, command, exec, nice, nohup, stdbuf, time, timeout, and the
# reserved words, are skipped with their options. Returns 2 when a wrapper's options cannot be read with
# confidence (for example sudo, xargs, or an unknown env option), or when a GIT_* variable is assigned.
first_command() {
  local -a toks=("$@")
  local i=0 n=${#toks[@]} w b o
  CMD_NAME=""; CMD_ARGS=()
  while (( i < n )); do
    w=${toks[i]}
    if [[ $w =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
      if denied_env "${w%%=*}"; then return 2; fi
      i=$(( i + 1 )); continue
    fi
    b=${w##*/}
    case $b in
      '!'|'{'|'}'|if|then|else|elif|do|done|while|until|nohup)
        i=$(( i + 1 )) ;;
      time)
        i=$(( i + 1 ))
        while (( i < n )) && [[ ${toks[i]} == -* ]]; do
          case ${toks[i]} in
            -p|-v|--) i=$(( i + 1 )) ;;
            -f|-o) i=$(( i + 2 )) ;;
            *) return 2 ;;
          esac
        done ;;
      env)
        i=$(( i + 1 ))
        while (( i < n )); do
          o=${toks[i]}
          if [[ $o =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
            if denied_env "${o%%=*}"; then return 2; fi
            i=$(( i + 1 )); continue
          fi
          case $o in
            -i|-0|-v|--ignore-environment|--null) i=$(( i + 1 )) ;;
            -u|-C|--unset|--chdir) i=$(( i + 2 )) ;;
            --) i=$(( i + 1 )); break ;;
            -*) return 2 ;;
            *) break ;;
          esac
        done ;;
      command)
        i=$(( i + 1 ))
        while (( i < n )) && [[ ${toks[i]} == -* ]]; do
          case ${toks[i]} in
            -p) i=$(( i + 1 )) ;;
            -v|-V) CMD_NAME=""; return 0 ;;   # only looks a command up; it runs nothing
            --) i=$(( i + 1 )); break ;;
            *) return 2 ;;
          esac
        done ;;
      exec)
        i=$(( i + 1 ))
        while (( i < n )) && [[ ${toks[i]} == -* ]]; do
          case ${toks[i]} in
            -c|-l) i=$(( i + 1 )) ;;
            -a) i=$(( i + 2 )) ;;
            *) return 2 ;;
          esac
        done ;;
      nice)
        i=$(( i + 1 ))
        while (( i < n )) && [[ ${toks[i]} == -* ]]; do
          case ${toks[i]} in
            -n) i=$(( i + 2 )) ;;
            -[0-9]*|--adjustment=*) i=$(( i + 1 )) ;;
            *) return 2 ;;
          esac
        done ;;
      stdbuf)
        i=$(( i + 1 ))
        while (( i < n )) && [[ ${toks[i]} == -* ]]; do
          case ${toks[i]} in
            -i|-o|-e) i=$(( i + 2 )) ;;
            -i*|-o*|-e*) i=$(( i + 1 )) ;;
            *) return 2 ;;
          esac
        done ;;
      timeout)
        i=$(( i + 1 ))
        while (( i < n )) && [[ ${toks[i]} == -* ]]; do
          case ${toks[i]} in
            -s|-k) i=$(( i + 2 )) ;;
            --signal=*|--kill-after=*|--preserve-status|--foreground|-v|--verbose) i=$(( i + 1 )) ;;
            *) return 2 ;;
          esac
        done
        i=$(( i + 1 )) ;;   # the DURATION operand
      eval) break ;;   # scanned by scan_command
      setsid)
        i=$(( i + 1 ))
        while (( i < n )) && [[ ${toks[i]} == -* ]]; do
          case ${toks[i]} in
            -c|-f|-w|--ctty|--fork|--wait) i=$(( i + 1 )) ;;
            --) i=$(( i + 1 )); break ;;
            *) return 2 ;;
          esac
        done ;;
      ionice)
        i=$(( i + 1 ))
        while (( i < n )) && [[ ${toks[i]} == -* ]]; do
          case ${toks[i]} in
            -c|-n) i=$(( i + 2 )) ;;
            -c*|-n*|-t) i=$(( i + 1 )) ;;
            --) i=$(( i + 1 )); break ;;
            *) return 2 ;;
          esac
        done ;;
      flock)
        i=$(( i + 1 ))
        while (( i < n )) && [[ ${toks[i]} == -* ]]; do
          case ${toks[i]} in
            -w|-E|--timeout|--conflict-exit-code) i=$(( i + 2 )) ;;
            -s|-x|-u|-n|-o|--shared|--exclusive|--unlock|--nonblock|--close) i=$(( i + 1 )) ;;
            --) i=$(( i + 1 )); break ;;
            *) return 2 ;;   # -c and --command run a shell string
          esac
        done
        i=$(( i + 1 )) ;;   # the lock file or directory
      chrt)
        i=$(( i + 1 ))
        while (( i < n )) && [[ ${toks[i]} == -* ]]; do
          case ${toks[i]} in
            -f|-r|-o|-b|-i|-m|-d|-R|--fifo|--rr|--other|--batch|--idle|--max|--deadline|--reset-on-fork) i=$(( i + 1 )) ;;
            --) i=$(( i + 1 )); break ;;
            *) return 2 ;;   # -p works on a process, not a command
          esac
        done
        i=$(( i + 1 )) ;;   # the priority
      taskset)
        i=$(( i + 1 ))
        while (( i < n )) && [[ ${toks[i]} == -* ]]; do
          case ${toks[i]} in
            -c|-a|--cpu-list|--all-tasks) i=$(( i + 1 )) ;;
            --) i=$(( i + 1 )); break ;;
            *) return 2 ;;   # -p works on a process, not a command
          esac
        done
        i=$(( i + 1 )) ;;   # the CPU mask or list
      sudo|su|doas|xargs|pushd|popd|source|.|watch|script) return 2 ;;
      *) break ;;
    esac
  done
  if (( i < n )); then
    if dynamic_word "${toks[i]}"; then return 2; fi
    CMD_NAME=${toks[i]##*/}
    CMD_ARGS=("${toks[@]:i + 1}")
  fi
  return 0
}

# parse_git_args "${CMD_ARGS[@]}": reads the global options of a git invocation. Sets
#   GIT_SUB     the subcommand
#   GIT_ARGS    the arguments after the subcommand
#   GIT_RESOLVE the global options that select the repository (-C, --git-dir, --work-tree), for rev-parse
# Returns 2 for a global option it does not know (fail closed). Returns 1 when there is no subcommand.
# -c alias.* and -c core.hooksPath=* are refused (2): they change what a subcommand does.
parse_git_args() {
  GIT_SUB=""; GIT_ARGS=(); GIT_RESOLVE=()
  local -a toks=("$@")
  local i=0 n=${#toks[@]} t key
  while (( i < n )); do
    t=${toks[i]}
    if dynamic_word "$t"; then return 2; fi
    case $t in
      -C) GIT_RESOLVE+=("-C" "${toks[i + 1]:-}"); i=$(( i + 2 )) ;;
      -c)
        key=${toks[i + 1]:-}; key=${key%%=*}
        case ${key,,} in alias.*|core.hookspath) return 2 ;; esac
        i=$(( i + 2 )) ;;
      --git-dir|--work-tree) GIT_RESOLVE+=("$t" "${toks[i + 1]:-}"); i=$(( i + 2 )) ;;
      --namespace|--super-prefix|--config-env)
        if [[ $t == --config-env ]]; then
          key=${toks[i + 1]:-}; key=${key%%=*}
          case ${key,,} in alias.*|core.hookspath) return 2 ;; esac
        fi
        i=$(( i + 2 )) ;;
      --git-dir=*|--work-tree=*) GIT_RESOLVE+=("$t"); i=$(( i + 1 )) ;;
      --namespace=*|--super-prefix=*|--exec-path=*|--list-cmds=*) i=$(( i + 1 )) ;;
      --config-env=*)
        key=${t#--config-env=}; key=${key%%=*}
        case ${key,,} in alias.*|core.hookspath) return 2 ;; esac
        i=$(( i + 1 )) ;;
      -p|-P|--paginate|--no-pager|--bare|--no-replace-objects|--literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs|--no-optional-locks|--exec-path|--html-path|--man-path|--info-path|--version|--help)
        i=$(( i + 1 )) ;;
      -*) return 2 ;;
      *) break ;;
    esac
  done
  (( i < n )) || return 1
  if dynamic_word "${toks[i]}"; then return 2; fi
  GIT_SUB=${toks[i]}
  GIT_ARGS=("${toks[@]:i + 1}")
  return 0
}

# gate_failure <message> <log> <stop_hook_active>: a failed check blocks the stop (exit 2) with the
# tail of its output. When the hook payload says the stop is already being continued by a hook
# (stop_hook_active), it warns with the tail and lets the stop through, so a red check can never
# trap the session in a loop (ADR-0048).
gate_failure() {
  local msg=$1 log=$2 active=$3
  if [ "$active" = true ]; then
    echo "$msg. Stop hook already continued once, so this stop is allowed. Fix it before the next stop." >&2
    tail -n 60 "$log" >&2
    rm -f "$log"
    exit 0
  fi
  echo "$msg" >&2
  tail -n 120 "$log" >&2
  rm -f "$log"
  exit 2
}
