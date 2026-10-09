/** The v1 composition: every built-in Facet, both adapters and the pair overrides the spec lists. */
import {
  bitbucketCloudAdapter,
  limits as bitbucketCloudLimits,
} from '@git-migrator/adapter-bitbucket-cloud';
import {
  bitbucketCloudToGithubPipelines,
  bitbucketCloudToGithubPipelinesDelivery,
  githubAdapter,
  githubLimits,
} from '@git-migrator/adapter-github';
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

export function createBuiltinRegistry(): ProviderRegistry {
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
    adapters: [bitbucketCloudAdapter, githubAdapter],
    limits: {
      [bitbucketCloudAdapter.type]: bitbucketCloudLimits,
      [githubAdapter.type]: githubLimits,
    },
    overrides: [bitbucketCloudToGithubPipelines as never],
    deliveries: [bitbucketCloudToGithubPipelinesDelivery],
  });
}
