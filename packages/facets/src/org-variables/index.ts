/**
 * org-variables facet (FAC-END org-variables, FAC-VAR-003): Actions variables shared across the
 * target organization. Pure: no I/O, no provider vocabulary (GLO-002).
 *
 * Decisions: docs/adr/0151-org-variables-secrets-facets.md.
 */
import { type OrgVariables, orgVariablesFacet } from '@git-migrator/canonical';
import {
  type FacetDefinition,
  type FieldDecision,
  type FieldDiff,
  type Finding,
  formatFieldPath,
  itemSeg,
  seg,
  type TranslateContext,
  type TranslationResult,
} from '@git-migrator/core';
import { diffDesiredOnly, translateNames } from '../endpoint-support.ts';

export const ORG_VARIABLES_UPPERCASE_NAMES = 'org-variables.uppercase-names';
export const ORG_VARIABLES_NAME_INVALID = 'org-variables.name-invalid';

const itemPath = (name: string, ...rest: string[]) =>
  formatFieldPath([itemSeg('variables', 'name', name), ...rest.map(seg)]);

export function normalizeOrgVariables(data: OrgVariables): OrgVariables {
  return { variables: data.variables.map((v) => ({ ...v })) };
}

export function translateOrgVariables(
  source: OrgVariables,
  _ctx: TranslateContext,
): TranslationResult<OrgVariables> {
  const { kept, invalid } = translateNames(source.variables);
  const decisions: FieldDecision[] = [];
  const preTasks: Finding[] = [];

  const variables = kept.map((k) => {
    if (k.renamed) {
      decisions.push({
        path: itemPath(k.name, 'name'),
        fidelity: 'lossy',
        policyKey: ORG_VARIABLES_UPPERCASE_NAMES,
        accepted: false,
      });
    }
    return { name: k.name, value: k.value, visibility: k.visibility };
  });
  if (invalid.length > 0) {
    preTasks.push({
      code: ORG_VARIABLES_NAME_INVALID,
      paths: invalid.map((name) => itemPath(name)),
      params: { names: invalid },
    });
  }
  return {
    desired: { variables },
    decisions,
    blockers: [],
    preTasks,
    postTasks: [],
    warnings: [],
  };
}

/** Parity ignores target-only variables: the organization keeps its own (ADR-0151). */
export function compareOrgVariables(desired: OrgVariables, actual: OrgVariables): FieldDiff[] {
  return diffDesiredOnly(desired, actual, orgVariablesFacet.documentSchema);
}

export const orgVariablesDefinition: FacetDefinition<OrgVariables> = {
  key: orgVariablesFacet.key,
  scope: orgVariablesFacet.scope,
  schemaVersion: orgVariablesFacet.schemaVersion,
  schema: orgVariablesFacet.schema,
  compareMode: 'full',
  collections: orgVariablesFacet.collections,
  sets: orgVariablesFacet.sets,
  dependsOn: [],
  inScope: true,
  normalize: normalizeOrgVariables,
  translate: translateOrgVariables,
  compare: (desired, actual) => compareOrgVariables(desired, actual),
  findingCodes: {
    'org-variables.accept-lossy': { kind: 'pre', completion: 'accept' },
    [ORG_VARIABLES_NAME_INVALID]: { kind: 'pre' },
  },
  policyKeys: [ORG_VARIABLES_UPPERCASE_NAMES],
};
