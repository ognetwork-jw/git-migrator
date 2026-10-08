/**
 * Process execution for the `git` and `git-lfs` CLIs. Every command runs with an explicit
 * environment, never through a shell. Credentials reach the child only through `GIT_ASKPASS`
 * (see askpass.ts); this module refuses to start a command whose argv carries a declared secret
 * (ADP-071) and scrubs stderr before anything is stored in an error.
 */
import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import type { Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

/** `child_process.spawn`, injectable so tests can record every argv and environment. */
export type SpawnFunction = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export const defaultSpawn: SpawnFunction = (command, args, options) =>
  nodeSpawn(command, args, options);

export interface GitExecOptions {
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string>>;
  readonly input?: string | Buffer;
  readonly signal?: AbortSignal;
  /** Values that must never appear in argv, and are removed from error text. */
  readonly secrets?: readonly string[];
  /** Called per stdout line. When set, stdout is not buffered. */
  readonly onStdoutLine?: (line: string) => void;
  /** Stream stdout into this writable (and do not buffer it). */
  readonly pipeStdoutTo?: Writable;
  /** Leave stdin open (the caller pipes into it). */
  readonly manualStdin?: boolean;
  /** Count stdout bytes without buffering. */
  readonly discardStdout?: boolean;
  /** Buffered stdout is capped at this many bytes (default 64 MiB); the command fails beyond it. */
  readonly maxStdoutBytes?: number;
  readonly spawn?: SpawnFunction;
  /**
   * Kill the process group when neither stdout nor stderr made progress for this long. The result
   * then has `stalled: true`. Off by default; remote commands turn it on.
   */
  readonly inactivityMs?: number;
}

export interface GitExecResult {
  readonly code: number;
  readonly stdout: string;
  /** Tail of stderr (at most 64 KiB). Not scrubbed: callers scrub it before storing it. */
  readonly stderr: string;
  readonly stdoutBytes: number;
  /** The inactivity watchdog killed the process. */
  readonly stalled: boolean;
  /** The caller's abort signal killed the process. */
  readonly cancelled: boolean;
}

export interface GitProcess {
  readonly child: ChildProcess;
  readonly result: Promise<GitExecResult>;
}

const DEFAULT_MAX_STDOUT = 64 * 1024 * 1024;
const MAX_STDERR = 64 * 1024;

export class GitSecretInArgvError extends Error {
  constructor() {
    super('Refusing to run git: a credential value is present in the command line (ADP-071)');
    this.name = 'GitSecretInArgvError';
  }
}

export class GitOutputLimitError extends Error {
  constructor(limit: number) {
    super(`git output exceeded ${limit} bytes`);
    this.name = 'GitOutputLimitError';
  }
}

/** Starts `git <args>`. The promise resolves with the exit code; it rejects only on spawn errors. */
export function startGit(args: readonly string[], options: GitExecOptions): GitProcess {
  for (const secret of options.secrets ?? []) {
    if (secret.length > 0 && args.some((arg) => arg.includes(secret))) {
      throw new GitSecretInArgvError();
    }
  }
  const spawnFn = options.spawn ?? defaultSpawn;
  const child = spawnFn('git', args, {
    cwd: options.cwd,
    env: { ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    // Own process group, so a stall or an abort can kill git-remote-http, send-pack and
    // pack-objects with it.
    detached: options.inactivityMs !== undefined || options.signal !== undefined,
  });
  const maxStdout = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT;
  const result = new Promise<GitExecResult>((resolve, reject) => {
    const out: Buffer[] = [];
    let stdoutBytes = 0;
    let pending = '';
    let stderr = '';
    // Multi-byte characters (ref names, paths) can span chunks: decode statefully.
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let cancelled = false;
    let overflow = false;
    let stalled = false;
    let timer: NodeJS.Timeout | undefined;
    const killGroup = (): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const touch = (): void => {
      if (options.inactivityMs === undefined) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = true;
        killGroup();
      }, options.inactivityMs);
    };
    touch();
    const onAbort = (): void => {
      cancelled = true;
      killGroup();
    };
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });
    const buffering =
      options.onStdoutLine === undefined &&
      options.pipeStdoutTo === undefined &&
      options.discardStdout !== true;
    child.stdout?.on('data', (chunk: Buffer) => {
      touch();
      stdoutBytes += chunk.length;
      if (options.onStdoutLine !== undefined) {
        pending += stdoutDecoder.write(chunk);
        let at = pending.indexOf('\n');
        while (at >= 0) {
          options.onStdoutLine(pending.slice(0, at));
          pending = pending.slice(at + 1);
          at = pending.indexOf('\n');
        }
      } else if (buffering) {
        if (stdoutBytes > maxStdout) {
          if (!overflow) {
            overflow = true;
            child.kill('SIGKILL');
          }
        } else out.push(chunk);
      }
    });
    if (options.pipeStdoutTo !== undefined) child.stdout?.pipe(options.pipeStdoutTo);
    child.stderr?.on('data', (chunk: Buffer) => {
      touch();
      stderr += stderrDecoder.write(chunk);
      if (stderr.length > MAX_STDERR) stderr = stderr.slice(stderr.length - MAX_STDERR);
    });
    child.stdin?.on('error', () => {});
    child.once('error', (error) => {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      pending += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      if (pending.length > 0) options.onStdoutLine?.(pending);
      if (overflow) {
        reject(new GitOutputLimitError(maxStdout));
        return;
      }
      resolve({
        code: code ?? (signal === null ? 1 : 128),
        stdout: Buffer.concat(out).toString('utf8'),
        stderr,
        stdoutBytes,
        stalled,
        cancelled,
      });
    });
    if (options.manualStdin !== true) child.stdin?.end(options.input);
  });
  return { child, result };
}
