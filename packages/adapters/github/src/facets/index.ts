/** All GitHub facet drivers (ADP-011). */
import type { EndpointConnection } from '@git-migrator/adapter-sdk';
import { accessControlDriver, codeOwnershipDriver } from './access.ts';
import { branchRulesDriver } from './branch-rules.ts';
import type { DriverDeps } from './common.ts';
import { orgWebhooksDriver, webhooksDriver } from './hooks.ts';
import { changeRequestsDriver, membersDriver, pipelinesDriver, teamsDriver } from './misc.ts';
import { gitRefsDriver, mergeSettingsDriver, repositorySettingsDriver } from './repo.ts';
import {
  deployKeysDriver,
  environmentsDriver,
  orgSecretsDriver,
  orgVariablesDriver,
  secretsDriver,
  variablesDriver,
} from './settings.ts';

export type { DriverDeps } from './common.ts';

/** `extras` is detect-only on the source and has no GitHub driver (ADR-0231). */
export function buildDrivers(deps: DriverDeps): EndpointConnection['facets'] {
  return {
    'git-refs': gitRefsDriver(deps),
    'repository-settings': repositorySettingsDriver(deps),
    'merge-settings': mergeSettingsDriver(deps),
    'access-control': accessControlDriver(deps),
    'branch-rules': branchRulesDriver(deps),
    webhooks: webhooksDriver(deps),
    'deploy-keys': deployKeysDriver(deps),
    variables: variablesDriver(deps),
    secrets: secretsDriver(deps),
    environments: environmentsDriver(deps),
    pipelines: pipelinesDriver(deps),
    'code-ownership': codeOwnershipDriver(deps),
    'change-requests': changeRequestsDriver(deps),
    members: membersDriver(deps),
    teams: teamsDriver(deps),
    'org-variables': orgVariablesDriver(deps),
    'org-secrets': orgSecretsDriver(deps),
    'org-webhooks': orgWebhooksDriver(deps),
  } as EndpointConnection['facets'];
}
