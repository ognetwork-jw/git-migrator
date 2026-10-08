import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, rm, rmdir, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '@git-migrator/observability';
import { CronExpressionParser } from 'cron-parser';

/** Default scratch root (JOB-015). The chart mounts an `emptyDir` or an ephemeral volume here. */
export const DEFAULT_SCRATCH_DIR = '/scratch';

/** Scratch directories older than this are removed by `maintenance.scratch-cleanup` (JOB-015). */
export const SCRATCH_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** The disk precheck delays a job by 10 minutes, at most 6 times (JOB-015). */
export const SCRATCH_DELAY_MS = 10 * 60 * 1000;
export const SCRATCH_MAX_DELAYS = 6;

/** The Run error code after the last delay. */
export const SCRATCH_INSUFFICIENT = 'scratch.insufficient';

type Env = Readonly<Record<string, string | undefined>>;
type Bytes = number | bigint | null | undefined;

export function scratchRoot(env: Env): string {
  const value = env.GM_SCRATCH_DIR;
  return value ? value : DEFAULT_SCRATCH_DIR;
}

const toNumber = (value: Bytes): number | undefined =>
  value === null || value === undefined ? undefined : Number(value);

/**
 * `large` when `sizeBytes` exceeds `largeThresholdBytes`, or when the size is unknown and the last
 * known LFS bytes exceed it (JOB-015).
 */
export function classifySize(
  sizeBytes: Bytes,
  lfsBytes: Bytes,
  largeThresholdBytes: number,
): 'standard' | 'large' {
  const size = toNumber(sizeBytes);
  if (size !== undefined) return size > largeThresholdBytes ? 'large' : 'standard';
  return (toNumber(lfsBytes) ?? 0) > largeThresholdBytes ? 'large' : 'standard';
}

/** Estimated scratch need before `git.prepare`: `sizeBytes x 2.2 + lfsBytes` (JOB-015). */
export function estimateScratchNeed(sizeBytes: Bytes, lfsBytes: Bytes): number {
  // 22 / 10 rather than 2.2: the product of integers is exact, so 100 bytes need exactly 220.
  return Math.ceil(((toNumber(sizeBytes) ?? 0) * 22) / 10 + (toNumber(lfsBytes) ?? 0));
}

/** `$GM_SCRATCH_DIR/<runId>`. The Run id must be a plain name: no separators or dots-only. */
export function runScratchPath(root: string, runId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(runId)) throw new Error('Invalid Run id for scratch');
  return join(root, runId);
}

/** How many jobs in this process use each Run's scratch directory (JOB-015). */
const activeRuns = new Map<string, number>();
/** Bytes this process reserved for Runs that passed the disk precheck and have not finished. */
const reservations = new Map<string, number>();
/** Per Run, the removal of a dead process's leftovers that its first job here waits for. */
const preparing = new Map<string, Promise<void>>();

/** True while `withRunScratch` is running for `runId` in this process. */
export function isScratchActive(runId: string): boolean {
  return (activeRuns.get(runId) ?? 0) > 0;
}

/** Drops the reservation of `runId`, for a Run that passed the precheck but never started. */
export function releaseScratchReservation(runId: string): void {
  reservations.delete(runId);
}

/**
 * Creates a scratch directory for this job under `$GM_SCRATCH_DIR/<runId>/<random>`, runs `fn`, and
 * removes that directory in `finally`, and the Run directory too once nobody uses it. The
 * directory is per job, so two jobs for one Run (a stalled job and its resume) never delete each
 * other's files. While any job runs, `cleanScratch` skips the Run directory however old it is, so a
 * Run longer than 24 h keeps its data. The reservation ends with the last job of the Run.
 *
 * When the first job of a Run starts in this process, the job directories already under the Run
 * directory belong to a process that died (scratch is pod-local), for example a crashed job before
 * its resume: they are removed first, and every job of the Run waits for that removal.
 */
export async function withRunScratch<T>(
  root: string,
  runId: string,
  fn: (path: string) => Promise<T>,
): Promise<T> {
  const runDir = runScratchPath(root, runId);
  const path = join(runDir, randomBytes(6).toString('hex'));
  const first = (activeRuns.get(runId) ?? 0) === 0;
  activeRuns.set(runId, (activeRuns.get(runId) ?? 0) + 1);
  if (first) preparing.set(runId, removeLeftovers(runDir));
  try {
    await preparing.get(runId);
    await mkdir(path, { recursive: true, mode: 0o700 });
    return await fn(path);
  } finally {
    await rm(path, { recursive: true, force: true });
    await rmdir(runDir).catch(() => undefined); // only when empty
    const left = (activeRuns.get(runId) ?? 1) - 1;
    if (left <= 0) {
      activeRuns.delete(runId);
      reservations.delete(runId);
      preparing.delete(runId);
    } else {
      activeRuns.set(runId, left);
    }
  }
}

/** Removes the entries of a Run directory no job in this process owns. Never rejects. */
async function removeLeftovers(runDir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(runDir);
  } catch {
    return; // no directory yet
  }
  await Promise.all(
    names.map((name) =>
      rm(join(runDir, name), { recursive: true, force: true }).catch(() => undefined),
    ),
  );
}

/** Bytes of the regular files under `path`, without following symlinks; 0 when it is missing. */
async function usedBytes(path: string): Promise<number> {
  try {
    const stats = await lstat(path);
    if (!stats.isDirectory()) return stats.isFile() ? stats.size : 0;
    let total = 0;
    for (const name of await readdir(path)) total += await usedBytes(join(path, name));
    return total;
  } catch {
    return 0; // removed meanwhile
  }
}

export type ScratchSpace =
  | { readonly outcome: 'ok' }
  | { readonly outcome: 'delay'; readonly delayMs: number }
  | { readonly outcome: 'fail'; readonly code: typeof SCRATCH_INSUFFICIENT };

export interface ScratchSpaceOptions {
  readonly root: string;
  readonly needBytes: number;
  /** How many times this Run has already been delayed by this check. */
  readonly delaysSoFar: number;
  /**
   * The Run asking. On `ok` its need is reserved until `withRunScratch` ends for it (or
   * `releaseScratchReservation`), so concurrent Runs in this process do not all see the same free
   * space. What other Runs reserved and have not written yet is subtracted from the free space:
   * the part they already wrote is gone from the free space already.
   */
  readonly runId?: string;
  /** Test seam: free bytes. Defaults to `statfs`. */
  readonly freeBytes?: (path: string) => Promise<number>;
}

async function statfsFree(path: string): Promise<number> {
  const stats = await statfs(path);
  return Number(stats.bavail) * Number(stats.bsize);
}

/**
 * The disk precheck (JOB-015): ok when free space covers the estimate, otherwise delay 10 minutes,
 * and after 6 delays fail with `scratch.insufficient` (the UI then suggests the large class).
 */
export async function checkScratchSpace(options: ScratchSpaceOptions): Promise<ScratchSpace> {
  await mkdir(options.root, { recursive: true });
  const statFree = await (options.freeBytes ?? statfsFree)(options.root);
  let reserved = 0;
  for (const [id, bytes] of reservations) {
    if (id === options.runId) continue;
    reserved += Math.max(0, bytes - (await usedBytes(runScratchPath(options.root, id))));
  }
  const free = statFree - reserved;
  if (free >= options.needBytes) {
    if (options.runId !== undefined) reservations.set(options.runId, options.needBytes);
    return { outcome: 'ok' };
  }
  if (options.delaysSoFar >= SCRATCH_MAX_DELAYS) {
    return { outcome: 'fail', code: SCRATCH_INSUFFICIENT };
  }
  return { outcome: 'delay', delayMs: SCRATCH_DELAY_MS };
}

export interface CleanScratchOptions {
  readonly root: string;
  readonly maxAgeMs?: number;
  readonly now?: () => number;
  readonly log?: Logger;
}

/**
 * Removes scratch directories not modified for 24 h (JOB-015). Only direct children that are real
 * directories are touched: a symlink or a stray file is left alone. Returns the removed names.
 */
export async function cleanScratch(options: CleanScratchOptions): Promise<string[]> {
  const maxAge = options.maxAgeMs ?? SCRATCH_MAX_AGE_MS;
  const now = (options.now ?? Date.now)();
  let names: string[];
  try {
    names = await readdir(options.root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const removed: string[] = [];
  for (const name of names) {
    const path = join(options.root, name);
    try {
      const stats = await lstat(path);
      if (!stats.isDirectory() || now - stats.mtimeMs <= maxAge) continue;
      if (isScratchActive(name)) continue;
      await rm(path, { recursive: true, force: true });
      removed.push(name);
    } catch (error) {
      options.log?.warn({ err: error, name }, 'scratch cleanup could not remove an entry');
    }
  }
  return removed;
}

export interface ScratchCleanerOptions extends CleanScratchOptions {
  /** `schedules.scratchCleanup`, a five-field cron expression. */
  readonly cron: string;
}

/**
 * Runs `cleanScratch` at start-up and on `schedules.scratchCleanup` in every worker pod, because
 * the scratch directory is pod-local (JOB-015, JOB-050).
 */
export class ScratchCleaner {
  readonly #options: ScratchCleanerOptions;
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;

  constructor(options: ScratchCleanerOptions) {
    this.#options = options;
  }

  async start(): Promise<string[]> {
    const removed = await this.#run();
    this.#schedule();
    return removed;
  }

  async #run(): Promise<string[]> {
    try {
      const removed = await cleanScratch(this.#options);
      if (removed.length > 0) this.#options.log?.info({ removed }, 'scratch cleanup');
      return removed;
    } catch (error) {
      this.#options.log?.error({ err: error }, 'scratch cleanup failed');
      return [];
    }
  }

  #schedule(): void {
    if (this.#stopped) return;
    const now = (this.#options.now ?? Date.now)();
    const next = CronExpressionParser.parse(this.#options.cron, {
      currentDate: new Date(now),
      tz: 'UTC',
    })
      .next()
      .toDate();
    this.#timer = setTimeout(
      () => {
        void this.#run().finally(() => this.#schedule());
      },
      Math.max(1_000, next.getTime() - now),
    );
    this.#timer.unref();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
  }
}
