/**
 * variables facet (FAC-VAR). Pure: no I/O, no provider vocabulary (GLO-002).
 *
 * Decisions: docs/adr/0145-environments-variables-secrets-facets.md.
 */
import { type Variables, variablesFacet } from '@git-migrator/canonical';
import {
  diffDocuments,
  type FacetDefinition,
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
  targetEnvironments,
  translateScoped,
  uniqueSorted,
} from '../scoped/index.ts';

export const VARIABLES_UPPERCASE_NAMES = 'variables.uppercase-names';
export const VARIABLES_NAME_INVALID = 'variables.name-invalid';

const itemPath = (key: string, ...rest: string[]) =>
  joinFieldPath('', itemSeg('variables', 'key', key), ...rest.map(seg));

export function normalizeVariables(data: Variables): Variables {
  return { variables: data.variables.map((v) => ({ ...v })) };
}

export function translateVariables(
  source: Variables,
  ctx: TranslateContext,
): TranslationResult<Variables> {
  const values = new Map(source.variables.map((v) => [v.key, v.value]));
  const { kept, invalid } = translateScoped(source.variables, targetEnvironments(ctx));
  const decisions: FieldDecision[] = [];
  const preTasks: Finding[] = [];

  const variables = kept.map((k) => {
    if (k.renamed) {
      decisions.push({
        path: itemPath(k.key, 'name'),
        fidelity: 'lossy',
        policyKey: VARIABLES_UPPERCASE_NAMES,
        accepted: false,
      });
    }
    return { key: k.key, scope: k.scope, name: k.name, value: values.get(k.sourceKey) ?? '' };
  });
  if (invalid.length > 0) {
    preTasks.push({
      code: VARIABLES_NAME_INVALID,
      paths: invalid.map((i) => itemPath(i.key)),
      params: { names: uniqueSorted(invalid.map((i) => i.name)) },
    });
  }
  return { desired: { variables }, decisions, blockers: [], preTasks, postTasks: [], warnings: [] };
}

export function compareVariables(desired: Variables, actual: Variables): FieldDiff[] {
  const aligned = { variables: alignToDesired(desired.variables, actual.variables) };
  return diffDocuments(desired, aligned, variablesFacet.documentSchema);
}

export const variablesDefinition: FacetDefinition<Variables> = {
  key: variablesFacet.key,
  scope: variablesFacet.scope,
  schemaVersion: variablesFacet.schemaVersion,
  schema: variablesFacet.schema,
  compareMode: 'full',
  collections: variablesFacet.collections,
  sets: variablesFacet.sets,
  dependsOn: ['environments'],
  inScope: true,
  normalize: normalizeVariables,
  translate: translateVariables,
  compare: (desired, actual) => compareVariables(desired, actual),
  findingCodes: {
    'variables.accept-lossy': { kind: 'pre', completion: 'accept' },
    [VARIABLES_NAME_INVALID]: { kind: 'pre' },
  },
  policyKeys: [VARIABLES_UPPERCASE_NAMES],
};
