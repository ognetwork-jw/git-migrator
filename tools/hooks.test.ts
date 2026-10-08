/**
 * Tests for the Claude Code hooks in .claude/hooks (PROC-010 … PROC-014). Each hook is run as a
 * real bash process with sample hook JSON on stdin; the test asserts exit 2 (block) or 0 (allow).
 * Git and biome run for real, against temporary repositories, never against a remote.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const hooks = join(root, '.claude/hooks');
const tmpRoot = mkdtempSync(join(tmpdir(), 'gm-hooks-'));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

interface HookResult {
  code: number | null;
  stderr: string;
}

function runHook(script: string, payload: unknown, env: Record<string, string> = {}): HookResult {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const result = spawnSync('bash', [join(hooks, script)], {
    input,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { code: result.status, stderr: result.stderr };
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(
    'git',
    [
      '-c',
      'user.name=hooks-test',
      '-c',
      'user.email=hooks-test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

function commitFile(cwd: string, name: string): void {
  writeFileSync(join(cwd, name), `${name}\n`);
  git(cwd, 'add', name);
  git(cwd, 'commit', '-m', `add ${name}`);
}

const bashPayload = (command: string, cwd: string) => ({
  tool_name: 'Bash',
  tool_input: { command },
  cwd,
  hook_event_name: 'PreToolUse',
});

// Shared repositories: a task branch and a main branch, both with one commit.
const taskRepo = join(tmpRoot, 'guard', 'task');
const mainRepo = join(tmpRoot, 'guard', 'main');

beforeAll(() => {
  mkdirSync(taskRepo, { recursive: true });
  mkdirSync(mainRepo, { recursive: true });
  git(taskRepo, 'init', '-b', 'task/T-999-example');
  commitFile(taskRepo, 'a.txt');
  git(mainRepo, 'init', '-b', 'main');
  commitFile(mainRepo, 'a.txt');
});

describe('PROC-012 guard-bash: git push', () => {
  const blocked: [string, string, string][] = [
    ['git push origin main', taskRepo, 'push to main by name'],
    ['git push origin HEAD:main', taskRepo, 'push HEAD to main'],
    ['git push origin task/T-999-example:main', taskRepo, 'push a branch onto main'],
    ['git push origin HEAD:refs/heads/main', taskRepo, 'push to the full main ref'],
    ['git push origin +main', taskRepo, 'forced refspec to main'],
    ['git push origin :main', taskRepo, 'delete main'],
    ['git push origin main --force', taskRepo, 'forced push to main'],
    [`git -C ${taskRepo} push origin main`, mainRepo, 'push to main with -C'],
    ['ls && git push origin main', taskRepo, 'push to main after another command'],
    ['git push', mainRepo, 'bare push while checked out on main'],
    ['git push origin HEAD', mainRepo, 'push HEAD while checked out on main'],
    ['git push --all origin', taskRepo, 'push all branches, including main'],
    ['git push --mirror origin', taskRepo, 'mirror push, including main'],
    ['git push origin "main"', taskRepo, 'quoted main'],
    ['git push origin "*:*"', taskRepo, 'wildcard refspec that matches main'],
    ['git push --force origin ai-main', taskRepo, 'forced push to ai-main'],
    ['git push -f origin ai-main', taskRepo, 'short forced push to ai-main'],
    ['git push --force-with-lease origin ai-main', taskRepo, 'lease-forced push to ai-main'],
    ['git push -fu origin ai-main', taskRepo, 'f inside a short cluster before the remote'],
    ['git push origin ai-main -fu', taskRepo, 'short cluster after the refspec'],
    ['git push -fv origin ai-main', taskRepo, 'verbose forced push to ai-main'],
    ['git push origin :ai-main', taskRepo, 'delete ai-main with an empty source'],
    ['git push origin :refs/heads/ai-main', taskRepo, 'delete the full ai-main ref'],
    ['git push origin :+ai-main', taskRepo, 'forced empty-source refspec for ai-main'],
    ['git push origin -d ai-main', taskRepo, 'short delete of ai-main'],
    ['git push --no-verify origin task/T-999-example', taskRepo, 'push with --no-verify'],
    ['bash -c "git push origin main"', taskRepo, 'push to main inside bash -c'],
    ['sh -c "git push origin ai-main --force"', taskRepo, 'forced push to ai-main inside sh -c'],
    ['eval "git push origin main"', taskRepo, 'push to main inside eval'],
    ['echo `git push origin main`', taskRepo, 'push to main in backticks'],
    ['echo $(git push origin main)', taskRepo, 'push to main in a substitution'],
    ['echo "$(git push origin main)"', taskRepo, 'push to main in a substitution inside quotes'],
    ['git commit -m "x" && git push origin main', taskRepo, 'push to main after a commit'],
    ['git push origin +ai-main', taskRepo, 'plus refspec to ai-main'],
    ['git push origin --delete ai-main', taskRepo, 'delete ai-main'],
    ['git push -uf origin ai-main', taskRepo, 'clustered forced push to ai-main'],
  ];
  const allowed: [string, string, string][] = [
    ['git push -u origin task/T-999-example', taskRepo, 'first push of a task branch'],
    [
      'git push --force-with-lease origin task/T-999-example',
      taskRepo,
      'lease push to a task branch',
    ],
    ['git push origin HEAD:ai-main', taskRepo, 'fast-forward push to ai-main'],
    ['git push origin HEAD', taskRepo, 'push HEAD of a task branch'],
    ['git status && git push origin HEAD', taskRepo, 'push after a read-only command'],
    ['git push --force origin task/T-999-example', taskRepo, 'forced push to a task branch'],
    ['git pull origin main', mainRepo, 'pull is not a push'],
    ['git push origin HEAD >/dev/null 2>&1', taskRepo, 'push with redirections'],
    [
      'gh pr create --title "T-003" --body "git push origin main; rm -rf /"',
      taskRepo,
      'PR body text',
    ],
    ['git commit -m "x; git push origin main"', taskRepo, 'separators inside a commit message'],
    [
      'git commit -m "a" -m "b && git push --force origin ai-main"',
      taskRepo,
      'second -m with a push inside',
    ],
    [
      'git commit -m "$(cat <<\'EOF\'\nfix: git push origin main and --no-verify\nEOF\n)"',
      taskRepo,
      'heredoc message inside a substitution',
    ],
    [
      'cat <<EOF > notes.md\ngit push origin main\nEOF\ngit status',
      taskRepo,
      'heredoc body is not a command',
    ],
    ['echo "a\nb" && git status', taskRepo, 'a newline inside quotes'],
  ];

  it.each(blocked)('[PROC-012] blocks %s (%s)', (command, cwd) => {
    const result = runHook('guard-bash.sh', bashPayload(command, cwd));
    expect(result.code, command).toBe(2);
    expect(result.stderr).toContain('PROC-012');
  });

  it.each(allowed)('[PROC-012] allows %s (%s)', (command, cwd) => {
    expect(runHook('guard-bash.sh', bashPayload(command, cwd)).code, command).toBe(0);
  });
});

describe('PROC-012 guard-bash: git commit', () => {
  it.each([
    ['git commit --no-verify -m "x"'],
    ['git commit -nm "x"'],
    ['git commit -an -m "x"'],
    ['git commit -m "x" --no-verify'],
    ['git -c core.hooksPath=/dev/null commit -m "x"'],
    ['git commit --no-verif -m "x"'],
    ['git commit --no-ver -m "x"'],
    ['git commit "--no-verify" -m "x"'],
    ['git commit -m "$(git status)" --no-verify'],
    ['git commit -m "x"; git commit --no-verify -m "y"'],
  ])('[PROC-012] blocks %s', (command) => {
    expect(runHook('guard-bash.sh', bashPayload(command, taskRepo)).code).toBe(2);
  });

  it.each([
    ['git commit -m "docs: never use --no-verify"'],
    ['git commit -m "Don\'t skip hooks with --no-verify"'],
    ['git commit --amend --no-edit'],
    ['git commit -m "x" -- a.txt'],
    ['git commit -m "x" -- --no-verify'],
    ['git commit -m "x; git push origin main"'],
    ['git commit -m "a" -m "b && git push origin main"'],
    ['git commit -m "x\n\ngit push origin main\n--no-verify"'],
    ["git commit -F - <<'EOF'\nfix: git push origin main\n--no-verify\nEOF"],
    ['git commit -m "$(cat <<\'EOF\'\nfix: git push origin main and --no-verify\nEOF\n)"'],
    ['git commit -m "$(cat <<EOF\ndone\nEOF\n)" && git status'],
  ])('[PROC-012] allows %s', (command) => {
    expect(runHook('guard-bash.sh', bashPayload(command, taskRepo)).code).toBe(0);
  });
});

describe('PROC-012 guard-bash: rm -r', () => {
  const outside = '/srv/gm-hooks-test';
  it.each([
    [`rm -rf ${outside}`],
    ['rm -rf /'],
    ['rm -rf ~'],
    ['rm -rf node_modules'],
    ['rm -fr ../other'],
    ['rm -r .worktrees/../keep'],
    ['rm --recursive --force .'],
    ['rm -rf "/"'],
    ['rm -rf $HOME/x'],
    ['rm -rf /tmp/gm-other'],
    ['rm -rf /tmp'],
    ['echo done && rm -rf /'],
    ['rm -rf .worktrees'],
    ['bash -c "rm -rf /srv/data"'],
    ['rm -rf -- /srv/data'],
    ['rm -rf x 2>/dev/null; rm -r /srv/data'],
    ['rm -rf $(echo /srv/data)'],
  ])('[PROC-012] blocks %s outside .worktrees/ and scratch dirs', (command) => {
    const result = runHook('guard-bash.sh', bashPayload(command, taskRepo));
    expect(result.code, command).toBe(2);
    expect(result.stderr).toContain('PROC-012');
  });

  it.each([
    ['rm -rf .worktrees/T-003/dist'],
    ['rm -rf ./.worktrees/T-004/node_modules'],
    ['rm -rf /tmp/claude-0/scratch'],
    ['rm -rf /private/tmp/claude-0/scratch'],
    ['rm -rf /tmp/claude-0/-home-user-git-migrator/session/scratchpad/out'],
    ['rm -f file.txt'],
    ['rm file.txt'],
    ['rm -rf'],
  ])('[PROC-012] allows %s inside .worktrees/ or scratch dirs, or non-recursive', (command) => {
    expect(runHook('guard-bash.sh', bashPayload(command, taskRepo)).code, command).toBe(0);
  });

  it('[PROC-012] allows rm -rf inside a worktree when the session runs in that worktree', () => {
    const worktree = join(taskRepo, '.worktrees', 'T-999');
    expect(runHook('guard-bash.sh', bashPayload('rm -rf node_modules', worktree)).code).toBe(0);
  });
});

describe('PROC-012 guard-bash: other input', () => {
  it('[PROC-012] allows non-Bash tools and commands without git or rm', () => {
    expect(
      runHook('guard-bash.sh', { tool_name: 'Read', tool_input: { file_path: 'x' }, cwd: taskRepo })
        .code,
    ).toBe(0);
    expect(runHook('guard-bash.sh', bashPayload('pnpm test', taskRepo)).code).toBe(0);
  });

  it('[PROC-012] fails closed when stdin is not JSON', () => {
    const result = runHook('guard-bash.sh', 'not json');
    expect(result.code).toBe(2);
  });
});

describe('PROC-011 block-spec-edits', () => {
  const edit = (file_path: string, cwd = taskRepo) => ({
    tool_name: 'Edit',
    tool_input: { file_path },
    cwd,
    hook_event_name: 'PreToolUse',
  });

  it.each([
    ['/home/user/git-migrator/.worktrees/T-003/docs/spec/01-glossary.md'],
    ['/home/user/git-migrator/.worktrees/T-003/docs/spec/15-work-breakdown.md'],
  ])('[PROC-011] blocks an edit to %s inside a worktree', (file_path) => {
    const result = runHook('block-spec-edits.sh', edit(file_path));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('PROC-011');
  });

  it('[PROC-011] blocks a relative spec path when the cwd is a worktree', () => {
    const worktree = join(taskRepo, '.worktrees', 'T-999');
    expect(runHook('block-spec-edits.sh', edit('docs/spec/00-overview.md', worktree)).code).toBe(2);
  });

  it.each([
    ['/home/user/git-migrator/docs/spec/01-glossary.md'],
    ['/home/user/git-migrator/.worktrees/T-003/docs/process/workflow.md'],
    ['/home/user/git-migrator/.worktrees/T-003/docs/adr/0046-x.md'],
    ['/home/user/git-migrator/.worktrees/T-003/docs/spec-notes.md'],
  ])('[PROC-011] allows an edit to %s', (file_path) => {
    expect(runHook('block-spec-edits.sh', edit(file_path)).code).toBe(0);
  });

  it('[PROC-011] allows a MultiEdit outside the worktree specs', () => {
    const payload = {
      tool_name: 'MultiEdit',
      tool_input: { file_path: '/home/user/git-migrator/docs/spec/00-overview.md' },
      cwd: taskRepo,
    };
    expect(runHook('block-spec-edits.sh', payload).code).toBe(0);
  });
});

describe('PROC-010 post-edit-biome', () => {
  // A temporary project with the repository's biome.json and biome binary.
  const project = join(tmpRoot, 'biome-project');
  beforeAll(() => {
    mkdirSync(project, { recursive: true });
    git(project, 'init', '-b', 'main');
    writeFileSync(join(project, '.gitignore'), 'node_modules/\n');
    copyFileSync(join(root, 'biome.json'), join(project, 'biome.json'));
    symlinkSync(join(root, 'node_modules'), join(project, 'node_modules'), 'dir');
  });

  const post = (file_path: string) => ({
    tool_name: 'Write',
    tool_input: { file_path },
    cwd: project,
    hook_event_name: 'PostToolUse',
  });
  const env = { CLAUDE_PROJECT_DIR: project };

  it('[PROC-010] formats a supported file in place and allows it', () => {
    const file = join(project, 'formatted.ts');
    writeFileSync(file, 'const a   =  1\n');
    expect(runHook('post-edit-biome.sh', post(file), env).code).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe('const a = 1;\n');
  });

  it('[PROC-010] blocks with exit 2 when biome reports an error it cannot fix', () => {
    const file = join(project, 'unfixable.ts');
    writeFileSync(file, 'eval("1");\n');
    const result = runHook('post-edit-biome.sh', post(file), env);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('PROC-010');
  });

  it.each([['notes.md'], ['image.png']])('[PROC-010] ignores unsupported type %s', (name) => {
    const file = join(project, name);
    writeFileSync(file, '# not checked\n');
    expect(runHook('post-edit-biome.sh', post(file), env).code).toBe(0);
  });

  it('[PROC-010] ignores a file that does not exist', () => {
    expect(runHook('post-edit-biome.sh', post(join(project, 'missing.ts')), env).code).toBe(0);
  });
});

describe('PROC-013 subagent-stop-check', () => {
  // A repository with origin/ai-main and two worktrees: one with a commit beyond it, one without.
  const base = join(tmpRoot, 'subagent');
  const origin = join(base, 'origin.git');
  const repo = join(base, 'repo');
  const ahead = join(repo, '.worktrees', 'T-901');
  const level = join(repo, '.worktrees', 'T-902');
  const failing = { GM_HOOK_PROC013_CMD: 'echo "tsc: error TS1" && exit 1' };
  const passing = { GM_HOOK_PROC013_CMD: 'echo ok' };

  beforeAll(() => {
    mkdirSync(base, { recursive: true });
    git(base, 'init', '--bare', origin);
    mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-b', 'ai-main');
    commitFile(repo, 'base.txt');
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'push', 'origin', 'ai-main');
    git(repo, 'worktree', 'add', '-b', 'task/T-901-x', ahead);
    git(repo, 'worktree', 'add', '-b', 'task/T-902-x', level);
    commitFile(ahead, 'feature.txt');
  });

  const stop = (cwd: string) => ({ cwd, hook_event_name: 'SubagentStop', stop_hook_active: false });

  it('[PROC-013] blocks with the failing output tail when a worktree is ahead of origin/ai-main', () => {
    const result = runHook('subagent-stop-check.sh', stop(ahead), failing);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('tsc: error TS1');
  });

  it('[PROC-013] allows a worktree ahead of origin/ai-main when the check passes', () => {
    expect(runHook('subagent-stop-check.sh', stop(ahead), passing).code).toBe(0);
  });

  it('[PROC-013] allows a worktree with no commits beyond origin/ai-main without running the check', () => {
    expect(runHook('subagent-stop-check.sh', stop(level), failing).code).toBe(0);
  });

  it('[PROC-013] ignores a subagent whose cwd is not inside .worktrees/T-*', () => {
    expect(runHook('subagent-stop-check.sh', stop(repo), failing).code).toBe(0);
  });

  it('[PROC-013] skips reviewer agents when the payload names one (ADR-0048)', () => {
    expect(
      runHook('subagent-stop-check.sh', { ...stop(ahead), agent_type: 'reviewer-spec' }, failing)
        .code,
    ).toBe(0);
  });

  it('[PROC-013] allows the stop with a warning when stop_hook_active is set (ADR-0048)', () => {
    const result = runHook(
      'subagent-stop-check.sh',
      { ...stop(ahead), stop_hook_active: true },
      failing,
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('tsc: error TS1');
  });

  it('[PROC-013] blocks when origin/ai-main cannot be resolved', () => {
    const orphan = join(base, 'orphan');
    mkdirSync(orphan, { recursive: true });
    git(orphan, 'init', '-b', 'task/T-903-x');
    commitFile(orphan, 'o.txt');
    const dir = join(orphan, '.worktrees', 'T-903');
    mkdirSync(dir, { recursive: true });
    expect(runHook('subagent-stop-check.sh', stop(dir), passing).code).toBe(2);
  });
});

describe('PROC-014 stop-dod', () => {
  const failing = { GM_HOOK_PROC014_CMD: 'echo "lint failed" && exit 1' };
  const passing = { GM_HOOK_PROC014_CMD: 'echo ok' };
  const table = (statuses: string[]) =>
    [
      '# Progress',
      '',
      '| Task | Status | Branch |',
      '|---|---|---|',
      ...statuses.map((s, i) => `| T-${String(i + 1).padStart(3, '0')} | ${s} | b |`),
      '',
    ].join('\n');

  const makeRepo = (name: string, statuses: string[] | undefined): string => {
    const dir = join(tmpRoot, 'stop', name);
    mkdirSync(join(dir, 'docs', 'process'), { recursive: true });
    git(dir, 'init', '-b', 'ai-main');
    commitFile(dir, 'base.txt');
    if (statuses) writeFileSync(join(dir, 'docs', 'process', 'progress.md'), table(statuses));
    return dir;
  };

  const stop = (cwd: string) => ({ cwd, hook_event_name: 'Stop', stop_hook_active: false });

  it('[PROC-014] blocks with the failing output when every task is merged', () => {
    const dir = makeRepo('all-merged', ['merged', 'merged']);
    const result = runHook('stop-dod.sh', stop(dir), failing);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('lint failed');
  });

  it('[PROC-014] allows the stop when every task is merged and the Definition of Done passes', () => {
    const dir = makeRepo('all-merged-pass', ['merged', 'merged']);
    expect(runHook('stop-dod.sh', stop(dir), passing).code).toBe(0);
  });

  it('[PROC-014] allows the stop without running the Definition of Done while a task is open', () => {
    const dir = makeRepo('one-open', ['merged', 'in_review']);
    expect(runHook('stop-dod.sh', stop(dir), failing).code).toBe(0);
  });

  it('[PROC-014] counts a split task as done', () => {
    const dir = makeRepo('split', ['merged', 'split']);
    expect(runHook('stop-dod.sh', stop(dir), failing).code).toBe(2);
  });

  it('[PROC-014] allows the stop with a warning when stop_hook_active is set (ADR-0048)', () => {
    const dir = makeRepo('active', ['merged']);
    const result = runHook('stop-dod.sh', { ...stop(dir), stop_hook_active: true }, failing);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('lint failed');
    expect(result.stderr).toContain('Stop hook already continued');
  });

  it('[PROC-014] skips the Definition of Done after a green run while nothing changed (ADR-0048)', () => {
    const dir = makeRepo('cache', ['merged']);
    const marker = join(dir, 'ran.marker');
    const probe = `touch ${marker} && exit 1`;
    expect(runHook('stop-dod.sh', stop(dir), passing).code).toBe(0);
    expect(runHook('stop-dod.sh', stop(dir), { GM_HOOK_PROC014_CMD: probe }).code).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  it('[PROC-014] re-runs the Definition of Done after an untracked file changes (ADR-0048)', () => {
    const dir = makeRepo('cache-untracked', ['merged']);
    writeFileSync(join(dir, 'scratch.txt'), 'one\n');
    expect(runHook('stop-dod.sh', stop(dir), passing).code).toBe(0);
    expect(runHook('stop-dod.sh', stop(dir), failing).code).toBe(0);
    writeFileSync(join(dir, 'scratch.txt'), 'two\n');
    expect(runHook('stop-dod.sh', stop(dir), failing).code).toBe(2);
  });

  it('[PROC-014] runs the Definition of Done again once the state changed (ADR-0048)', () => {
    const dir = makeRepo('cache-changed', ['merged']);
    expect(runHook('stop-dod.sh', stop(dir), passing).code).toBe(0);
    commitFile(dir, 'changed.txt');
    expect(runHook('stop-dod.sh', stop(dir), failing).code).toBe(2);
  });

  it('[PROC-014] allows the stop when progress.md has no task rows', () => {
    const dir = makeRepo('no-rows', []);
    expect(runHook('stop-dod.sh', stop(dir), failing).code).toBe(0);
  });

  it('[PROC-014] only runs in the main checkout, not in a task worktree', () => {
    const dir = makeRepo('worktree-host', ['merged']);
    const worktree = join(tmpRoot, 'stop', 'worktree-host-wt');
    git(dir, 'worktree', 'add', '-b', 'task/T-950-x', worktree);
    expect(statSync(join(worktree, '.git')).isFile()).toBe(true);
    expect(runHook('stop-dod.sh', stop(worktree), failing).code).toBe(0);
  });
});

describe('PROC-010 … PROC-014 settings wiring', () => {
  const settings = JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8')) as {
    hooks: Record<string, { matcher?: string; hooks: { command: string; timeout?: number }[] }[]>;
  };
  const wired = (event: string, script: string, matcher?: string) =>
    (settings.hooks[event] ?? []).some(
      (entry) =>
        (matcher === undefined || entry.matcher === matcher) &&
        entry.hooks.some((h) => h.command.endsWith(`/.claude/hooks/${script}`)),
    );

  it('[PROC-010] runs biome after Edit|Write|MultiEdit', () => {
    expect(wired('PostToolUse', 'post-edit-biome.sh', 'Edit|Write|MultiEdit')).toBe(true);
  });

  it('[PROC-011] guards Edit|Write|MultiEdit before they run', () => {
    expect(wired('PreToolUse', 'block-spec-edits.sh', 'Edit|Write|MultiEdit')).toBe(true);
  });

  it('[PROC-012] guards Bash before it runs', () => {
    expect(wired('PreToolUse', 'guard-bash.sh', 'Bash')).toBe(true);
  });

  it('[PROC-013] runs on SubagentStop', () => {
    expect(wired('SubagentStop', 'subagent-stop-check.sh')).toBe(true);
  });

  it('[PROC-014] runs on Stop', () => {
    expect(wired('Stop', 'stop-dod.sh')).toBe(true);
  });

  it('[PROC-013] SubagentStop and [PROC-014] Stop declare explicit timeouts (ADR-0048)', () => {
    const timeout = (event: string) => settings.hooks[event]?.[0]?.hooks[0]?.timeout;
    expect(timeout('SubagentStop')).toBe(900);
    expect(timeout('Stop')).toBe(1800);
  });

  it('[PROC-010] every hook script referenced by settings.json exists and is executable', () => {
    const scripts = Object.values(settings.hooks)
      .flat()
      .flatMap((entry) => entry.hooks.map((h) => h.command.split('/').pop() as string));
    for (const script of scripts) {
      expect(statSync(join(hooks, script)).mode & 0o111, script).not.toBe(0);
    }
  });
});

describe('PROC-012 guard-bash: fail-closed policy (ADR-0047)', () => {
  const complex = (command: string, cwd = taskRepo) => {
    const result = runHook('guard-bash.sh', bashPayload(command, cwd));
    expect(result.code, command).toBe(2);
    expect(result.stderr, command).toMatch(/PROC-012/);
    return result;
  };

  it.each([
    ['git --git-dir .git push origin main'],
    ['git --work-tree . push origin main'],
    ['git --git-dir=.git push origin main'],
    ['git --git-dir .git commit --no-verify -m "x"'],
    ['git --namespace ns push origin main'],
    ['git --namespace ns push origin ai-main --force'],
    ['git -c alias.p=push p origin main'],
    ['git -c core.hooksPath=/dev/null commit -m "x"'],
    ['git --config-env=core.hooksPath=HOOKS commit -m "x"'],
  ])(
    '[PROC-012] blocks git global options that change the subcommand or the repository: %s',
    (command) => {
      const result = runHook('guard-bash.sh', bashPayload(command, taskRepo));
      expect(result.code, command).toBe(2);
    },
  );

  it.each([
    ['/usr/bin/git push origin main'],
    ['/bin/rm -rf /srv/data'],
    ['env -i git push origin main'],
    ['env -u HOME git push origin main'],
    ['env /usr/bin/git push origin main'],
    ['sudo -u x git push origin main'],
    ['time -p git push origin main'],
    ['nice -n 5 git push origin main'],
    ['timeout 10 git push origin main'],
    ['stdbuf -oL git push origin main'],
    ['command git push origin main'],
    ['exec git push origin main'],
    ['xargs git push origin main'],
    ['GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m "x"'],
    ['env GIT_DIR=.git git push origin main'],
    ['find . -exec git push origin main ;'],
    ['bash script.sh'],
  ])('[PROC-012] blocks %s through wrappers, paths and unanalysable launchers', (command) => {
    const result = runHook('guard-bash.sh', bashPayload(command, taskRepo));
    expect(result.code, command).toBe(2);
  });

  it.each([
    ["git push origin $'main'"],
    ["git commit $'--no-verify' -m x"],
    ["echo $'a\\'b'; git push origin main"],
  ])('[PROC-012] fails closed on ANSI-C quoting: %s', (command) => {
    complex(command);
  });

  it.each([
    ['cat <(git push origin main)'],
    ['diff <(echo a) <(echo b)'],
    ['tee >(git push origin main)'],
  ])('[PROC-012] fails closed on process substitution: %s', (command) => {
    complex(command);
  });

  it.each([
    ['cat <<EOF\n$(git push origin main)\nEOF'],
    ['cat <<EOF\n`git push origin main`\nEOF'],
  ])('[PROC-012] fails closed on an unquoted heredoc body that substitutes: %s', (command) => {
    complex(command);
  });

  it.each([['case x in x) git push origin main;; esac'], ['echo "$(case x in x) echo y;; esac)"']])(
    '[PROC-012] fails closed on case statements: %s',
    (command) => {
      complex(command);
    },
  );

  it.each([
    ['echo "abc'],
    ['echo $(git status'],
    ['cat <<EOF\nabc'],
    ['git commit -m "x'],
    ['echo `git status'],
  ])('[PROC-012] fails closed on unterminated input: %s', (command) => {
    complex(command);
  });

  it('[PROC-012] blocks a command over 64 KiB quickly, without parsing it', () => {
    const started = Date.now();
    const result = runHook('guard-bash.sh', bashPayload(`echo ${'a'.repeat(1_000_000)}`, taskRepo));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('too complex');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it.each([
    ["echo 'a $(git push origin main) b'"],
    ["echo \"it's $'x' here\""],
    ["cat <<'EOF'\n$(git push origin main)\n`git push origin main`\nEOF"],
    ['git status 2>&1 | head -5'],
  ])('[PROC-012] allows inert quoting and quoted-delimiter heredocs: %s', (command) => {
    expect(runHook('guard-bash.sh', bashPayload(command, taskRepo)).code, command).toBe(0);
  });

  it.each([
    ['git push --force-with-lease origin task/T-999-example'],
    ['git push origin HEAD:ai-main'],
    ['git push -u origin HEAD'],
    [
      'git commit -m "$(cat <<\'EOF\'\nfeat(core): add guard\n\nCo-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_example\nEOF\n)"',
    ],
    ['git worktree remove .worktrees/T-004'],
    ['rm -rf .worktrees/T-003/dist'],
    ['rm -rf /tmp/claude-0/scratch'],
    ['cd .worktrees/T-999 && git status'],
    ['gh pr create --title "T-003" --body "git push origin main; rm -rf /"'],
  ])('[PROC-012] keeps the daily command shape allowed: %s', (command) => {
    expect(runHook('guard-bash.sh', bashPayload(command, taskRepo)).code, command).toBe(0);
  });

  it('[PROC-012] tracks cd: a bare push after cd into the main checkout is still refused', () => {
    complex(`cd ${mainRepo} && git push`, taskRepo);
  });

  it('[PROC-012] refuses a cd whose target cannot be known', () => {
    complex('cd "$HOME" && git push origin ai-main --force', taskRepo);
  });
});

describe('PROC-012 guard-bash: narrowed GIT_* rule and dynamic words (ADR-0047)', () => {
  it.each([
    ['GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash origin/ai-main'],
    ['GIT_EDITOR=true git rebase --continue'],
    ['GIT_AUTHOR_DATE=2026-01-01T00:00:00Z git commit -m "x"'],
    ['GIT_COMMITTER_NAME=ci GIT_TERMINAL_PROMPT=0 git fetch origin'],
    ['env GIT_EDITOR=true git rebase --continue'],
    ['GIT_TRACE=1 git push --force-with-lease origin task/T-999-example'],
  ])('[PROC-012] allows harmless GIT_* variables in the fix-pass commands: %s', (command) => {
    expect(runHook('guard-bash.sh', bashPayload(command, taskRepo)).code, command).toBe(0);
  });

  it.each([
    ['GIT_DIR=/tmp/other git push origin main'],
    ['GIT_WORK_TREE=. git commit --no-verify -m "x"'],
    [
      'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m "x"',
    ],
    ['GIT_CONFIG_PARAMETERS="core.hooksPath=/dev/null" git commit -m "x"'],
    ['GIT_CONFIG_GLOBAL=/tmp/g git status'],
    ['GIT_CONFIG=/tmp/c git push origin task/T-999-example'],
    ['GIT_EXEC_PATH=/tmp/x git status'],
    ['GIT_SSH_COMMAND="evil" git push origin task/T-999-example'],
    ['GIT_SSH=/tmp/x git fetch origin'],
    ['GIT_PROXY_COMMAND=/tmp/x git fetch origin'],
    ['GIT_TEMPLATE_DIR=/tmp/t git init'],
    ['GIT_NAMESPACE=ns git status'],
    ['GIT_ALTERNATE_OBJECT_DIRECTORIES=/x git status'],
    ['GIT_OBJECT_DIRECTORY=/x git status'],
    ['env GIT_DIR=.git git push origin main'],
    ['env GIT_CONFIG_COUNT=1 git status'],
  ])(
    '[PROC-012] blocks GIT_* variables that change repository, config, hooks or transport: %s',
    (command) => {
      expect(runHook('guard-bash.sh', bashPayload(command, taskRepo)).code, command).toBe(2);
    },
  );

  it.each([
    ['git push origin $BR'],
    ['git push origin "$BR"'],
    ['git push origin ${BR}'],
    ['git push $REMOTE $BRANCH'],
    ['git commit $FLAGS -m x'],
    ['git $SUB origin main'],
    ['$GIT push origin main'],
    ['g=git; $g push origin main'],
    ['${G} push origin main'],
    ['git push origin {main,x}'],
    ['git push origin feat/*'],
    ['g*t push origin main'],
    ['git pu? origin main'],
    ['git -C $DIR push origin main'],
    ['git merge $BR'],
    ['git rebase $UPSTREAM'],
    ['git cherry-pick $SHA'],
    ['git am $PATCH'],
    ['env $X git push origin main'],
  ])('[PROC-012] fails closed on a word the shell expands: %s', (command) => {
    const result = runHook('guard-bash.sh', bashPayload(command, taskRepo));
    expect(result.code, command).toBe(2);
    expect(result.stderr).toContain('PROC-012');
  });

  it.each([
    ['git commit -m "$(git rev-parse HEAD)"'],
    ['git commit -m "$VAR"'],
    ['git commit -F "$MSG_FILE" -m x'],
  ])('[PROC-012] leaves expansions in the message value of commit alone: %s', (command) => {
    // A message value is skipped, so only the command shape is checked. The substitution body is
    // still scanned as a command, and it runs no git command here.
    expect(runHook('guard-bash.sh', bashPayload(command, taskRepo)).code, command).toBe(0);
  });

  it.each([
    ['git push --repo origin main'],
    ['git push --repo=origin main'],
    ['git push --repo origin'],
  ])('[PROC-012] fails closed on git push --repo: %s', (command) => {
    expect(runHook('guard-bash.sh', bashPayload(command, taskRepo)).code).toBe(2);
  });
});

describe('PROC-012 guard-bash: round 4 and 5 fixes (ADR-0047)', () => {
  const worktreeCwd = join(taskRepo, '.worktrees', 'T-999');
  const claudeScratchCwd = '/tmp/claude-0/hookcwd';
  const substitutedRm = [
    'rm -rf $(echo /etc)',
    'rm -rf "$(echo /etc)"',
    'rm -rf `echo /etc`',
    'rm -rf $(find /home -name node_modules)',
    'rm -rf "$(dirname $PWD)"',
    'rm -rf .worktrees/T-003 "$(echo /etc)"',
  ];
  for (const cwd of [taskRepo, worktreeCwd, claudeScratchCwd]) {
    it.each(substitutedRm)(
      `[PROC-012] blocks rm -r of a substituted target (cwd ${cwd}): %s`,
      (command) => {
        const result = runHook('guard-bash.sh', bashPayload(command, cwd));
        expect(result.code, command).toBe(2);
        expect(result.stderr).toContain('PROC-012');
      },
    );
  }

  it('[PROC-012] refuses 2000 substitutions quickly instead of timing out', () => {
    const started = Date.now();
    const result = runHook(
      'guard-bash.sh',
      bashPayload('echo ' + '$(true)'.repeat(2000), taskRepo),
    );
    expect(result.code).toBe(2);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('[PROC-012] refuses 600 command separators quickly', () => {
    const started = Date.now();
    const result = runHook('guard-bash.sh', bashPayload('true;'.repeat(600), taskRepo));
    expect(result.code).toBe(2);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it.each([
    ['git commit -m"fix: run n times"'],
    ['git commit -am"feat: n"'],
    ['git commit -m"x" --amend'],
  ])(
    '[PROC-012] reads a short option value attached to a clustered -m, not as -n: %s',
    (command) => {
      expect(runHook('guard-bash.sh', bashPayload(command, taskRepo)).code, command).toBe(0);
    },
  );

  it.each([
    ['git commit -mfoo --no-verify'],
    ['git commit -am"n" --no-verify'],
    ['git commit -nam "x"'],
  ])('[PROC-012] still blocks --no-verify and -n around attached values: %s', (command) => {
    expect(runHook('guard-bash.sh', bashPayload(command, taskRepo)).code, command).toBe(2);
  });

  it.each([['git rebase @{u}'], ['git merge @{u}'], ['git cherry-pick HEAD@{1}']])(
    '[PROC-012] allows reflog and upstream syntax: %s',
    (command) => {
      expect(runHook('guard-bash.sh', bashPayload(command, taskRepo)).code, command).toBe(0);
    },
  );

  it.each([
    ['2>&1 git push origin main'],
    ['1>&2 git push origin main'],
    ['>&2 git push origin ai-main --force'],
  ])('[PROC-012] reads a leading redirection before the command: %s', (command) => {
    expect(runHook('guard-bash.sh', bashPayload(command, taskRepo)).code, command).toBe(2);
  });

  it.each([['2>&1 git status'], ['>&2 echo hi && git status'], ['git status 2>&-']])(
    '[PROC-012] allows redirections that do not hide a command: %s',
    (command) => {
      expect(runHook('guard-bash.sh', bashPayload(command, taskRepo)).code, command).toBe(0);
    },
  );

  it.each([
    ['setsid git push origin main'],
    ['ionice -c3 git push origin main'],
    ['flock /tmp/lock git push origin main'],
    ['chrt -f 10 git push origin main'],
    ['taskset -c 0 git push origin main'],
    ['watch -n1 git push origin main'],
    ['script -c "git push origin main" /dev/null'],
  ])(
    '[PROC-012] unwraps setsid, ionice, flock, chrt and taskset, and refuses watch and script: %s',
    (command) => {
      expect(runHook('guard-bash.sh', bashPayload(command, taskRepo)).code, command).toBe(2);
    },
  );

  it.each([['ionice -c3 git status'], ['setsid git status']])(
    '[PROC-012] allows a harmless wrapped command: %s',
    (command) => {
      expect(runHook('guard-bash.sh', bashPayload(command, taskRepo)).code, command).toBe(0);
    },
  );

  it.each([
    ['git push --forc origin ai-main'],
    ['git push --force-w origin ai-main'],
    ['git push --del origin ai-main'],
    ['git push --mir origin task/T-999-example'],
  ])('[PROC-012] matches an unambiguous long-option prefix: %s', (command) => {
    expect(runHook('guard-bash.sh', bashPayload(command, taskRepo)).code, command).toBe(2);
  });

  it.each([
    ['git push --forc origin task/T-999-example'],
    ['git push --atomic origin task/T-999-example'],
  ])('[PROC-012] allows a prefix of a long option that is not one of ours: %s', (command) => {
    expect(runHook('guard-bash.sh', bashPayload(command, taskRepo)).code, command).toBe(0);
  });

  it.each([['git push origin heads/main'], ['git push origin HEAD:heads/main']])(
    '[PROC-012] treats heads/main as main: %s',
    (command) => {
      expect(runHook('guard-bash.sh', bashPayload(command, taskRepo)).code, command).toBe(2);
    },
  );
});
