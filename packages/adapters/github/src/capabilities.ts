/** Static capabilities of the GitHub adapter (ADP-014), from the mapping tables in 05-facets. */
import type { ProviderCapabilities } from '@git-migrator/adapter-sdk';
import type { FacetCapability, FieldSupport } from '@git-migrator/core';

const cap = (write: boolean, fields: FacetCapability['fields'] = {}): FacetCapability => ({
  read: true,
  write,
  fields,
});

/**
 * Worst-case ceiling declarations (ADR-0261). `/hooks/events` is read at run time by the webhooks
 * translator, which only acts on a constraint starting with `only:`; this text must not, or event
 * filtering would start (a test pins it).
 */
const EVENTS_DROPPED: FieldSupport = {
  kind: 'constrained',
  constraint: 'source events without a target equivalent are dropped',
};
const NAMES_UPPERCASED: FieldSupport = {
  kind: 'constrained',
  constraint: 'names are upper-cased; reserved prefixes and collisions are rejected',
};

export const capabilities: ProviderCapabilities = {
  facets: {
    // Refs are written by git push and the default branch call, not by a driver.
    'git-refs': cap(false),
    'repository-settings': cap(true, {
      '/forking': { kind: 'supported' },
      '/description': { kind: 'constrained', constraint: 'max 350 characters' },
    }),
    'merge-settings': cap(true, {
      '/allowed': { kind: 'constrained', constraint: 'merge-commit, squash, rebase' },
    }),
    'access-control': cap(true),
    'branch-rules': cap(true, {
      '/rules/pattern': {
        kind: 'constrained',
        constraint: 'patterns are converted to the target dialect, merged or approximated',
      },
      '/rules/enforcement': { kind: 'constrained', constraint: 'always enforced' },
      '/rules/forcePushExempt': { kind: 'supported' },
      // Lossy in the mapping table (FAC-BRR-002): the exemption or restriction is approximated or dropped.
      '/rules/deletionExempt': {
        kind: 'constrained',
        constraint: 'no per-actor deletion exemption; dropped',
      },
      '/rules/restrictMerges': {
        kind: 'constrained',
        constraint: 'merging is a push; applied as the push restriction',
      },
      '/rules/changeRequest/requireTasksResolved': {
        kind: 'constrained',
        constraint: 'tasks become resolved conversations',
      },
      '/rules/changeRequest/minApprovals': { kind: 'constrained', constraint: 'max 6' },
      '/rules/changeRequest/minPassingBuilds': {
        kind: 'unsupported',
        note: 'check names are unknown before CI has run',
      },
    }),
    webhooks: cap(true, {
      '/hooks/secret': { kind: 'unreadable' },
      '/hooks/events': EVENTS_DROPPED,
    }),
    'deploy-keys': cap(true),
    variables: cap(true, { '/variables/name': NAMES_UPPERCASED }),
    // Values are never written (FAC-SEC-001); names are read.
    secrets: cap(false),
    environments: cap(true, {
      '/environments/category': { kind: 'constrained', constraint: 'no category; dropped' },
    }),
    // Delivered through a Change Request (FAC-PIP-003).
    pipelines: cap(false),
    'code-ownership': cap(true, {
      '/owners': {
        kind: 'constrained',
        constraint: 'default reviewers become code owners; owners without write access are omitted',
      },
    }),
    'change-requests': cap(false),
    members: cap(false),
    teams: cap(true),
    'org-variables': cap(true, { '/variables/name': NAMES_UPPERCASED }),
    'org-secrets': cap(false),
    'org-webhooks': cap(true, {
      '/hooks/secret': { kind: 'unreadable' },
      '/hooks/events': EVENTS_DROPPED,
    }),
  },
};
