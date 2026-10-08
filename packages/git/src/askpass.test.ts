import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertUsableCredential,
  baseGitEnv,
  createAskpassSession,
  normalizeRemoteUrl,
  remoteHost,
  sweepStaleCredentialFiles,
} from './askpass.ts';

const run = promisify(execFile);
const PASSWORD = 'pw-0123456789-secret';

let work: string;
beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'askpass-test-'));
});
afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

async function ask(script: string, prompt: string): Promise<{ code: number; out: string }> {
  try {
    const { stdout } = await run(script, [prompt]);
    return { code: 0, out: stdout };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string };
    return { code: failed.code ?? 1, out: failed.stdout ?? '' };
  }
}

describe('askpass session', () => {
  it('[ADP-071] keeps the credential in a 0600 file in a 0700 directory and out of the environment', async () => {
    const session = await createAskpassSession({
      scratchDir: work,
      host: '127.0.0.1:4030',
      credential: { username: 'bot', password: PASSWORD },
    });
    const file = join(session.dir, 'credential');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(session.dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(session.dir, 'askpass.sh')).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(session.dir, 'askpass.sh'), 'utf8')).not.toContain(PASSWORD);
    for (const value of Object.values(session.env)) expect(value).not.toContain(PASSWORD);
    expect(session.env.GIT_ASKPASS).toBe(join(session.dir, 'askpass.sh'));
    expect(session.env.HOME).toBe(session.dir);
    expect(session.secrets).toContain(PASSWORD);
    await session.dispose();
    expect(existsSync(session.dir)).toBe(false);
    await session.dispose();
  });

  it('[ADP-071] answers git and git-lfs prompts for its own origin only', async () => {
    const session = await createAskpassSession({
      scratchDir: work,
      host: '127.0.0.1:4030',
      credential: { username: 'bot', password: PASSWORD },
    });
    const script = session.env.GIT_ASKPASS as string;
    expect(await ask(script, "Username for 'http://127.0.0.1:4030': ")).toEqual({
      code: 0,
      out: 'bot\n',
    });
    expect(await ask(script, "Password for 'http://bot@127.0.0.1:4030': ")).toEqual({
      code: 0,
      out: `${PASSWORD}\n`,
    });
    expect(await ask(script, 'Username for "http://127.0.0.1:4030"')).toEqual({
      code: 0,
      out: 'bot\n',
    });
    expect(await ask(script, 'Password for "http://bot@127.0.0.1:4030"')).toEqual({
      code: 0,
      out: `${PASSWORD}\n`,
    });
    // Another host, a longer port, a look-alike prefix and an unknown prompt get nothing.
    for (const prompt of [
      "Password for 'https://evil.example'",
      "Password for 'http://bot@127.0.0.1:40300'",
      "Password for 'http://bot@x127.0.0.1:4030'",
      "Password for 'http://127.0.0.1:4030.evil.example'",
      "Passphrase for key '/home/x/.ssh/id'",
      "Enter something for 'http://127.0.0.1:4030'",
    ]) {
      const answer = await ask(script, prompt);
      expect(answer.out, prompt).toBe('');
      expect(answer.code, prompt).not.toBe(0);
    }
    await session.dispose();
  });

  it('[ADP-071] refuses credentials that are too short to scrub or contain line breaks', () => {
    expect(() => assertUsableCredential({ username: 'u', password: 'abc' })).toThrow(/too short/);
    expect(() => assertUsableCredential({ username: 'u', password: `${PASSWORD}\nx` })).toThrow(
      /line breaks/,
    );
    expect(() => assertUsableCredential({ username: 'u\r', password: PASSWORD })).toThrow(
      /line breaks/,
    );
    expect(() => assertUsableCredential({ username: 'u', password: PASSWORD })).not.toThrow();
  });

  it('[ADP-071] remote URLs must be http(s) without userinfo, and the error never echoes the userinfo', () => {
    expect(remoteHost('https://example.test/acme/app.git')).toBe('example.test');
    expect(remoteHost('http://127.0.0.1:4030/source/a/b.git')).toBe('127.0.0.1:4030');
    expect(() => remoteHost('https://user:secret@example.test/a.git')).toThrow(/credentials/);
    expect(() => remoteHost('https://user@example.test/a.git')).toThrow(/credentials/);
    expect(() => remoteHost('ssh://git@example.test/a.git')).toThrow(/http/);
    expect(() => remoteHost('ext::sh -c touch% /tmp/x')).toThrow();
    expect(() => remoteHost('not a url')).toThrow(/Invalid/);
    let message = '';
    try {
      remoteHost('https://user:hunter2-secret@example.test/a.git');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain('hunter2');
  });

  it('[ADP-071] the base environment disables credential helpers and prompts and isolates HOME', () => {
    const env = baseGitEnv('/private/home', [['remote.gm-target.url', 'https://t.example/a.git']]);
    expect(env.HOME).toBe('/private/home');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(env.GIT_ALLOW_PROTOCOL).toBe('http:https');
    expect(env.GIT_CONFIG_COUNT).toBe('7');
    expect([env.GIT_CONFIG_KEY_0, env.GIT_CONFIG_VALUE_0]).toEqual(['credential.helper', '']);
    expect([env.GIT_CONFIG_KEY_6, env.GIT_CONFIG_VALUE_6]).toEqual([
      'remote.gm-target.url',
      'https://t.example/a.git',
    ]);
    // Stalled remotes are abandoned by git and git-lfs themselves.
    expect([env.GIT_CONFIG_KEY_1, env.GIT_CONFIG_VALUE_1]).toEqual(['http.lowSpeedLimit', '1000']);
    expect([env.GIT_CONFIG_KEY_2, env.GIT_CONFIG_VALUE_2]).toEqual(['http.lowSpeedTime', '60']);
    expect(env.GIT_CONFIG_KEY_3).toBe('lfs.dialtimeout');
    expect(env.GIT_CONFIG_KEY_4).toBe('lfs.activitytimeout');
    expect(env.GIT_CONFIG_KEY_5).toBe('lfs.tlshandshaketimeout');
  });
});

describe('origin matching and stale credential files', () => {
  it('[ADP-071] git is given the URL in the form it prints in prompts (lower-case host, default port dropped)', () => {
    expect(normalizeRemoteUrl('https://Example.COM:443/Acme/App.git')).toBe(
      'https://example.com/Acme/App.git',
    );
    expect(normalizeRemoteUrl('http://EXAMPLE.test:80/a.git')).toBe('http://example.test/a.git');
    expect(normalizeRemoteUrl('http://127.0.0.1:4030/x.git')).toBe('http://127.0.0.1:4030/x.git');
    expect(() => normalizeRemoteUrl('https://u:p@example.com/a.git')).toThrow(/credentials/);
  });

  it('[ADP-071] the askpass script of a normalised URL answers the prompt git prints for it', async () => {
    const url = normalizeRemoteUrl('https://Example.COM:443/a.git');
    const session = await createAskpassSession({
      scratchDir: work,
      host: remoteHost(url),
      credential: { username: 'bot', password: PASSWORD },
    });
    expect(
      (await ask(session.env.GIT_ASKPASS as string, "Username for 'https://example.com': ")).out,
    ).toBe('bot\n');
    await session.dispose();
  });

  it('[ADP-071] sweepStaleCredentialFiles removes old askpass directories left by a killed process and nothing else', async () => {
    const dir = await mkdtemp(join(work, 'sweep-'));
    const old = join(dir, '.gm-askpass-old');
    const fresh = join(dir, '.gm-askpass-fresh');
    const other = join(dir, 'mirror');
    for (const d of [old, fresh, other]) await mkdir(d);
    const longAgo = new Date(Date.now() - 3_600_000);
    await utimes(old, longAgo, longAgo);
    expect(await sweepStaleCredentialFiles(dir, { olderThanMs: 600_000 })).toEqual([
      '.gm-askpass-old',
    ]);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(other)).toBe(true);
    expect(await sweepStaleCredentialFiles(join(dir, 'missing'))).toEqual([]);
  });

  it('[ADP-071] a live session survives the sweep however old its directory is; once disposed it is gone', async () => {
    const dir = await mkdtemp(join(work, 'sweep-live-'));
    const session = await createAskpassSession({
      scratchDir: dir,
      host: '127.0.0.1:4030',
      credential: { username: 'bot', password: PASSWORD },
    });
    const orphan = join(dir, '.gm-askpass-orphan');
    await mkdir(orphan);
    const longAgo = new Date(Date.now() - 3_600_000);
    await utimes(session.dir, longAgo, longAgo);
    await utimes(orphan, longAgo, longAgo);
    const removed = await sweepStaleCredentialFiles(dir, { olderThanMs: 1000 });
    expect(removed).toEqual(['.gm-askpass-orphan']);
    expect(existsSync(session.dir)).toBe(true);
    expect(existsSync(join(session.dir, 'credential'))).toBe(true);
    await session.dispose();
    expect(existsSync(session.dir)).toBe(false);
  });
});
