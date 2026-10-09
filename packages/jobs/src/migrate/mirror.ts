/**
 * The mirror clone in the job's scratch directory (LIF-040 steps 2, 4, 5). `git.prepare` creates
 * it; a push Step that runs in a later job (after a delay or a hand-off, when scratch started
 * empty again) rebuilds it from the source first.
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { StepFailure } from '../run/errors.ts';
import { gitCredentialOf, type MigrationContext, type Side } from './services.ts';
import type { RunWorld } from './world.ts';

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
  return { dir, sizeBytes: mirror.sizeBytes };
}

/** The mirror of this job, rebuilt from the source when the job has none yet. */
export async function ensureMirror(
  ctx: MigrationContext,
  world: RunWorld,
  source: Side,
): Promise<string> {
  const dir = mirrorDir(ctx);
  if (await isMirror(dir)) return dir;
  await ctx.runLog('info', 'Rebuilding the source mirror in this job', {});
  return (await buildMirror(ctx, world, source)).dir;
}
