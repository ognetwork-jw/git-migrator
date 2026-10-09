/**
 * Where the LFS object ids of a source repository come from (FAC-GIT-005): `git lfs ls-files --all`
 * over a mirror. Inside a Run the mirror of `git.prepare` is reused (no network, no scratch). Outside
 * one, the source is mirrored into a per-check scratch directory after the JOB-015 disk precheck,
 * with the clone's units pre-acquired in the credential's `git` bucket (JOB-041). The credential
 * reaches git through `GIT_ASKPASS` only (ADP-071), never argv, the URL or a log.
 * Decisions: docs/adr/0397-parity-git-checks.md.
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { GitService } from '@git-migrator/git';
import type { Logger } from '@git-migrator/observability';
import {
  checkScratchSpace,
  estimateScratchNeed,
  releaseScratchReservation,
  SCRATCH_INSUFFICIENT,
  SCRATCH_MAX_DELAYS,
  withRunScratch,
} from '../scratch.ts';
import { type LfsObjectSource, ScratchInsufficientError } from './compute.ts';

export interface MirrorLfsSourceOptions {
  /** `$GM_SCRATCH_DIR` (JOB-015). */
  readonly scratchRoot: string;
  readonly log: Logger;
  /** Test seam: free bytes of the scratch volume. */
  readonly freeBytes?: (path: string) => Promise<number>;
}

const isDirectory = (path: string): Promise<boolean> =>
  stat(path).then(
    (s) => s.isDirectory(),
    () => false,
  );

export function createMirrorLfsSource(options: MirrorLfsSourceOptions): LfsObjectSource {
  return {
    async objects({ connection, repository, migrationId, signal, sizeBytes, quota, mirrorDir }) {
      const listIn = async (dir: string, git: GitService) =>
        (await git.listLfsObjects(dir, signal)).map((o) => ({ oid: o.oid, size: o.size }));
      const unmetered = { acquire: async () => undefined };

      // Inside a Run: the mirror `git.prepare` made. Local only, so nothing to meter or reserve.
      if (mirrorDir !== undefined && (await isDirectory(join(mirrorDir, 'objects')))) {
        const git = new GitService({
          quota: unmetered,
          scratchDir: mirrorDir,
          logger: options.log,
        });
        return listIn(mirrorDir, git);
      }

      const id = `parity-${migrationId}`;
      // JOB-015: the same estimate as `git.prepare`. A check cannot wait for space (10 minutes,
      // 6 times) the way a Run does, so a short volume makes the Facet unverifiable.
      const space = await checkScratchSpace({
        root: options.scratchRoot,
        needBytes: estimateScratchNeed(sizeBytes, 0n),
        delaysSoFar: SCRATCH_MAX_DELAYS,
        runId: id,
        ...(options.freeBytes ? { freeBytes: options.freeBytes } : {}),
      });
      if (space.outcome !== 'ok') throw new ScratchInsufficientError(SCRATCH_INSUFFICIENT);

      let credential: Awaited<ReturnType<typeof connection.git.credential>>;
      try {
        credential = await connection.git.credential(repository);
      } catch (error) {
        releaseScratchReservation(id);
        throw error;
      }
      const url = connection.git.remoteUrl(repository);
      return withRunScratch(options.scratchRoot, id, async (dir) => {
        const git = new GitService({
          quota: quota ?? unmetered,
          scratchDir: dir,
          logger: options.log,
        });
        const mirror = join(dir, 'mirror');
        // 3 units in the `git` bucket; a denial is `rate_limited` and ends the check.
        await git.mirror({ url, credential, dir: mirror, signal });
        return listIn(mirror, git);
      });
    },
  };
}
