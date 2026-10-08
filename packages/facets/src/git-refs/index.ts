/**
 * git-refs facet (FAC-GIT). Pure: no I/O, no provider vocabulary (GLO-002).
 *
 * The mirror push carries every branch and tag unchanged, so translation is the identity on
 * `defaultBranch` and `refs`; `ignoredRefs` are never migrated and only produce a warning.
 * Blob-size findings (FAC-GIT-004) are raised by `git.prepare`, not by `translate`; the facet only
 * declares them. Decisions: docs/adr/0100-git-refs-facet.md.
 */
import { type GitRefs, gitRefsFacet } from '@git-migrator/canonical';
import {
  diffDocuments,
  type FacetDefinition,
  type FieldDiff,
  type TranslationResult,
} from '@git-migrator/core';

const HEADS = 'refs/heads/';
const TAGS = 'refs/tags/';

/** Short branch name for a default-branch value that may be a full ref name. */
function shortBranch(name: string): string {
  return name.startsWith(HEADS) ? name.slice(HEADS.length) : name;
}

/**
 * Refs outside `refs/heads/*` and `refs/tags/*` move to `ignoredRefs` (FAC-GIT-002), `kind` follows
 * the ref's namespace, `peeled` only exists on tags, and `defaultBranch` is the short name.
 */
export function normalizeGitRefs(data: GitRefs): GitRefs {
  const ignored = new Set(data.ignoredRefs);
  const refs: GitRefs['refs'] = [];
  for (const r of data.refs) {
    if (r.name.startsWith(HEADS)) {
      refs.push({ name: r.name, kind: 'branch', target: r.target });
    } else if (r.name.startsWith(TAGS)) {
      refs.push({
        name: r.name,
        kind: 'tag',
        target: r.target,
        ...(r.peeled === undefined ? {} : { peeled: r.peeled }),
      });
    } else {
      ignored.add(r.name);
    }
  }
  return {
    defaultBranch: data.defaultBranch === null ? null : shortBranch(data.defaultBranch),
    refs,
    ignoredRefs: [...ignored],
    lfs: data.lfs,
  };
}

export function translateGitRefs(source: GitRefs): TranslationResult<GitRefs> {
  const warnings: TranslationResult<GitRefs>['warnings'] = [];
  if (source.refs.length === 0) {
    warnings.push({ code: 'git-refs.empty-repository', paths: ['/refs'], params: {} });
  }
  if (source.ignoredRefs.length > 0) {
    warnings.push({
      code: 'git-refs.hidden-refs-skipped',
      paths: ['/ignoredRefs'],
      params: { refs: [...source.ignoredRefs].sort() },
    });
  }
  return {
    // Not migrated, so not desired. LFS objects are verified separately (FAC-GIT-005).
    desired: { ...source, ignoredRefs: [], lfs: {} },
    decisions: [],
    blockers: [],
    preTasks: [],
    postTasks: [],
    warnings,
  };
}

/** FAC-GIT-002: parity covers branches, tags and the default branch only. */
export function compareGitRefs(desired: GitRefs, actual: GitRefs): FieldDiff[] {
  const scope = (d: GitRefs) => ({ defaultBranch: d.defaultBranch, refs: d.refs });
  return diffDocuments(scope(desired), scope(actual), {
    collections: gitRefsFacet.collections,
  });
}

export const gitRefsDefinition: FacetDefinition<GitRefs> = {
  key: gitRefsFacet.key,
  scope: gitRefsFacet.scope,
  schemaVersion: gitRefsFacet.schemaVersion,
  schema: gitRefsFacet.schema,
  compareMode: 'full',
  collections: gitRefsFacet.collections,
  sets: gitRefsFacet.sets,
  dependsOn: [],
  inScope: true,
  normalize: normalizeGitRefs,
  translate: (source) => translateGitRefs(source),
  compare: (desired, actual) => compareGitRefs(desired, actual),
  findingCodes: {
    'git-refs.blob-too-large': { kind: 'blocker' },
    'git-refs.blob-large': { kind: 'warning' },
    'git-refs.hidden-refs-skipped': { kind: 'warning' },
    'git-refs.empty-repository': { kind: 'warning' },
  },
  policyKeys: [],
};
