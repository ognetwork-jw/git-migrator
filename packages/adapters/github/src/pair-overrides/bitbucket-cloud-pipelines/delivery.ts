/**
 * The files of the pipelines Change Request (LIF-047, FAC-PIP-003): the generated workflows, and
 * the original source file kept beside them for review. The translation is deterministic, so this
 * recomputes what `translate` hashed into `desired.files[].sha256`; the lifecycle calls it from
 * the `change-requests.open` step through the registry, with the text it read from the source.
 * Decisions: docs/adr/0160-pipelines-facet.md, docs/adr/0380-migration-steps.md.
 */
import { SOURCE_FILE } from './constants.ts';
import { variableNames } from './names.ts';
import { translatePipelinesYaml } from './translate.ts';

/** Where the original file is delivered, so a reviewer can compare it with the workflows. */
export const ORIGINAL_PIPELINES_PATH = `.github/git-migrator/${SOURCE_FILE}`;

export interface PipelinesDeliveryInput {
  /** The text of the source pipeline file. */
  readonly text: string;
  /** The `desired` documents of the `variables` and `secrets` Facets. */
  readonly variables?: unknown;
  readonly secrets?: unknown;
  /** Workspace-level names (the endpoint Facets). */
  readonly workspaceVariables?: readonly unknown[];
  readonly workspaceSecrets?: readonly unknown[];
}

export interface PipelinesDeliveryResult {
  /** The Change Request purpose; its branch is `git-migrator/<purpose>`. */
  readonly purpose: string;
  readonly title: string;
  readonly body: string;
  readonly files: readonly { path: string; content: string }[];
}

/** FAC-PIP-003: the delivery branch is `git-migrator/ci` (`DELIVERY_BRANCH`). */
export const PIPELINES_PURPOSE = 'ci';

export function renderPipelinesDelivery(input: PipelinesDeliveryInput): PipelinesDeliveryResult {
  const names = variableNames(input.variables, input.secrets, {
    ...(input.workspaceVariables ? { variables: input.workspaceVariables } : {}),
    ...(input.workspaceSecrets ? { secrets: input.workspaceSecrets } : {}),
  });
  const translated = translatePipelinesYaml(input.text, names);
  return {
    purpose: PIPELINES_PURPOSE,
    title: 'Add GitHub Actions workflows (git-migrator)',
    body: [
      'This change request was opened by git-migrator. It adds the GitHub Actions workflows translated from the pipeline definition of the source repository.',
      `The original file is kept as \`${ORIGINAL_PIPELINES_PATH}\` so you can compare it with the workflows. Review the workflows, finish any construct that was not translated, and merge.`,
    ].join('\n\n'),
    files: [
      ...translated.workflows.map((w) => ({ path: w.path, content: w.content })),
      { path: ORIGINAL_PIPELINES_PATH, content: input.text },
    ],
  };
}

/** The registry's handle (`ProviderRegistry.pipelinesDelivery`). */
export const bitbucketCloudToGithubPipelinesDelivery = {
  source: 'bitbucket-cloud',
  target: 'github',
  render: renderPipelinesDelivery,
} as const;
