/**
 * secrets facet (FAC-SEC). Pure: no I/O, no provider vocabulary (GLO-002).
 *
 * Secret values are never readable, never part of a document and never migrated; the facet only
 * knows names. Decisions: docs/adr/0145-environments-variables-secrets-facets.md.
 */
import { type Secrets, secretsFacet } from '@git-migrator/canonical';
import {
  diffDocuments,
  type FacetDefinition,
  type FacetTaskRef,
  type FieldDecision,
  type FieldDiff,
  type Finding,
  itemSeg,
  joinFieldPath,
  seg,
  type TranslateContext,
  type TranslationResult,
} from '@git-migrator/core';
import {
  alignToDesired,
  environmentOf,
  foldScope,
  targetEnvironments,
  translateScoped,
  uniqueSorted,
} from '../scoped/index.ts';

export const SECRETS_SET_VALUE = 'secrets.set-value';
export const SECRETS_NAME_INVALID = 'secrets.name-invalid';

const itemPath = (key: string, ...rest: string[]) =>
  joinFieldPath('', itemSeg('secrets', 'key', key), ...rest.map(seg));

export function normalizeSecrets(data: Secrets): Secrets {
  return { secrets: data.secrets.map((s) => ({ ...s })) };
}

export function translateSecrets(
  source: Secrets,
  ctx: TranslateContext,
): TranslationResult<Secrets> {
  const { kept, invalid } = translateScoped(source.secrets, targetEnvironments(ctx));
  const decisions: FieldDecision[] = [];
  const preTasks: Finding[] = [];
  const postTasks: Finding[] = [];

  // The target stores secret names in upper case itself, so this is a translation, not a loss.
  for (const k of kept) {
    if (k.renamed) {
      decisions.push({ path: itemPath(k.key, 'name'), fidelity: 'translated', accepted: false });
    }
  }
  if (invalid.length > 0) {
    preTasks.push({
      code: SECRETS_NAME_INVALID,
      paths: invalid.map((i) => itemPath(i.key)),
      params: { names: uniqueSorted(invalid.map((i) => i.name)) },
    });
  }

  // FAC-SEC-001: one post task per scope, listing the names to set by hand.
  const scopes = new Map<string, typeof kept>();
  for (const k of kept) scopes.set(k.scope, [...(scopes.get(k.scope) ?? []), k]);
  for (const [scope, list] of [...scopes].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const environment = environmentOf(scope);
    postTasks.push({
      code: SECRETS_SET_VALUE,
      paths: list.map((k) => itemPath(k.key)),
      params: {
        scope,
        names: uniqueSorted(list.map((k) => k.name)),
        ...(environment === null ? {} : { environment }),
      },
    });
  }

  return {
    desired: { secrets: kept.map((k) => ({ key: k.key, scope: k.scope, name: k.name })) },
    decisions,
    blockers: [],
    preTasks,
    postTasks,
    warnings: [],
  };
}

/** Parity compares names; the casing of an environment or name on the target never counts. */
export function compareSecrets(desired: Secrets, actual: Secrets): FieldDiff[] {
  const aligned = { secrets: alignToDesired(desired.secrets, actual.secrets) };
  return diffDocuments(desired, aligned, secretsFacet.documentSchema);
}

/** FAC-SEC-001: the task is done once every listed name exists in its scope on the target. */
export function isSecretsTaskSatisfied(task: FacetTaskRef, target: Secrets): boolean {
  if (task.code !== SECRETS_SET_VALUE) return false;
  const params = task.params as { scope?: unknown; names?: unknown } | null;
  if (typeof params?.scope !== 'string' || !Array.isArray(params.names)) return false;
  if (params.names.length === 0 || !params.names.every((n) => typeof n === 'string')) return false;
  const scope = foldScope(params.scope);
  const present = new Set(
    target.secrets.filter((s) => foldScope(s.scope) === scope).map((s) => s.name.toUpperCase()),
  );
  return (params.names as string[]).every((n) => present.has(n.toUpperCase()));
}

export const secretsDefinition: FacetDefinition<Secrets> = {
  key: secretsFacet.key,
  scope: secretsFacet.scope,
  schemaVersion: secretsFacet.schemaVersion,
  schema: secretsFacet.schema,
  compareMode: 'full',
  collections: secretsFacet.collections,
  sets: secretsFacet.sets,
  dependsOn: ['environments'],
  inScope: true,
  normalize: normalizeSecrets,
  translate: translateSecrets,
  compare: (desired, actual) => compareSecrets(desired, actual),
  findingCodes: {
    [SECRETS_NAME_INVALID]: { kind: 'pre' },
    [SECRETS_SET_VALUE]: { kind: 'post', completion: 'parity' },
  },
  policyKeys: [],
  isTaskSatisfied: (task, target) => isSecretsTaskSatisfied(task, target),
};
