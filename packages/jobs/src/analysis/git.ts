import type { GitClient } from '@git-migrator/adapter-sdk';
import { GitService } from '@git-migrator/git';
import type { Logger } from '@git-migrator/observability';

/**
 * The `GitClient` an Analysis hands to the `git-refs` driver (ls-remote only). It meters nothing
 * itself: the Analysis wraps it per connection with `meteredGitClient`, which pre-acquires the one
 * unit of each ls-remote in the git bucket the adapter declared (JOB-041).
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
