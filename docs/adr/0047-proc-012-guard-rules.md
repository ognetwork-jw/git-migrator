# ADR-0047: PROC-012 guard rules under ADR-0045, and the fail-closed policy

- Status: accepted (no spec change needed)
- Date: 2026-10-08

## Context

PROC-012 says to block `git push` with `--force`/`-f` when the target is `main`, to block `git commit --no-verify`, and to block `rm -rf` outside `.worktrees/` and scratch directories. ADR-0045 makes `ai-main` the integration branch and forbids agents from pushing to `main`. Several cases are not spelled out: which pushes count as targeting `main`, whether force pushes and deletes of `ai-main` are blocked, what "scratch directories" means, and whether `rm -r` without `-f` counts.

Shell commands are not regular. Text searches were bypassed by quoting, substitutions, wrappers, global git options and paths. Round 2 review found more bypasses each time a parsing rule was added. The policy was therefore changed to a conservative one.

## Decision

### Fail-closed policy

The guard parses the common command shapes precisely. It blocks, with exit 2 and the message "command too complex for the PROC-012 guard; rewrite it as a plain command", anything it cannot analyse with confidence. A false block with a clear message is acceptable. A silent bypass is not. Specifically it fails closed on:

- a command longer than 64 KiB, or with more than 64 substitutions (`$(` and backticks together) or more than 512 command separators, counted on the raw text (checked before parsing, so the cost is bounded; 2000 substitutions are refused in well under a second);
- an unterminated quote, `$(`, backtick, heredoc or process substitution at the end of input;
- ANSI-C quoting `$'...'` outside quotes;
- process substitution `<(...)` and `>(...)`;
- an unquoted-delimiter heredoc whose body contains `$(` or a backtick (the body is expanded). Quoted-delimiter heredocs (`<<'EOF'`) are inert and are skipped;
- `case` and `esac` as command words;
- a wrapper whose options cannot be read: `sudo`, `su`, `doas`, `xargs`, `pushd`, `popd`, `source`, `.`, `watch` and `script`, and an unknown option of `env`, `command`, `exec`, `nice`, `stdbuf`, `time`, `timeout`, `setsid`, `ionice`, `flock`, `chrt` or `taskset`. Those wrappers that take a command are skipped with their options;
- an assignment, before a command or as an `env` operand, of a `GIT_*` variable that changes the repository, configuration, hooks or transport: `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_CONFIG` and every `GIT_CONFIG_*` (`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_n`, `GIT_CONFIG_VALUE_n`, `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_NOSYSTEM`), `GIT_EXEC_PATH`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_OBJECT_DIRECTORY`, `GIT_INDEX_FILE`, `GIT_NAMESPACE`, `GIT_SSH`, `GIT_SSH_COMMAND`, `GIT_SSH_VARIANT`, `GIT_PROXY_COMMAND`, `GIT_TEMPLATE_DIR`, `GIT_CEILING_DIRECTORIES` and `GIT_DISCOVERY_ACROSS_FILESYSTEM`. Every other `GIT_*` variable is allowed, for example `GIT_SEQUENCE_EDITOR`, `GIT_EDITOR`, `GIT_AUTHOR_*`, `GIT_COMMITTER_*`, `GIT_TERMINAL_PROMPT` and `GIT_TRACE*`, so the fix-pass commands run;
- a word the shell expands or globs before git sees it: any word that contains `$`, a backtick, `*`, `?`, `[`, or a brace list (`{a,b}`), when it is the command word, a git global option or value, the git subcommand, or an argument of push, commit, merge, rebase, cherry-pick or am. The values of `-m`, `-F`, `-C`, `-c`, `--message` and `--file` are the exception, because they are message text;
- `git push --repo` (the remote named by an option; refspecs cannot be told apart);
- a git global option the guard does not know, and `-c` or `--config-env` with an `alias.*` or `core.hooksPath` key;
- a substitution (`$(...)` or a backtick) used as a word. Its output is unknown, so the word is kept as a marker containing `$`, and every check that refuses expansions refuses it. The marker is the value of a message option, which is still skipped;
- `cd` with no target, with more than one target, with `-`, or with an expanded target;
- `sh`, `bash`, `zsh`, `dash` or `ksh` without `-c`, or with a `-c` string containing `$` or a backtick (the code is not known);
- `eval` with arguments containing `$` or a backtick;
- `find` with `-exec`, `-execdir`, `-ok`, `-okdir` or `-delete`;
- nesting deeper than 5 levels of `sh -c` or `eval`.

### Parsed rules

1. **Command names** are matched by basename, after the wrappers above are skipped (`/usr/bin/git` is `git`). A `VAR=value` assignment before the command is skipped.
2. **Git global options** are read with a table: options that take a separate value are `-C`, `-c`, `--git-dir`, `--work-tree`, `--namespace`, `--super-prefix`, `--config-env`. Attached forms (`--git-dir=...`) take no further argument. `-C`, `--git-dir` and `--work-tree` are passed to `rev-parse` when the current branch is needed.
3. **Long options and refspecs.** git accepts unambiguous long-option prefixes, so `--forc`, `--del` and `--mir` match `--force`, `--delete` and `--mirror` (prefixes of at least three letters). A short refspec `heads/main` names `refs/heads/main` and is checked as main.
4. **Push target.** A `git push` is blocked when any target is `main`. Targets are the explicit destinations (`HEAD:main`, `x:main`, `:main`, `refs/heads/main`), the current branch when the push names none or names `HEAD`, all branches for `--all` or `--mirror`, a wildcard or empty destination, and the destination of a delete.
5. **Force or delete of ai-main.** A push to `ai-main` is blocked when it is forced or deletes the branch: `--force`, `--force-with-lease`, `--force-if-includes`, `--mirror`, `--delete`, any single-dash cluster containing `f` or `d` (`-fu`, `-uf`, `-fv`), a `+` refspec, or an empty source (`:ai-main`, `:refs/heads/ai-main`, `:+ai-main`). A fast-forward push to `ai-main` is allowed (the merge agent needs it, PROC-002). Forced pushes to task branches are allowed (fixup rounds use `--force-with-lease`, PROC-020).
6. **No-verify.** `git commit` is blocked for `--no-verify`, any prefix of it from `--no-v` onward, a short-option cluster in which `n` appears before the first value-taking letter (`m F C c t`), and `-c core.hooksPath=...`. A value attached to a cluster (`-mfoo`, `-am"n"`) is text, so the next word is not taken as its value. The values of `-m`, `-F`, `-C`, `-c`, `-t`, `--message`, `--file` and similar options are skipped, so a message is never read as an option. A `--` ends the options, so `git commit -m x -- --no-verify` names a pathspec. The same `--no-verify` check applies to `git push`, `merge`, `rebase`, `cherry-pick` and `am`.
7. **Recursive rm.** `rm` with a recursive flag (`-r`, `-R`, `-rf`, `--recursive`) is blocked unless every target resolves, after `..` and symlink normalization, to a path inside a `.worktrees/` directory or inside `/tmp/claude-*/`, the session scratch root. The force flag is not required, because `rm -r` without `-f` also deletes unattended. A target containing `$` or a backtick is blocked.
8. **cd.** A plain `cd <dir>` is tracked, and later commands in the same string resolve against it, so `cd <main checkout> && git push` is checked against the main checkout.

## Alternatives

- Text search with quote stripping: bypassed by unbalanced quotes and substitutions, and it blocks messages that only mention a push. Rejected.
- Adding a parsing rule for each bypass found: round 2 showed this does not converge. Rejected for the fail-closed policy.
- Only `-rf` blocked: leaves `rm -r` open, with no benefit.
- Any `/tmp` path as scratch: an agent could delete a repository that lives under `/tmp`. Narrowed to `/tmp/claude-*/`.

## Known limits (accepted)

These are not parsed and are not blocked, because the guard does not claim to see them:

- Deletion commands other than `rm -r`: `unlink`, `rmdir`, `trash`, `git clean -fdx` and `git worktree remove --force` can remove a worktree or a repository directory. Only `rm -r` is checked.
- The GitHub API: `gh api -X DELETE` or `PATCH` on a branch ref, a branch-protection rule or a repository can change `main` or `ai-main` without a git push. Agents must not call these endpoints.
- Persistent git configuration: `core.hooksPath`, `alias.*` and `include.path` in `.git/config`, a global `~/.gitconfig` or a file included from one of them are not seen. Only the same keys passed with `-c` or `--config-env` are refused. A repository whose config was changed earlier can skip the commit hooks or rewrite a subcommand.

- Interpreters and build tools that run git or rm: `python -c`, `node -e`, `perl -e`, `make`, `npx`, `pnpm exec`, scripts run from a file, and `git` aliases defined in a user's or repository's `.gitconfig` (the guard only refuses `-c alias.*`). An agent that runs these can bypass PROC-012.
- Bash writes to `docs/spec/**` (for example `sed -i`): PROC-011 checks the edit tools only.
- Subshells and `cd` are tracked in one sequence: `(cd x); git push` is checked as if the `cd` persisted. This over-approximates, so it can only cause an extra block, never a missed one.
- The reviewer agents are read-only by `disallowedTools` (Edit, Write, MultiEdit, NotebookEdit). Bash is read-only by instruction only, because the tool list cannot restrict it (see `.claude/agents/reviewer-*.md`).
- Hooks run with the user's permissions. The guard is a guardrail for accidental violations by agents, not a security boundary against a determined actor.

## Affected requirements

PROC-012, PROC-011 (limit noted), PROC-020 (fixup pushes), PROC-002 (merge pushes), ADR-0045.
