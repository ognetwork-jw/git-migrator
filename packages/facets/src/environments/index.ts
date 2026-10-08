/**
 * environments facet (FAC-ENV). Pure: no I/O, no provider vocabulary (GLO-002).
 *
 * Decisions: docs/adr/0145-environments-variables-secrets-facets.md.
 */
import { type Environments, environmentsFacet } from '@git-migrator/canonical';
import {
  diffDocuments,
  type FacetDefinition,
  type FieldDecision,
  type FieldDiff,
  type Finding,
  itemSeg,
  joinFieldPath,
  seg,
  type TranslationResult,
} from '@git-migrator/core';
import { uniqueSorted } from '../scoped/index.ts';

export const ENV_CATEGORY_DROPPED = 'environments.category-dropped';
export const ENV_NAME_COLLISION = 'environments.name-collision';

type Environment = Environments['environments'][number];

const envPath = (name: string, ...rest: string[]) =>
  joinFieldPath('', itemSeg('environments', 'name', name), ...rest.map(seg));

export function normalizeEnvironments(data: Environments): Environments {
  return {
    environments: data.environments.map((e) => ({
      name: e.name,
      category: e.category,
      deploymentBranches: e.deploymentBranches === null ? null : uniqueSorted(e.deploymentBranches),
    })),
  };
}

export function translateEnvironments(source: Environments): TranslationResult<Environments> {
  const decisions: FieldDecision[] = [];
  const preTasks: Finding[] = [];

  // The target tells names apart case-insensitively. The first of a group of names that differ only
  // by case (code-unit order) is kept; the pre task asks the user to rename in the source.
  const groups = new Map<string, Environment[]>();
  for (const e of source.environments) {
    const id = e.name.toLowerCase();
    groups.set(id, [...(groups.get(id) ?? []), e]);
  }
  const kept: Environment[] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const [first, ...dropped] = sorted;
    if (first === undefined) continue;
    kept.push(first);
    if (dropped.length > 0) {
      preTasks.push({
        code: ENV_NAME_COLLISION,
        paths: sorted.map((e) => envPath(e.name)),
        params: { names: sorted.map((e) => e.name) },
      });
      for (const d of dropped) {
        decisions.push({ path: envPath(d.name), fidelity: 'unsupported', accepted: false });
      }
    }
  }

  const environments = kept.map((e): Environment => {
    if (e.category !== null) {
      decisions.push({
        path: envPath(e.name, 'category'),
        fidelity: 'lossy',
        policyKey: ENV_CATEGORY_DROPPED,
        accepted: false,
      });
    }
    if (e.deploymentBranches !== null) {
      decisions.push({
        path: envPath(e.name, 'deploymentBranches'),
        fidelity: 'translated',
        accepted: false,
      });
    }
    return { name: e.name, category: null, deploymentBranches: e.deploymentBranches };
  });

  return {
    desired: { environments },
    decisions,
    blockers: [],
    preTasks,
    postTasks: [],
    warnings: [],
  };
}

/** Names are compared case-insensitively: the target's casing never counts as drift. */
export function compareEnvironments(desired: Environments, actual: Environments): FieldDiff[] {
  const byFold = new Map(desired.environments.map((e) => [e.name.toLowerCase(), e.name]));
  const aligned: Environments = {
    environments: actual.environments.map((e) => ({
      ...e,
      name: byFold.get(e.name.toLowerCase()) ?? e.name,
    })),
  };
  return diffDocuments(desired, aligned, environmentsFacet.documentSchema);
}

export const environmentsDefinition: FacetDefinition<Environments> = {
  key: environmentsFacet.key,
  scope: environmentsFacet.scope,
  schemaVersion: environmentsFacet.schemaVersion,
  schema: environmentsFacet.schema,
  compareMode: 'full',
  collections: environmentsFacet.collections,
  sets: environmentsFacet.sets,
  dependsOn: [],
  inScope: true,
  normalize: normalizeEnvironments,
  translate: (source) => translateEnvironments(source),
  compare: (desired, actual) => compareEnvironments(desired, actual),
  findingCodes: {
    'environments.accept-lossy': { kind: 'pre', completion: 'accept' },
    [ENV_NAME_COLLISION]: { kind: 'pre' },
  },
  policyKeys: [ENV_CATEGORY_DROPPED],
};
