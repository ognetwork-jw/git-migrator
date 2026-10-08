import type { GitClient } from '@git-migrator/adapter-sdk';
import { GitService } from '@git-migrator/git';
import type { Logger } from '@git-migrator/observability';

/**
 * The `GitClient` an Analysis hands to the `git-refs` driver (ls-remote only). One ls-remote costs
 * one unit in the adapter's git bucket, which the host cannot name, so it is not pre-acquired here
 * (ADR-0310); the Run engine's `GitService` does pre-acquire.
 */
export function createAnalysisGitClient(options: {
  readonly scratchDir: string;
  readonly logger?: Logger;
}): GitClient {
  return new GitService({
    quota: { acquire: async () => undefined },
    scratchDir: options.scratchDir,
    ...(options.logger ? { logger: options.logger } : {}),
  });
}
