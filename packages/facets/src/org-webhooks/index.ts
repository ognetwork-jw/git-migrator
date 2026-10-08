/**
 * org-webhooks facet (FAC-END org-webhooks): organization-wide webhooks under the same allowlist,
 * secret and payload rules as FAC-WEB. Pure: no I/O, no provider vocabulary (GLO-002).
 *
 * The rules are the repository-level `webhooks` facet's: this module only supplies its own finding
 * codes and policy key to the shared helpers (`translateHookSet`, `compareHookSet`,
 * `isHookSetTaskSatisfied`). Decisions: docs/adr/0152-org-webhooks-facet.md.
 */
import { type OrgWebhooks, orgWebhooksFacet } from '@git-migrator/canonical';
import type {
  FacetDefinition,
  FieldDiff,
  TranslateContext,
  TranslationResult,
} from '@git-migrator/core';
import {
  compareHookSet,
  type HookSetCodes,
  isHookSetTaskSatisfied,
  normalizeWebhooks,
  translateHookSet,
} from '../webhooks/index.ts';

export const ORG_WEBHOOKS_EVENT_DROPPED = 'org-webhooks.event-dropped';
export const ORG_WEBHOOKS_RECREATE_MANUALLY = 'org-webhooks.recreate-manually';
export const ORG_WEBHOOKS_SET_SECRET = 'org-webhooks.set-secret';

const CODES: HookSetCodes = {
  eventDropped: ORG_WEBHOOKS_EVENT_DROPPED,
  recreateManually: ORG_WEBHOOKS_RECREATE_MANUALLY,
  setSecret: ORG_WEBHOOKS_SET_SECRET,
};

export function normalizeOrgWebhooks(data: OrgWebhooks): OrgWebhooks {
  return normalizeWebhooks(data);
}

export function translateOrgWebhooks(
  source: OrgWebhooks,
  ctx: TranslateContext,
): TranslationResult<OrgWebhooks> {
  const { hooks, decisions, postTasks } = translateHookSet(source.hooks, ctx, CODES);
  return { desired: { hooks }, decisions, blockers: [], preTasks: [], postTasks, warnings: [] };
}

/** Hooks that exist only on the target are not a difference (ADR-0141, ADR-0150). */
export function compareOrgWebhooks(desired: OrgWebhooks, actual: OrgWebhooks): FieldDiff[] {
  return compareHookSet(desired.hooks, actual.hooks, orgWebhooksFacet.documentSchema);
}

export const orgWebhooksDefinition: FacetDefinition<OrgWebhooks> = {
  key: orgWebhooksFacet.key,
  scope: orgWebhooksFacet.scope,
  schemaVersion: orgWebhooksFacet.schemaVersion,
  schema: orgWebhooksFacet.schema,
  compareMode: 'full',
  collections: orgWebhooksFacet.collections,
  sets: orgWebhooksFacet.sets,
  dependsOn: [],
  inScope: true,
  normalize: normalizeOrgWebhooks,
  translate: translateOrgWebhooks,
  compare: (desired, actual) => compareOrgWebhooks(desired, actual),
  isTaskSatisfied: (task, target) => isHookSetTaskSatisfied(task, target.hooks, CODES),
  findingCodes: {
    [ORG_WEBHOOKS_RECREATE_MANUALLY]: { kind: 'post', completion: 'parity' },
    [ORG_WEBHOOKS_SET_SECRET]: { kind: 'post', completion: 'parity' },
    'org-webhooks.accept-lossy': { kind: 'pre', completion: 'accept' },
  },
  policyKeys: [ORG_WEBHOOKS_EVENT_DROPPED],
};
