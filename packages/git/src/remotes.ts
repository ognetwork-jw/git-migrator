/**
 * Remote names used inside the mirror. `origin` is created by `git clone --mirror` and holds the
 * source URL (no credentials). The target remote exists only in the child's environment
 * (`GIT_CONFIG_*`), never in `.git/config`, so `git lfs push` can name it.
 */
export const GIT_REMOTE_SOURCE = 'origin';
export const GIT_REMOTE_TARGET = 'gm-target';
