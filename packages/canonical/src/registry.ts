/** Registry of every built-in canonical facet, and a parse helper keyed by facet key. */
import { validateCollections } from '@git-migrator/core';
import type { z } from 'zod';
import type { CanonicalFacet, FacetKey } from './common.ts';
import { accessControlFacet } from './facets/access-control.ts';
import { branchRulesFacet } from './facets/branch-rules.ts';
import { changeRequestsFacet } from './facets/change-requests.ts';
import { codeOwnershipFacet } from './facets/code-ownership.ts';
import { deployKeysFacet } from './facets/deploy-keys.ts';
import { environmentsFacet } from './facets/environments.ts';
import { extrasFacet } from './facets/extras.ts';
import { gitRefsFacet } from './facets/git-refs.ts';
import { membersFacet } from './facets/members.ts';
import { mergeSettingsFacet } from './facets/merge-settings.ts';
import { orgSecretsFacet, orgVariablesFacet, orgWebhooksFacet } from './facets/org-facets.ts';
import { pipelinesFacet } from './facets/pipelines.ts';
import { repositorySettingsFacet } from './facets/repository-settings.ts';
import { teamsFacet } from './facets/teams.ts';
import { secretsFacet, variablesFacet } from './facets/variables.ts';
import { webhooksFacet } from './facets/webhooks.ts';

export const CANONICAL_FACETS = {
  'git-refs': gitRefsFacet,
  'repository-settings': repositorySettingsFacet,
  'merge-settings': mergeSettingsFacet,
  'access-control': accessControlFacet,
  'branch-rules': branchRulesFacet,
  webhooks: webhooksFacet,
  'deploy-keys': deployKeysFacet,
  variables: variablesFacet,
  secrets: secretsFacet,
  environments: environmentsFacet,
  pipelines: pipelinesFacet,
  'code-ownership': codeOwnershipFacet,
  'change-requests': changeRequestsFacet,
  extras: extrasFacet,
  members: membersFacet,
  teams: teamsFacet,
  'org-variables': orgVariablesFacet,
  'org-secrets': orgSecretsFacet,
  'org-webhooks': orgWebhooksFacet,
} as const satisfies Record<FacetKey, CanonicalFacet>;

export type CanonicalFacets = typeof CANONICAL_FACETS;
/** The canonical document type of facet `K`. */
export type CanonicalData<K extends FacetKey> = z.output<CanonicalFacets[K]['schema']>;

export function getCanonicalFacet<K extends FacetKey>(key: K): CanonicalFacets[K] {
  return CANONICAL_FACETS[key];
}

export interface ParseIssue {
  /** Document path segments (schema failures) or a single concrete field path (collection failures). */
  readonly path: readonly (string | number)[];
  readonly message: string;
}

export type CanonicalParseResult<T> =
  | { readonly success: true; readonly data: T }
  | {
      readonly success: false;
      /** `invalid`: the document breaks the schema or ADP-021; `unsupported_version`: wrong schema version. */
      readonly reason: 'invalid' | 'unsupported_version';
      readonly error: { readonly issues: readonly ParseIssue[] };
    };

/**
 * Validates `value` against the facet's schema and against ADP-021 (declared collections: unique,
 * usable keys; declared sets: primitives). Never normalizes; returns the parsed document as is.
 * When `options.version` is given it must equal the facet's `schemaVersion`; migrating older
 * documents is out of scope until the first version bump (ADR-0088).
 */
export function parseCanonical<K extends FacetKey>(
  key: K,
  value: unknown,
  options: { version?: number } = {},
): CanonicalParseResult<CanonicalData<K>> {
  const facet = CANONICAL_FACETS[key];
  if (options.version !== undefined && options.version !== facet.schemaVersion) {
    return {
      success: false,
      reason: 'unsupported_version',
      error: {
        issues: [
          {
            path: [],
            message: `unsupported schema version ${options.version} for "${key}" (supported: ${facet.schemaVersion})`,
          },
        ],
      },
    };
  }
  const parsed = facet.schema.safeParse(value);
  if (!parsed.success) {
    return {
      success: false,
      reason: 'invalid',
      error: {
        issues: parsed.error.issues.map((i) => ({
          path: i.path as (string | number)[],
          message: i.message,
        })),
      },
    };
  }
  const issues = validateCollections(parsed.data, facet.documentSchema);
  if (issues.length > 0) {
    return {
      success: false,
      reason: 'invalid',
      error: {
        issues: issues.map((i) => ({ path: [i.path], message: `${i.code}: ${i.message}` })),
      },
    };
  }
  return { success: true, data: parsed.data as CanonicalData<K> };
}
