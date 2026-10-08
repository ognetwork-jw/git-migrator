import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkScratchSpace,
  classifySize,
  cleanScratch,
  DEFAULT_SCRATCH_DIR,
  estimateScratchNeed,
  runScratchPath,
  SCRATCH_DELAY_MS,
  SCRATCH_INSUFFICIENT,
  SCRATCH_MAX_AGE_MS,
  ScratchCleaner,
  scratchRoot,
  withRunScratch,
} from './scratch.ts';

const GIB = 1024 ** 3;
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gm-scratch-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('size classes', () => {
  it('[JOB-015] is large above the threshold and standard at or below it', () => {
    const threshold = 5 * GIB;
    expect(classifySize(threshold, null, threshold)).toBe('standard');
    expect(classifySize(threshold + 1, null, threshold)).toBe('large');
    expect(classifySize(BigInt(threshold + 1), 0n, threshold)).toBe('large');
  });

  it('[JOB-015] uses the last known LFS bytes when the size is unknown', () => {
    const threshold = 5 * GIB;
    expect(classifySize(null, threshold + 1, threshold)).toBe('large');
    expect(classifySize(undefined, BigInt(threshold + 1), threshold)).toBe('large');
    expect(classifySize(null, threshold, threshold)).toBe('standard');
    expect(classifySize(null, null, threshold)).toBe('standard');
    // A known size wins over LFS bytes.
    expect(classifySize(1, threshold * 2, threshold)).toBe('standard');
  });
});

describe('scratch directory', () => {
  it('[JOB-015] defaults to /scratch and reads GM_SCRATCH_DIR', () => {
    expect(scratchRoot({})).toBe(DEFAULT_SCRATCH_DIR);
    expect(scratchRoot({ GM_SCRATCH_DIR: '' })).toBe('/scratch');
    expect(scratchRoot({ GM_SCRATCH_DIR: '/var/scratch' })).toBe('/var/scratch');
  });

  it('[JOB-015] puts a Run in $GM_SCRATCH_DIR/<runId> and refuses ids that escape', () => {
    expect(runScratchPath('/scratch', '0192-abc')).toBe('/scratch/0192-abc');
    for (const bad of ['', '..', '../x', 'a/b', '.hidden', 'a b']) {
      expect(() => runScratchPath('/scratch', bad)).toThrow('Invalid Run id');
    }
  });

  it('[JOB-015] removes the Run directory in finally, on success and on failure', async () => {
    let seen = '';
    await withRunScratch(root, 'run-ok', async (path) => {
      seen = path;
      await writeFile(join(path, 'pack'), 'data');
      expect(existsSync(path)).toBe(true);
    });
    expect(existsSync(seen)).toBe(false);
    await expect(
      withRunScratch(root, 'run-bad', async (path) => {
        await writeFile(join(path, 'x'), 'y');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(existsSync(join(root, 'run-bad'))).toBe(false);
  });
});

describe('disk precheck', () => {
  it('[JOB-015] estimates the need as sizeBytes x 2.2 + lfsBytes', () => {
    expect(estimateScratchNeed(1000, 500)).toBe(2700);
    expect(estimateScratchNeed(100n, 0n)).toBe(220);
    expect(estimateScratchNeed(null, 40)).toBe(40);
    expect(estimateScratchNeed(null, null)).toBe(0);
  });

  it('[JOB-015] passes when free space covers the need', async () => {
    const result = await checkScratchSpace({
      root,
      needBytes: 100,
      delaysSoFar: 0,
      freeBytes: async () => 100,
    });
    expect(result).toEqual({ outcome: 'ok' });
  });

  it('[JOB-015] delays 10 minutes while space is short, then fails after 6 delays', async () => {
    const short = (delaysSoFar: number) =>
      checkScratchSpace({ root, needBytes: 100, delaysSoFar, freeBytes: async () => 99 });
    for (let delays = 0; delays < 6; delays += 1) {
      expect(await short(delays)).toEqual({ outcome: 'delay', delayMs: SCRATCH_DELAY_MS });
    }
    expect(SCRATCH_DELAY_MS).toBe(600_000);
    expect(await short(6)).toEqual({ outcome: 'fail', code: SCRATCH_INSUFFICIENT });
    expect(SCRATCH_INSUFFICIENT).toBe('scratch.insufficient');
  });

  it('[JOB-015] reads real free space with statfs and creates the root if needed', async () => {
    const fresh = join(root, 'new', 'dir');
    expect(await checkScratchSpace({ root: fresh, needBytes: 1, delaysSoFar: 0 })).toEqual({
      outcome: 'ok',
    });
    expect(
      await checkScratchSpace({ root: fresh, needBytes: Number.MAX_SAFE_INTEGER, delaysSoFar: 0 }),
    ).toEqual({ outcome: 'delay', delayMs: SCRATCH_DELAY_MS });
  });
});

async function age(path: string, ms: number): Promise<void> {
  const when = new Date(Date.now() - ms);
  await utimes(path, when, when);
}

describe('scratch cleanup', () => {
  it('[JOB-015] removes directories older than 24 h and keeps newer ones', async () => {
    await mkdir(join(root, 'old', 'nested'), { recursive: true });
    await writeFile(join(root, 'old', 'nested', 'f'), 'x');
    await mkdir(join(root, 'fresh'));
    await mkdir(join(root, 'edge'));
    await age(join(root, 'old'), SCRATCH_MAX_AGE_MS + 60_000);
    await age(join(root, 'fresh'), 60_000);
    await age(join(root, 'edge'), SCRATCH_MAX_AGE_MS - 60_000);
    expect(await cleanScratch({ root })).toEqual(['old']);
    expect(existsSync(join(root, 'old'))).toBe(false);
    expect(existsSync(join(root, 'fresh'))).toBe(true);
    expect(existsSync(join(root, 'edge'))).toBe(true);
  });

  it('[JOB-015] leaves symlinks and loose files alone', async () => {
    const target = join(root, 'target');
    await mkdir(target);
    await symlink(target, join(root, 'link'));
    await writeFile(join(root, 'file'), 'x');
    await age(target, 3 * SCRATCH_MAX_AGE_MS);
    await age(join(root, 'file'), 3 * SCRATCH_MAX_AGE_MS);
    expect(await cleanScratch({ root })).toEqual(['target']);
    expect(existsSync(join(root, 'link'))).toBe(false); // dangling now, but never removed by us
    expect(existsSync(join(root, 'file'))).toBe(true);
  });

  it('[JOB-015] treats a missing root as nothing to clean', async () => {
    expect(await cleanScratch({ root: join(root, 'absent') })).toEqual([]);
  });

  it('[JOB-015] cleans at start-up and again on the schedule, and stops', async () => {
    await mkdir(join(root, 'old'));
    await age(join(root, 'old'), 2 * SCRATCH_MAX_AGE_MS);
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-10-08T10:00:00Z'));
    await utimes(
      join(root, 'old'),
      new Date('2026-10-06T10:00:00Z'),
      new Date('2026-10-06T10:00:00Z'),
    );
    const cleaner = new ScratchCleaner({ root, cron: '35 * * * *' });
    expect(await cleaner.start()).toEqual(['old']);
    await mkdir(join(root, 'later'));
    await utimes(
      join(root, 'later'),
      new Date('2026-10-06T11:00:00Z'),
      new Date('2026-10-06T11:00:00Z'),
    );
    await vi.advanceTimersByTimeAsync(36 * 60_000); // past 10:35
    await vi.waitFor(() => expect(existsSync(join(root, 'later'))).toBe(false));
    cleaner.stop();
    await mkdir(join(root, 'after-stop'));
    await utimes(
      join(root, 'after-stop'),
      new Date('2026-10-01T00:00:00Z'),
      new Date('2026-10-01T00:00:00Z'),
    );
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    expect(existsSync(join(root, 'after-stop'))).toBe(true);
  });
});
