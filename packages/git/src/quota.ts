/**
 * Git commands cost units in the `git` bucket, pre-acquired before the command runs (JOB-041):
 * ls-remote 1, fetch and clone 3, push 3 per batch, LFS 1 per 100 objects (the LFS batch calls
 * `git-lfs` makes count here too). A denied acquire is `rate_limited` with `retryAt`, so the job
 * is delayed rather than sleeping (JOB-044).
 */
import { AdapterError, type QuotaGate } from '@git-migrator/adapter-sdk';

export const GIT_UNITS = {
  lsRemote: 1,
  fetch: 3,
  clone: 3,
  push: 3,
} as const;

/** LFS batch API calls carry at most 100 objects (the usual provider default). */
export const LFS_OBJECTS_PER_UNIT = 100;

/** Units for an LFS transfer of `objects` objects: 1 per 100, none for nothing to transfer. */
export function lfsUnits(objects: number): number {
  return objects <= 0 ? 0 : Math.ceil(objects / LFS_OBJECTS_PER_UNIT);
}

/** Pre-acquires `units` in the git bucket, or throws `rate_limited`. */
export interface GitQuota {
  acquire(units: number): Promise<void>;
}

export interface GitQuotaOptions {
  readonly gate: Pick<QuotaGate, 'acquire'>;
  /** `bucketKey(endpointId, accountKey, 'git')`. */
  readonly bucketKey: string;
  /** Configured limit of the bucket per window (JOB-043: 60,000 per hour). */
  readonly limit: number;
  readonly windowSeconds: number;
  readonly pool: 'background' | 'interactive';
  readonly now?: () => Date;
}

export function createGitQuota(options: GitQuotaOptions): GitQuota {
  const now = options.now ?? (() => new Date());
  return {
    async acquire(units) {
      if (units <= 0) return;
      const grant = await options.gate.acquire(
        [
          {
            key: options.bucketKey,
            limit: options.limit,
            windowSeconds: options.windowSeconds,
            units,
          },
        ],
        options.pool,
      );
      if (grant.granted) return;
      throw new AdapterError({
        code: 'rate_limited',
        provider: 'git',
        message: `Quota ${grant.reason} for ${grant.bucketKey}`,
        retryAt: grant.retryAt,
        retryAfterMs: Math.max(0, grant.retryAt.getTime() - now().getTime()),
      });
    },
  };
}
