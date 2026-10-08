import type { Logger } from '@git-migrator/adapter-sdk';
import { noopLogger } from '@git-migrator/adapter-sdk';
import { type AskpassCredential, baseGitEnv, createAskpassSession, remoteHost } from './askpass.ts';
import { GitCommandError } from './errors.ts';
import {
  type GitExecOptions,
  type GitExecResult,
  type GitProcess,
  type SpawnFunction,
  startGit,
} from './exec.ts';

/** Environment and secrets a command runs with. */
export interface GitContext {
  readonly env: Readonly<Record<string, string>>;
  readonly secrets: readonly string[];
  /** Kill the command after this long without output (remote commands only). */
  readonly inactivityMs?: number;
}

export interface RunOptions {
  readonly cwd?: string;
  readonly input?: string | Buffer;
  readonly signal?: AbortSignal;
  /** Throw `GitCommandError` on a non-zero exit (default true). */
  readonly check?: boolean;
  readonly onStdoutLine?: (line: string) => void;
  readonly pipeStdoutTo?: GitExecOptions['pipeStdoutTo'];
  readonly manualStdin?: boolean;
  readonly discardStdout?: boolean;
  readonly maxStdoutBytes?: number;
  /** Name used in errors and logs. Defaults to the git subcommand. */
  readonly operation?: string;
}

/** A remote command that prints nothing for this long is killed and retried (stalled remote). */
export const DEFAULT_STALL_TIMEOUT_MS = 10 * 60 * 1000;

function subcommand(args: readonly string[]): string {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '-c' || arg === '-C') {
      i++;
      continue;
    }
    if (!arg.startsWith('-')) {
      return arg === 'lfs' ? `lfs ${args[i + 1] ?? ''}`.trim() : arg;
    }
  }
  return 'git';
}

export interface GitRunnerOptions {
  readonly spawn?: SpawnFunction;
  /** Where askpass sessions are created (a per-Run scratch directory, JOB-015). */
  readonly scratchDir: string;
  readonly logger?: Logger;
  /** Inactivity limit of remote commands (default 10 minutes). */
  readonly stallTimeoutMs?: number;
}

/** Runs git commands: local ones with a bare environment, remote ones with an askpass session. */
export class GitRunner {
  readonly #spawn: SpawnFunction | undefined;
  readonly #scratchDir: string;
  readonly #logger: Logger;
  readonly #stallTimeoutMs: number;

  constructor(options: GitRunnerOptions) {
    this.#spawn = options.spawn;
    this.#scratchDir = options.scratchDir;
    this.#logger = options.logger ?? noopLogger;
    this.#stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
  }

  /** A context for commands that touch no remote. `home` should be private to the caller. */
  local(home: string): GitContext {
    return { env: baseGitEnv(home), secrets: [] };
  }

  /**
   * Runs `fn` with a context whose `GIT_ASKPASS` answers for `url`'s origin only. The credential
   * files are removed afterwards, also when `fn` throws.
   */
  async withCredential<T>(
    url: string,
    credential: AskpassCredential,
    fn: (context: GitContext) => Promise<T>,
    extraConfig: readonly (readonly [string, string])[] = [],
  ): Promise<T> {
    const session = await createAskpassSession({
      scratchDir: this.#scratchDir,
      host: remoteHost(url),
      credential,
      extraConfig,
    });
    try {
      return await fn({
        env: session.env,
        secrets: session.secrets,
        inactivityMs: this.#stallTimeoutMs,
      });
    } finally {
      await session.dispose();
    }
  }

  start(context: GitContext, args: readonly string[], options: RunOptions = {}): GitProcess {
    return startGit(args, {
      env: context.env,
      secrets: context.secrets,
      ...(context.inactivityMs !== undefined ? { inactivityMs: context.inactivityMs } : {}),
      ...(this.#spawn !== undefined ? { spawn: this.#spawn } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.input !== undefined ? { input: options.input } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.onStdoutLine !== undefined ? { onStdoutLine: options.onStdoutLine } : {}),
      ...(options.pipeStdoutTo !== undefined ? { pipeStdoutTo: options.pipeStdoutTo } : {}),
      ...(options.manualStdin !== undefined ? { manualStdin: options.manualStdin } : {}),
      ...(options.discardStdout !== undefined ? { discardStdout: options.discardStdout } : {}),
      ...(options.maxStdoutBytes !== undefined ? { maxStdoutBytes: options.maxStdoutBytes } : {}),
    });
  }

  async run(
    context: GitContext,
    args: readonly string[],
    options: RunOptions = {},
  ): Promise<GitExecResult> {
    const operation = options.operation ?? subcommand(args);
    const started = Date.now();
    const result = await this.start(context, args, options).result;
    this.#logger.debug({ operation, exitCode: result.code, ms: Date.now() - started }, 'git');
    if (result.cancelled) {
      throw new GitCommandError({
        operation,
        exitCode: result.code,
        stderr: 'cancelled',
        secrets: context.secrets,
        klass: { code: 'transient', reason: 'cancelled', retryable: false },
      });
    }
    if (result.stalled) {
      throw new GitCommandError({
        operation,
        exitCode: result.code,
        stderr: `stalled: no output for ${context.inactivityMs} ms`,
        secrets: context.secrets,
        klass: { code: 'transient', reason: 'network', retryable: true },
      });
    }
    if (result.code !== 0 && options.check !== false) {
      throw new GitCommandError({
        operation,
        exitCode: result.code,
        stderr: result.stderr,
        secrets: context.secrets,
      });
    }
    return result;
  }
}
