/** Static capabilities of the GitHub adapter (ADP-014), from the mapping tables in 05-facets. */
import type { ProviderCapabilities } from '@git-migrator/adapter-sdk';
import type { FacetCapability } from '@git-migrator/core';

const cap = (write: boolean, fields: FacetCapability['fields'] = {}): FacetCapability => ({
  read: true,
  write,
  fields,
});

export const capabilities: ProviderCapabilities = {
  facets: {
    // Refs are written by git push and the default branch call, not by a driver.
    'git-refs': cap(false),
    'repository-settings': cap(true, { '/forking': { kind: 'supported' } }),
    'merge-settings': cap(true, {
      '/allowed': { kind: 'constrained', constraint: 'merge-commit, squash, rebase' },
    }),
    'access-control': cap(true),
    'branch-rules': cap(true, {
      '/rules/enforcement': { kind: 'constrained', constraint: 'always enforced' },
      '/rules/forcePushExempt': { kind: 'supported' },
      '/rules/deletionExempt': { kind: 'unsupported', note: 'no per-actor deletion exemption' },
      '/rules/restrictMerges': { kind: 'unsupported', note: 'merging is a push' },
      '/rules/changeRequest/minApprovals': { kind: 'constrained', constraint: 'max 6' },
      '/rules/changeRequest/minPassingBuilds': {
        kind: 'unsupported',
        note: 'check names are unknown before CI has run',
      },
    }),
    webhooks: cap(true, { '/hooks/secret': { kind: 'unreadable' } }),
    'deploy-keys': cap(true),
    variables: cap(true),
    // Values are never written (FAC-SEC-001); names are read.
    secrets: cap(false),
    environments: cap(true, {
      '/environments/category': { kind: 'unsupported', note: 'no category' },
    }),
    // Delivered through a Change Request (FAC-PIP-003).
    pipelines: cap(false),
    'code-ownership': cap(true),
    'change-requests': cap(false),
    members: cap(false),
    teams: cap(true),
    'org-variables': cap(true),
    'org-secrets': cap(false),
    'org-webhooks': cap(true, { '/hooks/secret': { kind: 'unreadable' } }),
  },
};
