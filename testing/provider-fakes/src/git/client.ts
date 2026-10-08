import { spawn } from 'node:child_process';

export interface GitRunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: Buffer | string;
  /** Throw when the exit code is not 0 (default true). */
  check?: boolean;
}

export interface GitRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Environment for git CLI calls in tests and seeding. Isolated from the user's and the system's git
 * config, never prompts. Credentials are passed through the environment, never argv (see
 * {@link basicAuthEnv}).
 */
export function isolatedGitEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Fake Author',
    GIT_AUTHOR_EMAIL: 'author@example.invalid',
    GIT_COMMITTER_NAME: 'Fake Committer',
    GIT_COMMITTER_EMAIL: 'committer@example.invalid',
    ...extra,
  };
}

/**
 * `GIT_CONFIG_*` environment variables that make git (and git-lfs) send a Basic Authorization header
 * on every request. The credential lives only in the child's environment, not in argv or in a
 * config file.
 */
export function basicAuthEnv(username: string, password: string): NodeJS.ProcessEnv {
  const value = Buffer.from(`${username}:${password}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${value}`,
  };
}

export function runGit(args: string[], options: GitRunOptions = {}): Promise<GitRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.stdin.on('error', () => {});
    child.once('error', reject);
    child.once('close', (code) => {
      const result = {
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      };
      if (options.check !== false && code !== 0) {
        reject(new Error(`git ${args[0]} failed (${code}): ${result.stderr.trim()}`));
      } else resolve(result);
    });
    child.stdin.end(options.input);
  });
}
