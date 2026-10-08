/**
 * Pair override `bitbucket-cloud` to `github` for the `pipelines` facet (FAC-PIP-002, FAC-PIP-003,
 * ADP-032). It replaces the facet's default `translate`; normalization, comparison and the finding
 * declarations stay with the facet in `packages/facets`.
 *
 * Inputs the caller supplies in the (plain JSON) translate context, see
 * docs/adr/0160-pipelines-facet.md:
 * - `routeIndex.pipelines.sources`: the text of the source pipeline file by its sha256;
 * - `routeIndex.pipelines.workspaceVariables` / `workspaceSecrets`: names of workspace-level
 *   variables and secrets (optional);
 * - `deps.variables` / `deps.secrets`: the `desired` documents of those facets.
 */
import type { Pipelines } from '@git-migrator/canonical';
import {
  type FieldDecision,
  type Finding,
  type PairOverride,
  sha256Hex,
  type TranslateContext,
  type TranslationResult,
} from '@git-migrator/core';
import { SOURCE_FILE } from './constants.ts';
import { variableNames } from './names.ts';
import { translatePipelinesYaml } from './translate.ts';

export { variableNames } from './names.ts';
export { translatePipelinesYaml, type Unsupported, type Workflow } from './translate.ts';

export const PIPELINES_SOURCE_TYPE = 'bitbucket-cloud';
export const PIPELINES_TARGET_TYPE = 'github';
/** FAC-PIP-003: the branch of the Change Request that delivers the workflows. */
export const DELIVERY_BRANCH = 'git-migrator/ci';

const REVIEW_AND_MERGE = 'pipelines.review-and-merge';
const COMPLETE_TRANSLATION = 'pipelines.complete-translation';
const DISABLED = 'pipelines.disabled';

type Result = TranslationResult<Pipelines>;

function result(
  desired: Pipelines,
  extra: {
    decisions?: FieldDecision[];
    postTasks?: Finding[];
    warnings?: Finding[];
  } = {},
): Result {
  return {
    desired,
    decisions: extra.decisions ?? [],
    blockers: [],
    preTasks: [],
    postTasks: extra.postTasks ?? [],
    warnings: extra.warnings ?? [],
  };
}

function empty(enabled: boolean): Pipelines {
  return { files: [], enabled, translation: { supported: true, unsupported: [] } };
}

function sourcesOf(ctx: TranslateContext): {
  sources: Record<string, unknown>;
  variables: unknown[];
  secrets: unknown[];
} {
  const index = ctx.routeIndex.pipelines;
  const section =
    typeof index === 'object' && index !== null ? (index as Record<string, unknown>) : {};
  const sources = section.sources;
  const list = (v: unknown) => (Array.isArray(v) ? (v as unknown[]) : []);
  return {
    sources:
      typeof sources === 'object' && sources !== null ? (sources as Record<string, unknown>) : {},
    variables: list(section.workspaceVariables),
    secrets: list(section.workspaceSecrets),
  };
}

/** The translation. Throws only when the caller omits the text of a file it announced. */
export function translatePipelines(source: Pipelines, ctx: TranslateContext): Result {
  if (ctx.sourceCaps.fields['/files']?.kind === 'unreadable') {
    return result(empty(source.enabled), {
      decisions: [
        {
          path: '/files',
          fidelity: 'unreadable',
          defaulted: true,
          accepted: false,
          note: 'unreadable_defaulted',
        },
      ],
    });
  }
  if (source.files.length === 0) return result(empty(source.enabled));
  if (!source.enabled) {
    return result(empty(false), {
      warnings: [{ code: DISABLED, paths: ['/enabled'], params: {} }],
    });
  }

  const file = source.files.find((f) => f.path === SOURCE_FILE) ?? source.files[0];
  if (file === undefined) return result(empty(source.enabled));
  const input = sourcesOf(ctx);
  const text = Object.hasOwn(input.sources, file.sha256) ? input.sources[file.sha256] : undefined;
  if (typeof text !== 'string') {
    throw new Error(`routeIndex.pipelines.sources has no text for ${file.path} (${file.sha256})`);
  }
  const names = variableNames(ctx.deps.variables?.desired, ctx.deps.secrets?.desired, {
    variables: input.variables,
    secrets: input.secrets,
  });

  const translated = translatePipelinesYaml(text, names);
  const unsupported = translated.unsupported.map((u) => u.path);
  const files0 = translated.workflows.length;
  if (files0 === 0 && unsupported.length === 0) unsupported.push(SOURCE_FILE);
  const files = translated.workflows.map((w) => ({ path: w.path, sha256: sha256Hex(w.content) }));
  const desired: Pipelines = {
    files,
    enabled: true,
    translation: { supported: unsupported.length === 0, unsupported },
  };
  const workflowPaths = files.map((f) => f.path);
  const workflowPath = files.length > 0 ? files.map((f) => f.path).join(', ') : SOURCE_FILE;

  if (unsupported.length === 0 && files.length > 0) {
    return result(desired, {
      postTasks: [
        {
          code: REVIEW_AND_MERGE,
          paths: ['/files'],
          params: { workflowPath, workflowPaths, branch: DELIVERY_BRANCH },
          verifiable: true,
        },
      ],
    });
  }
  return result(desired, {
    decisions: [{ path: '/translation/unsupported', fidelity: 'unsupported', accepted: false }],
    postTasks: [
      {
        code: COMPLETE_TRANSLATION,
        paths: ['/translation/unsupported'],
        params: { unsupported, workflowPath, workflowPaths },
        verifiable: true,
      },
    ],
  });
}

export const bitbucketCloudToGithubPipelines: PairOverride<Pipelines> = {
  source: PIPELINES_SOURCE_TYPE,
  target: PIPELINES_TARGET_TYPE,
  facet: 'pipelines',
  translate: translatePipelines,
};
