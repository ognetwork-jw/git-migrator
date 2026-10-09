/**
 * The mirror clone in the job's scratch directory (LIF-040 steps 2, 4, 5). `git.prepare` creates
 * it; a push Step that runs in a later job (after a delay or a hand-off, when scratch started
 * empty again) rebuilds it from the source, and so passes the same gates again: the disk
 * precheck with its reservation (JOB-015) and the blob scan (FAC-GIT-004).
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { StepFailure } from '../run/errors.ts';
import type { StepResult } from '../run/types.ts';
import { checkScratchSpace, estimateScratchNeed, SCRATCH_INSUFFICIENT } from '../scratch.ts';
import { connectSide, gitCredentialOf, type MigrationContext, type Side } from './services.ts';
import type { RunWorld } from './world.ts';

/** Most blobs listed in one run-origin blocker's params, so the row stays small. */
export const MAX_LISTED_BLOBS = 20;

export function mirrorDir(ctx: MigrationContext): string {
  if (ctx.scratchDir === undefined) {
    throw new StepFailure('scratch.unavailable', 'The Run has no scratch directory');
  }
  return join(ctx.scratchDir, 'mirror');
}

async function isMirror(dir: string): Promise<boolean> {
  try {
    return (await stat(join(dir, 'objects'))).isDirectory();
  } catch {
    return false;
  }
}

/** `1.5 MiB`: the text the guidance parameters `size` and `limit` take. */
export function formatSize(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${Number.isInteger(value) ? value : value.toFixed(1)} ${units[unit]}`;
}

/**
 * The disk precheck of JOB-015 before a mirror is built: a delay result (10 minutes, counted in
 * `ctx.step.delays`), or `scratch.insufficient` after 6 delays. Reserves the space on success.
 */
export async function precheckScratch(
  ctx: MigrationContext,
  world: RunWorld,
): Promise<StepResult | undefined> {
  const { services } = ctx;
  const need = estimateScratchNeed(
    world.sourceRepository.sizeBytes,
    world.sourceRepository.lfsBytes,
  );
  const space = await checkScratchSpace({
    root: services.scratchRoot,
    needBytes: need,
    delaysSoFar: ctx.step.delays,
    runId: ctx.run.id,
    ...(services.freeBytes ? { freeBytes: services.freeBytes } : {}),
  });
  if (space.outcome === 'delay') {
    await ctx.runLog('warn', 'Not enough scratch space; the Run waits and tries again', {
      needBytes: need,
      delays: ctx.step.delays + 1,
    });
    return { status: 'delay', delayMs: space.delayMs, reason: 'not enough scratch space' };
  }
  if (space.outcome === 'fail') {
    throw new StepFailure(
      SCRATCH_INSUFFICIENT,
      'There is not enough scratch space for this repository; run it on a large worker',
      { needBytes: need },
    );
  }
  return undefined;
}

/**
 * FAC-GIT-004: scans the mirror against the target's blob limit. Blobs over it become run-origin
 * blockers `git-refs.blob-too-large` and fail the Step before anything is pushed.
 */
export async function scanMirror(
  ctx: MigrationContext,
  source: Side,
  target: Side,
  dir: string,
): Promise<{ blobsScanned: number }> {
  const maxBlobBytes = target.connection.limits.maxBlobBytes;
  const scan = await source.git.scanBlobs({
    dir,
    ...(maxBlobBytes !== undefined ? { maxBlobBytes } : {}),
    signal: ctx.signal,
  });
  for (const warning of scan.warnings.slice(0, MAX_LISTED_BLOBS)) {
    await ctx.runLog('warn', `${warning.code}: ${warning.params.path}`, { ...warning.params });
  }
  if (scan.blockers.length > 0) {
    for (const blocker of scan.blockers.slice(0, MAX_LISTED_BLOBS)) {
      await ctx.findings.addBlocker({
        code: blocker.code,
        params: {
          path: blocker.params.path,
          size: formatSize(blocker.params.size),
          limit: formatSize(blocker.params.limit).replace(' ', ''),
        },
      });
    }
    throw new StepFailure(
      'git-refs.blob-too-large',
      `${scan.blockers.length} blob(s) exceed the target limit of ${maxBlobBytes} bytes`,
      { count: scan.blockers.length, largestBytes: scan.blockers[0]?.params.size },
    );
  }
  return { blobsScanned: scan.scannedBlobs };
}

/**
 * Clones (or updates) the source mirror and fetches its LFS objects. Returns the directory and the
 * size of the mirror. Quota is pre-acquired by the git service (JOB-041).
 */
export async function buildMirror(
  ctx: MigrationContext,
  world: RunWorld,
  source: Side,
): Promise<{ dir: string; sizeBytes: number }> {
  const dir = mirrorDir(ctx);
  const { url, credential } = await gitCredentialOf(source, world.sourceRef);
  const mirror = await source.git.mirror({ url, credential, dir, signal: ctx.signal });
  await source.git.fetchLfs({ dir, url, credential, signal: ctx.signal });
  ctx.services.mirrors.note(ctx.run.id, dir);
  return { dir, sizeBytes: mirror.sizeBytes };
}

export type EnsuredMirror = { readonly dir: string } | { readonly stop: StepResult };

/**
 * The mirror of this job. When the job has none (the Run was delayed or handed off since
 * `git.prepare`) it is rebuilt from the source after the disk precheck, and scanned again before
 * anything is pushed. A `stop` result is returned as the Step's result.
 */
export async function ensureMirror(
  ctx: MigrationContext,
  world: RunWorld,
  source: Side,
): Promise<EnsuredMirror> {
  const dir = mirrorDir(ctx);
  if (await isMirror(dir)) {
    ctx.services.mirrors.note(ctx.run.id, dir);
    return { dir };
  }
  const stop = await precheckScratch(ctx, world);
  if (stop) return { stop };
  await ctx.runLog('info', 'Rebuilding the source mirror in this job', {});
  const target = await connectSide(ctx, world.targetEndpointId, world.targetType);
  const built = await buildMirror(ctx, world, source);
  const scanned = await scanMirror(ctx, source, target, built.dir);
  await ctx.runLog('info', 'The source mirror was rebuilt and scanned', {
    mirrorBytes: built.sizeBytes,
    blobsScanned: scanned.blobsScanned,
  });
  return { dir: built.dir };
}

/**
 * The bare source mirror of each Run in this process, for readers that can use it (parity,
 * FAC-GIT-005, T-072). A directory counts only while it still exists: scratch goes with the job.
 */
export class MirrorRegistry {
  readonly #dirs = new Map<string, string>();
  readonly #max: number;

  constructor(max = 64) {
    this.#max = max;
  }

  note(runId: string, dir: string): void {
    this.#dirs.delete(runId);
    this.#dirs.set(runId, dir);
    while (this.#dirs.size > this.#max) {
      const oldest = this.#dirs.keys().next().value;
      if (oldest === undefined) break;
      this.#dirs.delete(oldest);
    }
  }

  /** The Run's mirror directory, or `undefined` when this job has none. */
  async sourceMirror(runId: string): Promise<string | undefined> {
    const dir = this.#dirs.get(runId);
    if (dir === undefined) return undefined;
    if (await isMirror(dir)) return dir;
    this.#dirs.delete(runId);
    return undefined;
  }
}
