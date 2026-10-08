import { spawnSync } from 'node:child_process';

/** Minimum git for `--initial-branch`, `GIT_CONFIG_COUNT` and protocol v2 behavior the fakes rely on. */
export const MIN_GIT_VERSION: [number, number] = [2, 31];

/**
 * Throws a clear error when the `git` CLI is missing or too old, or (with `lfs: true`) when the
 * `git-lfs` CLI is missing. The server itself only needs git; tests that run LFS need both.
 */
export function assertGitPrerequisites(options: { lfs?: boolean } = {}): void {
  const git = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (git.error || git.status !== 0) {
    throw new Error(
      'The fake git server needs the `git` CLI on PATH (>= 2.31), but it was not found',
    );
  }
  const m = /(\d+)\.(\d+)/.exec(git.stdout);
  const [major, minor] = [Number(m?.[1]), Number(m?.[2])];
  if (
    !m ||
    major < MIN_GIT_VERSION[0] ||
    (major === MIN_GIT_VERSION[0] && minor < MIN_GIT_VERSION[1])
  ) {
    throw new Error(`The fake git server needs git >= 2.31, found: ${git.stdout.trim()}`);
  }
  if (options.lfs) {
    const lfs = spawnSync('git-lfs', ['version'], { encoding: 'utf8' });
    if (lfs.error || lfs.status !== 0) {
      throw new Error('These tests need the `git-lfs` CLI on PATH, but it was not found');
    }
  }
}
