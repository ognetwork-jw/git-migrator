/**
 * repository-settings facet (FAC-SET). Pure: no I/O, no provider vocabulary (GLO-002).
 *
 * Decisions: docs/adr/0102-repository-settings-facet.md.
 */
import { type RepositorySettings, repositorySettingsFacet } from '@git-migrator/canonical';
import {
  diffDocuments,
  type FacetDefinition,
  type FieldDecision,
  type FieldDiff,
  type Finding,
  type TranslateContext,
  type TranslationResult,
} from '@git-migrator/core';

/** The target's description limit (FAC-SET table). */
export const MAX_DESCRIPTION_LENGTH = 350;

export const PUBLIC_FORK_POLICY = 'repository-settings.public-fork-policy';
export const DESCRIPTION_TRUNCATED = 'repository-settings.description-truncated';

/** `[MIGRATED → <url>] ` written by LIF-070; the trailing space may have been trimmed away. */
const MIGRATED_PREFIX = /^\[MIGRATED → [^\s\]]*\](?:\s+|$)/;

export function stripMigratedPrefix(description: string): string {
  return description.trim().replace(MIGRATED_PREFIX, '').trim();
}

/** Cuts at `max` UTF-16 units without splitting a surrogate pair. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end).trimEnd();
}

/** FAC-SET-003 plus trimming; an empty homepage is no homepage. */
export function normalizeRepositorySettings(data: RepositorySettings): RepositorySettings {
  const homepage = data.homepage === null ? '' : data.homepage.trim();
  return {
    ...data,
    description: stripMigratedPrefix(data.description),
    homepage: homepage === '' ? null : homepage,
  };
}

export function translateRepositorySettings(
  source: RepositorySettings,
  ctx: TranslateContext,
): TranslationResult<RepositorySettings> {
  const decisions: FieldDecision[] = [];
  const postTasks: Finding[] = [];

  let description = source.description;
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    description = truncate(description, MAX_DESCRIPTION_LENGTH);
    decisions.push({
      path: '/description',
      fidelity: 'lossy',
      policyKey: DESCRIPTION_TRUNCATED,
      accepted: false,
    });
  }

  // Forking only exists for private repositories; a public one is always forkable.
  let forking = source.forking;
  const isPrivate = source.visibility === 'private';
  let forkingDecision: FieldDecision | undefined;
  if (isPrivate) {
    forking = forking === 'private-only' ? 'allowed' : forking;
    if (source.forking === 'private-only') {
      forkingDecision = { path: '/forking', fidelity: 'translated', accepted: false };
    }
    if (ctx.targetCaps.fields['/forking']?.kind === 'unsupported') {
      forkingDecision = {
        path: '/forking',
        fidelity: 'unsupported',
        accepted: false,
        note: 'organization does not allow forking of private repositories',
      };
      postTasks.push({
        code: 'repository-settings.org-forking-disabled',
        paths: ['/forking'],
        params: {},
      });
    }
  } else if (source.forking !== 'allowed') {
    forking = 'allowed';
    forkingDecision = {
      path: '/forking',
      fidelity: 'lossy',
      policyKey: PUBLIC_FORK_POLICY,
      accepted: false,
    };
  }
  if (forkingDecision !== undefined) decisions.push(forkingDecision);

  return {
    desired: { ...source, description, forking },
    decisions,
    blockers: [],
    preTasks: [],
    postTasks,
    warnings: [],
  };
}

/** On a private repository `private-only` and `allowed` are the same setting (FAC-SET table). */
function comparable(d: RepositorySettings): RepositorySettings {
  return d.visibility === 'private' && d.forking === 'private-only'
    ? { ...d, forking: 'allowed' }
    : d;
}

export const repositorySettingsDefinition: FacetDefinition<RepositorySettings> = {
  key: repositorySettingsFacet.key,
  scope: repositorySettingsFacet.scope,
  schemaVersion: repositorySettingsFacet.schemaVersion,
  schema: repositorySettingsFacet.schema,
  compareMode: 'full',
  collections: repositorySettingsFacet.collections,
  sets: repositorySettingsFacet.sets,
  dependsOn: [],
  inScope: true,
  normalize: normalizeRepositorySettings,
  translate: translateRepositorySettings,
  compare: (desired, actual): FieldDiff[] =>
    diffDocuments(comparable(desired), comparable(actual), repositorySettingsFacet.documentSchema),
  findingCodes: {
    'repository-settings.accept-lossy': { kind: 'pre', completion: 'accept' },
    'repository-settings.org-forking-disabled': { kind: 'post', completion: 'manual' },
    'repository-settings.deletion-forbidden': { kind: 'post', completion: 'manual' },
    'repository-settings.target-unreadable': { kind: 'post', completion: 'manual' },
  },
  policyKeys: [PUBLIC_FORK_POLICY, DESCRIPTION_TRUNCATED],
};
