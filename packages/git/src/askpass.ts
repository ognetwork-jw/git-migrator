/**
 * Credential injection (ADP-071). A git command gets its credential through `GIT_ASKPASS`, which
 * points at a script that reads the username and password from a per-session file in scratch
 * (mode 0600, directory 0700). The credential is never in argv, never in a remote URL, never in
 * `.git/config`, and not in the child's environment either. The script answers only for the one
 * origin the command is meant to talk to, so a redirect to another host cannot collect it.
 */
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MIN_SECRET_LENGTH } from '@git-migrator/adapter-sdk';

export interface AskpassCredential {
  readonly username: string;
  readonly password: string;
}

export interface AskpassSession {
  /** Directory holding the script and the credential file; also the child's `HOME`. */
  readonly dir: string;
  /** Environment for the child process: no credential value inside. */
  readonly env: Readonly<Record<string, string>>;
  /** Values to scrub from error text and to keep out of argv. */
  readonly secrets: readonly string[];
  dispose(): Promise<void>;
}

const HOST_PATTERN = /^[A-Za-z0-9.-]+(:\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/;

/** Prefix of the per-session credential directories inside the scratch directory. */
export const ASKPASS_DIR_PREFIX = '.gm-askpass-';

/**
 * Directories of the sessions this process is using right now. The sweep never touches them, so a
 * long-running command keeps its credential. (The scratch volume is per worker pod, JOB-015; a
 * volume shared between processes would need owner tokens instead.)
 */
const liveSessions = new Set<string>();

/**
 * The URL in the form git prints in its prompts (lower-case host, default port dropped), so the
 * askpass origin check matches exactly. Validates like {@link remoteHost}.
 */
export function normalizeRemoteUrl(url: string): string {
  remoteHost(url);
  return new URL(url).href;
}

/**
 * Removes credential directories a killed process left behind (SIGKILL skips `dispose`): those
 * not in this process's live registry and older than `olderThanMs`. The jobs runtime calls it from
 * its scratch cleanup. Returns the removed names.
 */
export async function sweepStaleCredentialFiles(
  scratchDir: string,
  options: { olderThanMs?: number; now?: () => number } = {},
): Promise<string[]> {
  const olderThan = options.olderThanMs ?? 10 * 60 * 1000;
  const now = (options.now ?? Date.now)();
  let names: string[];
  try {
    names = await readdir(scratchDir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!name.startsWith(ASKPASS_DIR_PREFIX)) continue;
    const path = join(scratchDir, name);
    if (liveSessions.has(path)) continue;
    try {
      const info = await stat(path);
      if (!info.isDirectory() || now - info.mtimeMs < olderThan) continue;
      await rm(path, { recursive: true, force: true });
      removed.push(name);
    } catch {
      // gone already
    }
  }
  return removed;
}

/** The `host[:port]` a git command may authenticate against. Credentials in the URL are refused. */
export function remoteHost(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid git remote URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Only http(s) git remotes are supported');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('A git remote URL must not carry credentials (ADP-071)');
  }
  if (!HOST_PATTERN.test(parsed.host)) throw new Error('Invalid git remote host');
  return parsed.host;
}

export function assertUsableCredential(credential: AskpassCredential): void {
  if (credential.password.length < MIN_SECRET_LENGTH) {
    throw new Error('The git credential is too short to be scrubbed from logs');
  }
  if (/[\r\n\0]/.test(credential.username) || /[\r\n\0]/.test(credential.password)) {
    throw new Error('A git credential must not contain line breaks');
  }
}

/** Single-quotes a shell word. The host pattern excludes quotes, but the path is quoted anyway. */
const sh = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** Script text. Matches git's prompt (`'`-quoted) and git-lfs' prompt (`"`-quoted). */
function script(file: string, host: string): string {
  return [
    '#!/bin/sh',
    `f=${sh(file)}`,
    'case "$1" in',
    `  *"//${host}"\\'*|*"//${host}"\\"*|*"//${host}/"*|*"@${host}"\\'*|*"@${host}"\\"*|*"@${host}/"*) ;;`,
    '  *) exit 1 ;;',
    'esac',
    'case "$1" in',
    '  Username*) sed -n 1p "$f" ;;',
    '  Password*) sed -n 2p "$f" ;;',
    '  *) exit 1 ;;',
    'esac',
    '',
  ].join('\n');
}

/**
 * Environment shared by every command: no prompts, no system or user credential helpers, only
 * http(s) transports, and a private `HOME` so `git-lfs` never writes to the operator's home.
 */
export function baseGitEnv(
  home: string,
  extraConfig: readonly (readonly [string, string])[] = [],
): Record<string, string> {
  const config: (readonly [string, string])[] = [
    ['credential.helper', ''],
    // A remote that stops sending is abandoned instead of hanging the Run (seconds).
    ['http.lowSpeedLimit', '1000'],
    ['http.lowSpeedTime', '60'],
    ['lfs.dialtimeout', '30'],
    ['lfs.activitytimeout', '120'],
    ['lfs.tlshandshaketimeout', '30'],
    ...extraConfig,
  ];
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ALLOW_PROTOCOL: 'http:https',
    GIT_LFS_SKIP_SMUDGE: '1',
    // git-lfs prints progress without a terminal, which the stall watchdog counts as activity.
    GIT_LFS_FORCE_PROGRESS: '1',
    GIT_AUTHOR_NAME: 'git-migrator',
    GIT_AUTHOR_EMAIL: 'noreply@git-migrator.invalid',
    GIT_COMMITTER_NAME: 'git-migrator',
    GIT_COMMITTER_EMAIL: 'noreply@git-migrator.invalid',
    LC_ALL: 'C',
    GIT_CONFIG_COUNT: String(config.length),
  };
  config.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

/**
 * Writes the script and the credential file under `scratchDir` and returns the environment that
 * makes git use them. Call `dispose()` when the command (or group of commands) is done.
 */
export async function createAskpassSession(options: {
  readonly scratchDir: string;
  readonly host: string;
  readonly credential: AskpassCredential;
  readonly extraConfig?: readonly (readonly [string, string])[];
}): Promise<AskpassSession> {
  assertUsableCredential(options.credential);
  if (!HOST_PATTERN.test(options.host)) throw new Error('Invalid git remote host');
  await mkdir(options.scratchDir, { recursive: true, mode: 0o700 });
  const dir = join(options.scratchDir, `${ASKPASS_DIR_PREFIX}${randomUUID()}`);
  await mkdir(dir, { mode: 0o700 });
  const credentialFile = join(dir, 'credential');
  const scriptFile = join(dir, 'askpass.sh');
  try {
    await writeFile(
      credentialFile,
      `${options.credential.username}\n${options.credential.password}\n`,
      { mode: 0o600 },
    );
    await chmod(credentialFile, 0o600);
    await writeFile(scriptFile, script(credentialFile, options.host), { mode: 0o700 });
    await chmod(scriptFile, 0o700);
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  const { username, password } = options.credential;
  liveSessions.add(dir);
  return {
    dir,
    env: { ...baseGitEnv(dir, options.extraConfig), GIT_ASKPASS: scriptFile },
    secrets: [password, `${username}:${password}`],
    dispose: () => {
      liveSessions.delete(dir);
      return rm(dir, { recursive: true, force: true });
    },
  };
}
