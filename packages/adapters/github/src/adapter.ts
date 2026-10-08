/** The GitHub ProviderAdapter (ADP-010). */
import type { ProviderAdapter, RepositoryRef } from '@git-migrator/adapter-sdk';
import { InstallationTokenCache } from './auth.ts';
import { capabilities } from './capabilities.ts';
import { configSchema, credentialSchema, PROVIDER } from './config.ts';
import { connectGitHub } from './connection.ts';

export interface GitHubAdapterOptions {
  /** Test seam: clock for the token cache and the JWT. */
  readonly now?: () => Date;
  /** Test seam: share or inspect the installation token cache. */
  readonly cache?: InstallationTokenCache;
  /** Link to the Migration of a repository, appended to Change Request bodies (LIF-047). */
  readonly migrationUrl?: (repo: RepositoryRef) => string | undefined;
}

export function createGitHubAdapter(options: GitHubAdapterOptions = {}): ProviderAdapter {
  const now = options.now ?? (() => new Date());
  // One cache per adapter, so tokens survive from job to job (single-flight per installation).
  const cache = options.cache ?? new InstallationTokenCache(now);
  return {
    type: PROVIDER,
    displayName: 'GitHub',
    namespaceLevels: [{ kind: 'organization', label: 'Organization', holdsRepositories: true }],
    capabilities,
    configSchema,
    credentialSchema,
    connect: (endpoint, ctx) => connectGitHub(endpoint, ctx, cache, now, options.migrationUrl),
  };
}

export const githubAdapter: ProviderAdapter = createGitHubAdapter();
