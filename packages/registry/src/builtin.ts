/** The v1 composition: every built-in Facet, both adapters and the pair overrides the spec lists. */
import {
  bitbucketCloudAdapter,
  limits as bitbucketCloudLimits,
} from '@git-migrator/adapter-bitbucket-cloud';
import {
  bitbucketCloudToGithubPipelines,
  bitbucketCloudToGithubPipelinesDelivery,
  createGitHubAdapter,
  githubAdapter,
  githubLimits,
} from '@git-migrator/adapter-github';
import type { RepositoryRef } from '@git-migrator/adapter-sdk';
import {
  accessControl,
  branchRulesDefinition,
  changeRequestsDefinition,
  codeOwnership,
  deployKeysDefinition,
  environmentsDefinition,
  extrasDefinition,
  gitRefsDefinition,
  membersDefinition,
  mergeSettingsDefinition,
  orgSecretsDefinition,
  orgVariablesDefinition,
  orgWebhooksDefinition,
  pipelinesDefinition,
  repositorySettingsDefinition,
  secretsDefinition,
  teamsDefinition,
  variablesDefinition,
  webhooksDefinition,
} from '@git-migrator/facets';
import { ProviderRegistry } from './registry.ts';

export interface BuiltinRegistryOptions {
  /** Link to the Migration of a target repository, appended to Change Request bodies (LIF-047). */
  readonly migrationUrl?: (repo: RepositoryRef) => string | undefined;
}

export function createBuiltinRegistry(options: BuiltinRegistryOptions = {}): ProviderRegistry {
  const github = options.migrationUrl
    ? createGitHubAdapter({ migrationUrl: options.migrationUrl })
    : githubAdapter;
  return new ProviderRegistry({
    facets: [
      gitRefsDefinition,
      repositorySettingsDefinition,
      mergeSettingsDefinition,
      accessControl,
      branchRulesDefinition,
      webhooksDefinition,
      deployKeysDefinition,
      variablesDefinition,
      secretsDefinition,
      environmentsDefinition,
      pipelinesDefinition,
      codeOwnership,
      changeRequestsDefinition,
      extrasDefinition,
      membersDefinition,
      teamsDefinition,
      orgVariablesDefinition,
      orgSecretsDefinition,
      orgWebhooksDefinition,
    ] as never[],
    adapters: [bitbucketCloudAdapter, github],
    limits: {
      [bitbucketCloudAdapter.type]: bitbucketCloudLimits,
      [github.type]: githubLimits,
    },
    overrides: [bitbucketCloudToGithubPipelines as never],
    deliveries: [bitbucketCloudToGithubPipelinesDelivery],
  });
}
