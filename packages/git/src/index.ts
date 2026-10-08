/** @git-migrator/git: typed wrapper around the git and git-lfs CLIs (ARC-010). */
export const PACKAGE_NAME = '@git-migrator/git';

export {
  ASKPASS_DIR_PREFIX,
  type AskpassCredential,
  normalizeRemoteUrl,
  remoteHost,
  sweepStaleCredentialFiles,
} from './askpass.ts';
export {
  BLOB_LARGE,
  BLOB_TOO_LARGE,
  type BlobFinding,
  type BlobScanResult,
  DEFAULT_BLOB_WARN_BYTES,
} from './blobs.ts';
export {
  classifyGitFailure,
  GitCommandError,
  type GitFailureClass,
  type GitFailureReason,
  isGitCommandError,
} from './errors.ts';
export { GitSecretInArgvError, type SpawnFunction } from './exec.ts';
export {
  type LfsBatchClient,
  type LfsBatchObject,
  type LfsObject,
  type LfsParityResult,
  type LfsTransferResult,
  lfsBytes,
  verifyLfsParity,
} from './lfs.ts';
export { parseLsRemote } from './ls-remote.ts';
export { type EstimatorMode, type PackEstimator, supportsDiskUsage } from './pack-size.ts';
export {
  type BatchedPushInput,
  BRANCH_GROUP_SIZE,
  DEFAULT_MAX_PUSH_BYTES,
  type LocalRef,
  type PushDeps,
  type PushEvent,
  type PushKind,
  type PushReport,
  pushBatched,
  TAG_GROUP_SIZE,
} from './push.ts';
export {
  createGitQuota,
  GIT_UNITS,
  type GitQuota,
  type GitQuotaOptions,
  LFS_OBJECTS_PER_UNIT,
  lfsUnits,
} from './quota.ts';
export { scratchNeededBytes } from './scratch.ts';
export {
  assertDeletableRef,
  GitService,
  type GitServiceOptions,
  type LfsRequest,
  type MirrorRequest,
  type MirrorResult,
  type PushRefsRequest,
} from './service.ts';
