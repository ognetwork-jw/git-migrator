/**
 * pipelines facet (FAC-PIP). Pure: no I/O, no provider vocabulary (GLO-002).
 *
 * This module is the provider-neutral part: normalization, the parity rule (FAC-PIP-004), the
 * finding codes and the fail-closed default translation. The translation that produces workflows
 * is a pair override (FAC-PIP-002) that owns the provider vocabulary and lives in an adapter
 * package. Decisions: docs/adr/0160-pipelines-facet.md.
 */
import { type Pipelines, pipelinesFacet } from '@git-migrator/canonical';
import {
  diffDocuments,
  type FacetDefinition,
  type FieldDiff,
  type TranslateContext,
  type TranslationResult,
} from '@git-migrator/core';

export const PIPELINES_REVIEW_AND_MERGE = 'pipelines.review-and-merge';
export const PIPELINES_COMPLETE_TRANSLATION = 'pipelines.complete-translation';
export const PIPELINES_DISABLED = 'pipelines.disabled';

/**
 * FAC-PIP-002 invariant: `translation.supported` is true only when nothing is unsupported, and the
 * lists are sorted and deduplicated. Files are keyed by path (ADP-021 sorts them).
 */
export function normalizePipelines(data: Pipelines): Pipelines {
  const unsupported = [...new Set(data.translation.unsupported)].sort();
  return {
    files: data.files.map((f) => ({ path: f.path, sha256: f.sha256 })),
    enabled: data.enabled,
    translation: { supported: data.translation.supported && unsupported.length === 0, unsupported },
  };
}

/**
 * FAC-PIP-004: only `files[].path` is compared, and only in one direction: equal when the target
 * contains every desired path. Extra target files, `sha256` (the human owns the content once it is
 * merged), `enabled` and `translation` never produce a difference.
 */
export function comparePipelines(desired: Pipelines, actual: Pipelines): FieldDiff[] {
  const wanted = new Set(desired.files.map((f) => f.path));
  return diffDocuments(
    { files: desired.files.map((f) => ({ path: f.path })) },
    { files: actual.files.filter((f) => wanted.has(f.path)).map((f) => ({ path: f.path })) },
    { collections: pipelinesFacet.collections },
  );
}

/**
 * Both delivery tasks complete by parity once the target holds every generated workflow path. A
 * task that lists no generated path (nothing was generated) can never complete by parity: an empty
 * set is trivially "equal", which must not close the task.
 */
export function isPipelinesTaskSatisfied(
  task: { code: string; params: unknown },
  target: Pipelines,
  parity: readonly FieldDiff[],
): boolean {
  const params = task.params as { workflowPaths?: unknown } | null;
  const wanted = params?.workflowPaths;
  if (!Array.isArray(wanted) || wanted.length === 0) return false;
  const have = new Set(target.files.map((f) => f.path));
  return (
    wanted.every((p) => typeof p === 'string' && have.has(p)) &&
    parity.every((d) => !d.path.startsWith('/files'))
  );
}

/**
 * The default translation, used by every pair without an override. A pipeline definition cannot be
 * assumed to run on another provider, so nothing is generated and the source file is reported as a
 * construct nobody translated (fail closed).
 */
export function translatePipelines(
  source: Pipelines,
  ctx: TranslateContext,
): TranslationResult<Pipelines> {
  const none = (enabled: boolean, supported: boolean, unsupported: string[]) => ({
    files: [],
    enabled,
    translation: { supported, unsupported },
  });
  const empty = { decisions: [], blockers: [], preTasks: [], postTasks: [], warnings: [] };

  if (ctx.sourceCaps.fields['/files']?.kind === 'unreadable') {
    return {
      ...empty,
      desired: none(source.enabled, true, []),
      decisions: [
        {
          path: '/files',
          fidelity: 'unreadable',
          defaulted: true,
          accepted: false,
          note: 'unreadable_defaulted',
        },
      ],
    };
  }
  if (source.files.length === 0) {
    return { ...empty, desired: none(source.enabled, true, []) };
  }
  if (!source.enabled) {
    return {
      ...empty,
      desired: none(false, true, []),
      warnings: [{ code: PIPELINES_DISABLED, paths: ['/enabled'], params: {} }],
    };
  }
  const unsupported = source.files.map((f) => f.path).sort();
  return {
    ...empty,
    desired: none(true, false, unsupported),
    decisions: [{ path: '/translation/unsupported', fidelity: 'unsupported', accepted: false }],
    postTasks: [
      {
        code: PIPELINES_COMPLETE_TRANSLATION,
        paths: ['/translation/unsupported'],
        params: { unsupported, workflowPath: unsupported.join(', '), workflowPaths: [] },
        verifiable: true,
      },
    ],
  };
}

export const pipelinesDefinition: FacetDefinition<Pipelines> = {
  key: pipelinesFacet.key,
  scope: pipelinesFacet.scope,
  schemaVersion: pipelinesFacet.schemaVersion,
  schema: pipelinesFacet.schema,
  compareMode: 'full',
  collections: pipelinesFacet.collections,
  sets: pipelinesFacet.sets,
  dependsOn: ['git-refs', 'variables', 'secrets'],
  inScope: true,
  normalize: normalizePipelines,
  translate: translatePipelines,
  compare: (desired, actual) => comparePipelines(desired, actual),
  findingCodes: {
    [PIPELINES_REVIEW_AND_MERGE]: { kind: 'post', completion: 'parity' },
    [PIPELINES_COMPLETE_TRANSLATION]: { kind: 'post', completion: 'parity' },
    [PIPELINES_DISABLED]: { kind: 'warning' },
  },
  policyKeys: [],
  isTaskSatisfied: isPipelinesTaskSatisfied,
};
