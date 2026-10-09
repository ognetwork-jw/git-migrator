/** Git transport access (ADP-070). Credentials are values; they never go into the URL. */
import { AdapterError, type GitAccess, type RepositoryRef } from '@git-migrator/adapter-sdk';
import { type BitbucketCredential, DEFAULT_GIT_USERNAME, PROVIDER } from './config.ts';
import { bucketSpec, type QuotaSetup } from './quota.ts';

export function createGitAccess(options: {
  workspace: string;
  gitBaseUrl: string;
  credential: BitbucketCredential;
  /** The credential's quota identity; with it, git requests count in the `git` bucket (JOB-043). */
  quota?: QuotaSetup;
}): GitAccess {
  const base = new URL(options.gitBaseUrl);
  if (base.username !== '' || base.password !== '') {
    throw new AdapterError({
      code: 'invalid',
      provider: PROVIDER,
      message: 'The git base URL must not carry credentials',
    });
  }
  const root = `${base.origin}${base.pathname.replace(/\/+$/, '')}`;
  const credential = {
    username: options.credential.gitUsername ?? DEFAULT_GIT_USERNAME,
    password: options.credential.apiToken,
  };
  return {
    remoteUrl: (repo: RepositoryRef) =>
      `${root}/${encodeURIComponent(options.workspace)}/${encodeURIComponent(repo.slug)}.git`,
    credential: async () => credential,
    ...(options.quota ? { quota: bucketSpec(options.quota, 'git') } : {}),
  };
}
