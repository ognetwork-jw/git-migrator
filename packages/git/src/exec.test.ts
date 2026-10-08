import { execFileSync, spawn } from 'node:child_process';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { GitOutputLimitError, GitSecretInArgvError, startGit } from './exec.ts';

/** Live (non-zombie) members of a process group; zombies are not reaped inside a container. */
function liveGroupMembers(pgid: number): string[] {
  const out = execFileSync('ps', ['-eo', 'pgid=,stat=,args='], { encoding: 'utf8' });
  return out
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(([group, stat]) => Number(group) === pgid && !stat?.startsWith('Z'))
    .map((parts) => parts.join(' '));
}

const env = { PATH: process.env.PATH ?? '', HOME: '/nonexistent', GIT_CONFIG_GLOBAL: '/dev/null' };

describe('git process execution', () => {
  it('[ADP-071] refuses to start a command whose argv carries a declared secret', () => {
    expect(() =>
      startGit(['ls-remote', 'https://x.example/a.git', 'pw-0123456789-secret'], {
        env,
        secrets: ['pw-0123456789-secret'],
      }),
    ).toThrow(GitSecretInArgvError);
    expect(() => startGit(['version'], { env, secrets: ['pw-0123456789-secret'] })).not.toThrow();
  });

  it('streams stdout lines without buffering and counts bytes', async () => {
    const lines: string[] = [];
    const result = await startGit(['--version'], { env, onStdoutLine: (l) => lines.push(l) })
      .result;
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(lines[0]).toMatch(/^git version /);
    const counted = await startGit(['--version'], { env, discardStdout: true }).result;
    expect(counted.stdoutBytes).toBeGreaterThan(10);
    expect(counted.stdout).toBe('');
  });

  it('can pipe stdout into a writable', async () => {
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk);
        callback();
      },
    });
    await startGit(['--version'], { env, pipeStdoutTo: sink }).result;
    expect(Buffer.concat(chunks).toString()).toMatch(/^git version /);
  });

  it('reports a non-zero exit with stderr and fails when output exceeds the buffer cap', async () => {
    const bad = await startGit(['definitely-not-a-command'], { env }).result;
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain('not a git command');
    await expect(
      startGit(['help', '-a'], { env, maxStdoutBytes: 10 }).result,
    ).rejects.toBeInstanceOf(GitOutputLimitError);
  });

  it('[ADP-060] the inactivity watchdog kills the whole process group and reports a stall', async () => {
    let pid = 0;
    const run = startGit(['ignored'], {
      env,
      inactivityMs: 200,
      spawn: (_command, _args, options) => {
        const child = spawn('sh', ['-c', 'sleep 30 & sleep 30'], options);
        pid = child.pid ?? 0;
        return child;
      },
    });
    const result = await run.result;
    expect(result.stalled).toBe(true);
    expect(result.code).not.toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(liveGroupMembers(pid)).toEqual([]);
  });

  it('[ADP-060] output keeps the watchdog from firing', async () => {
    const run = startGit(['ignored'], {
      env,
      inactivityMs: 400,
      spawn: (_command, _args, options) =>
        spawn('sh', ['-c', 'for i in 1 2 3 4; do echo tick >&2; sleep 0.2; done'], options),
    });
    const result = await run.result;
    expect(result.stalled).toBe(false);
    expect(result.code).toBe(0);
  });

  it('[LIF-044] multi-byte characters split across stdout and stderr chunks are decoded intact', async () => {
    const script = `
      const bytes = Buffer.from('ブランチ-日本語\\n');
      const half = 4;
      process.stdout.write(bytes.subarray(0, half));
      process.stderr.write(bytes.subarray(0, half));
      setTimeout(() => {
        process.stdout.write(bytes.subarray(half));
        process.stderr.write(bytes.subarray(half));
      }, 100);`;
    const lines: string[] = [];
    const run = startGit(['ignored'], {
      env,
      onStdoutLine: (line) => lines.push(line),
      spawn: (_c, _a, options) => spawn('node', ['-e', script], options),
    });
    const result = await run.result;
    expect(lines).toEqual(['ブランチ-日本語']);
    expect(result.stderr).toBe('ブランチ-日本語\n');
    expect(JSON.stringify(lines)).not.toContain('\ufffd');
    const buffered = await startGit(['ignored'], {
      env,
      spawn: (_c, _a, options) => spawn('node', ['-e', script], options),
    }).result;
    expect(buffered.stdout).toBe('ブランチ-日本語\n');
  });

  it('[ADP-060] an abort kills the whole process group and is reported as cancelled, not thrown', async () => {
    let pid = 0;
    const controller = new AbortController();
    const run = startGit(['ignored'], {
      env,
      signal: controller.signal,
      spawn: (_command, _args, options) => {
        const child = spawn('sh', ['-c', 'sleep 30 & sleep 30'], options);
        pid = child.pid ?? 0;
        return child;
      },
    });
    setTimeout(() => controller.abort(), 150);
    const result = await run.result;
    expect(result.cancelled).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(liveGroupMembers(pid)).toEqual([]);
    const already = new AbortController();
    already.abort();
    const early = await startGit(['ignored'], {
      env,
      signal: already.signal,
      spawn: (_c, _a, options) => spawn('sh', ['-c', 'sleep 30'], options),
    }).result;
    expect(early.cancelled).toBe(true);
  });
});
