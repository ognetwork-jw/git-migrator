import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkScratchSpace,
  cleanScratch,
  isScratchActive,
  releaseScratchReservation,
  SCRATCH_MAX_AGE_MS,
  withRunScratch,
} from './scratch.ts';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gm-scratch2-'));
});
afterEach(async () => {
  for (const id of ['run-a', 'run-b', 'run-c', 'run-d', 'run-e']) releaseScratchReservation(id);
  await rm(root, { recursive: true, force: true });
});

describe('scratch of running Runs', () => {
  it('[JOB-015] never cleans the directory of a Run that is still running, however old', async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let path = '';
    const running = withRunScratch(root, 'long-run', async (dir) => {
      path = dir;
      await writeFile(join(dir, 'pack'), 'data');
      const old = new Date(Date.now() - 3 * SCRATCH_MAX_AGE_MS);
      await utimes(dirname(dir), old, old);
      await hold;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(isScratchActive('long-run')).toBe(true);
    expect(await cleanScratch({ root })).toEqual([]);
    expect(existsSync(path)).toBe(true);
    release();
    await running;
    expect(isScratchActive('long-run')).toBe(false);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(dirname(path))).toBe(false);
  });

  it("[JOB-015] two overlapping jobs for one Run never delete each other's scratch", async () => {
    let releaseFirst: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstPath = '';
    const first = withRunScratch(root, 'dup-run', async (dir) => {
      firstPath = dir;
      await writeFile(join(dir, 'pack'), 'first');
      await hold;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    let secondPath = '';
    await withRunScratch(root, 'dup-run', async (dir) => {
      secondPath = dir;
      await writeFile(join(dir, 'pack'), 'second');
    });
    expect(secondPath).not.toBe(firstPath);
    // The second job finished and cleaned up; the first one's files and the Run directory remain.
    expect(existsSync(join(firstPath, 'pack'))).toBe(true);
    expect(existsSync(secondPath)).toBe(false);
    expect(isScratchActive('dup-run')).toBe(true);
    releaseFirst();
    await first;
    expect(existsSync(dirname(firstPath))).toBe(false);
    expect(isScratchActive('dup-run')).toBe(false);
  });

  it('[JOB-015] subtracts the space already reserved by Runs in this process', async () => {
    const free = async () => 1_000;
    const first = await checkScratchSpace({
      root,
      needBytes: 600,
      delaysSoFar: 0,
      freeBytes: free,
      runId: 'run-a',
    });
    expect(first).toEqual({ outcome: 'ok' });
    // 1000 free, 600 reserved by run-a: run-b needs 600 and must wait.
    const second = await checkScratchSpace({
      root,
      needBytes: 600,
      delaysSoFar: 0,
      freeBytes: free,
      runId: 'run-b',
    });
    expect(second.outcome).toBe('delay');
    // A smaller Run still fits next to run-a.
    expect(
      await checkScratchSpace({
        root,
        needBytes: 400,
        delaysSoFar: 0,
        freeBytes: free,
        runId: 'run-c',
      }),
    ).toEqual({ outcome: 'ok' });
    // Asking again for run-a does not count its own reservation twice.
    expect(
      await checkScratchSpace({
        root,
        needBytes: 600,
        delaysSoFar: 0,
        freeBytes: async () => 1_000,
        runId: 'run-a',
      }),
    ).toEqual({ outcome: 'ok' });
    releaseScratchReservation('run-a');
    releaseScratchReservation('run-c');
    expect(
      await checkScratchSpace({
        root,
        needBytes: 600,
        delaysSoFar: 0,
        freeBytes: free,
        runId: 'run-b',
      }),
    ).toEqual({ outcome: 'ok' });
    releaseScratchReservation('run-b');
  });

  it('[JOB-015] releases the reservation when the Run finishes', async () => {
    await checkScratchSpace({
      root,
      needBytes: 900,
      delaysSoFar: 0,
      freeBytes: async () => 1_000,
      runId: 'run-d',
    });
    await withRunScratch(root, 'run-d', async () => undefined);
    expect(
      await checkScratchSpace({
        root,
        needBytes: 900,
        delaysSoFar: 0,
        freeBytes: async () => 1_000,
        runId: 'run-e',
      }),
    ).toEqual({ outcome: 'ok' });
    releaseScratchReservation('run-e');
  });

  it("[JOB-015] counts only the unwritten part of a running Run's reservation", async () => {
    expect(
      await checkScratchSpace({
        root,
        needBytes: 600,
        delaysSoFar: 0,
        freeBytes: async () => 1_000,
        runId: 'run-d',
      }),
    ).toEqual({ outcome: 'ok' });
    // run-d has written 400 of its 600 bytes, so the disk now reports 600 free.
    await mkdir(join(root, 'run-d', 'job'), { recursive: true });
    await writeFile(join(root, 'run-d', 'job', 'pack'), Buffer.alloc(400));
    // 600 free minus the 200 run-d may still write: 400 is left for run-e.
    expect(
      await checkScratchSpace({
        root,
        needBytes: 400,
        delaysSoFar: 0,
        freeBytes: async () => 600,
        runId: 'run-e',
      }),
    ).toEqual({ outcome: 'ok' });
  });

  it('[JOB-015] the first job of a Run removes job directories a dead process left behind', async () => {
    const leftover = join(root, 'crashed-run', 'deadjob');
    await mkdir(leftover, { recursive: true });
    await writeFile(join(leftover, 'pack'), 'stale');
    let releaseFirst: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstPath = '';
    let secondPath = '';
    // Two jobs start together: only the leftovers go, never the other job's directory.
    const first = withRunScratch(root, 'crashed-run', async (dir) => {
      firstPath = dir;
      await writeFile(join(dir, 'pack'), 'first');
      await hold;
    });
    const second = withRunScratch(root, 'crashed-run', async (dir) => {
      secondPath = dir;
      expect(existsSync(leftover)).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await second;
    expect(existsSync(leftover)).toBe(false);
    expect(secondPath).not.toBe('');
    while (!firstPath || !existsSync(join(firstPath, 'pack'))) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // The second job ended without touching the first one's files.
    expect(existsSync(secondPath)).toBe(false);
    releaseFirst();
    await first;
    expect(existsSync(join(root, 'crashed-run'))).toBe(false);
  });
});
