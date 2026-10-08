/**
 * org-secrets facet (FAC-END org-variables, FAC-SEC-001): the names of the organization secrets.
 * Values are never read, stored or migrated; the facet only knows names. Pure: no I/O, no provider
 * vocabulary (GLO-002).
 *
 * Decisions: docs/adr/0151-org-variables-secrets-facets.md.
 */
import { type OrgSecrets, orgSecretsFacet } from '@git-migrator/canonical';
import {
  type FacetDefinition,
  type FacetTaskRef,
  type FieldDecision,
  type FieldDiff,
  type Finding,
  formatFieldPath,
  itemSeg,
  seg,
  type TranslateContext,
  type TranslationResult,
} from '@git-migrator/core';
import { diffDesiredOnly, paramStrings, translateNames } from '../endpoint-support.ts';

export const ORG_SECRETS_SET_VALUE = 'org-secrets.set-value';
export const ORG_SECRETS_NAME_INVALID = 'org-secrets.name-invalid';

const itemPath = (name: string, ...rest: string[]) =>
  formatFieldPath([itemSeg('secrets', 'name', name), ...rest.map(seg)]);

export function normalizeOrgSecrets(data: OrgSecrets): OrgSecrets {
  return { secrets: data.secrets.map((s) => ({ ...s })) };
}

export function translateOrgSecrets(
  source: OrgSecrets,
  _ctx: TranslateContext,
): TranslationResult<OrgSecrets> {
  const { kept, invalid } = translateNames(source.secrets);
  const decisions: FieldDecision[] = [];
  const preTasks: Finding[] = [];
  const postTasks: Finding[] = [];

  // The target stores secret names in upper case itself, so this is a translation, not a loss.
  for (const k of kept) {
    if (k.renamed) {
      decisions.push({ path: itemPath(k.name, 'name'), fidelity: 'translated', accepted: false });
    }
  }
  if (invalid.length > 0) {
    preTasks.push({
      code: ORG_SECRETS_NAME_INVALID,
      paths: invalid.map((name) => itemPath(name)),
      params: { names: invalid },
    });
  }
  // FAC-SEC-001: never a placeholder value; one post task lists the names to set by hand.
  if (kept.length > 0) {
    postTasks.push({
      code: ORG_SECRETS_SET_VALUE,
      paths: kept.map((k) => itemPath(k.name)),
      params: { names: kept.map((k) => k.name) },
    });
  }
  return {
    desired: { secrets: kept.map((k) => ({ name: k.name })) },
    decisions,
    blockers: [],
    preTasks,
    postTasks,
    warnings: [],
  };
}

/** Parity compares names and ignores target-only secrets: the organization keeps its own. */
export function compareOrgSecrets(desired: OrgSecrets, actual: OrgSecrets): FieldDiff[] {
  return diffDesiredOnly(desired, actual, orgSecretsFacet.documentSchema);
}

/** The task is done once every listed name exists on the target (case-insensitive). */
export function isOrgSecretsTaskSatisfied(task: FacetTaskRef, target: OrgSecrets): boolean {
  if (task.code !== ORG_SECRETS_SET_VALUE) return false;
  const names = paramStrings(task.params, 'names');
  if (names === undefined || names.length === 0) return false;
  const present = new Set(target.secrets.map((s) => s.name.toUpperCase()));
  return names.every((n) => present.has(n.toUpperCase()));
}

export const orgSecretsDefinition: FacetDefinition<OrgSecrets> = {
  key: orgSecretsFacet.key,
  scope: orgSecretsFacet.scope,
  schemaVersion: orgSecretsFacet.schemaVersion,
  schema: orgSecretsFacet.schema,
  compareMode: 'full',
  collections: orgSecretsFacet.collections,
  sets: orgSecretsFacet.sets,
  dependsOn: [],
  inScope: true,
  normalize: normalizeOrgSecrets,
  translate: translateOrgSecrets,
  compare: (desired, actual) => compareOrgSecrets(desired, actual),
  findingCodes: {
    [ORG_SECRETS_NAME_INVALID]: { kind: 'pre' },
    [ORG_SECRETS_SET_VALUE]: { kind: 'post', completion: 'parity' },
  },
  policyKeys: [],
  isTaskSatisfied: (task, target) => isOrgSecretsTaskSatisfied(task, target),
};
