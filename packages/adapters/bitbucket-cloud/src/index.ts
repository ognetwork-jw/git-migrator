/** @git-migrator/adapter-bitbucket-cloud: the Bitbucket Cloud source adapter (T-032). */
export const PACKAGE_NAME = '@git-migrator/adapter-bitbucket-cloud';

export { bitbucketCloudAdapter, capabilities, limits } from './adapter.ts';
export { TOKEN_SHAPES } from './client.ts';
export {
  type BitbucketConfig,
  type BitbucketCredential,
  configSchema,
  credentialSchema,
  DEFAULT_GIT_USERNAME,
  PROVIDER,
  RESOURCE_GROUPS,
  type ResourceGroup,
} from './config.ts';
export { createGitAccess } from './git-access.ts';
export {
  bucketSpec,
  createClassifier,
  createInterpreter,
  DEFAULT_LIMITS,
  resourceGroups,
  WINDOW_SECONDS,
} from './quota.ts';
export { SourceLockPartialError } from './source-lock.ts';
