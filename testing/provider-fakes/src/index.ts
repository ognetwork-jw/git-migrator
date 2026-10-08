export const PACKAGE_NAME = '@git-migrator/provider-fakes';

export type { FakeBitbucket, FakeBitbucketOptions } from './bitbucket/index.ts';
export * as bitbucket from './bitbucket/index.ts';
export { createFakeBitbucket } from './bitbucket/index.ts';
export * from './git/index.ts';
export { type RunningFakes, type StartOptions, startFakes } from './start.ts';
