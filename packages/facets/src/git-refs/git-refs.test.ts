import type { GitRefs } from '@git-migrator/canonical';
import {
  compareFacet,
  FacetRegistry,
  resolveRoutePolicies,
  type TranslateEnvironment,
  translateFacet,
} from '@git-migrator/core';
import { describe, expect, it } from 'vitest';
import { gitRefsDefinition, normalizeGitRefs } from './index.ts';

const registry = new FacetRegistry().register(gitRefsDefinition);
const unresolved = { resolve: () => ({ status: 'unmapped' as const }) };
const env: TranslateEnvironment = {
  identities: unresolved,
  groups: unresolved,
  policies: resolveRoutePolicies({}),
  route: {},
  routeIndex: {},
};

const sha = (n: number) => n.toString(16).padStart(40, '0');
const base: GitRefs = {
  defaultBranch: 'main',
  refs: [
    { name: 'refs/heads/main', kind: 'branch', target: sha(1) },
    { name: 'refs/tags/v1', kind: 'tag', target: sha(2), peeled: sha(3) },
  ],
  ignoredRefs: [],
  lfs: {},
};

const translate = (source: GitRefs) => translateFacet(registry, 'git-refs', source, { env });

describe('git-refs facet', () => {
  it('[FAC-001] declares the canonical collections and no policy keys', () => {
    expect(gitRefsDefinition.policyKeys).toEqual([]);
    expect(gitRefsDefinition.collections).toEqual([{ path: '/refs', key: 'name' }]);
  });

  it('[FAC-GIT-003] translates branches, tags and the default branch exactly', () => {
    const t = translate(base);
    expect(t.desired).toEqual(base);
    expect(t.decisions).toEqual([]);
    expect(t.blockers).toEqual([]);
    expect(t.preTasks).toEqual([]);
    expect(t.warnings).toEqual([]);
  });

  it('[FAC-GIT-001] keeps the tag object SHA as target and the commit as peeled', () => {
    const t = translate(base);
    const tag = (t.desired as GitRefs).refs.find((r) => r.kind === 'tag');
    expect(tag).toMatchObject({ target: sha(2), peeled: sha(3) });
  });

  it('[FAC-GIT-002] moves refs outside heads and tags to ignoredRefs', () => {
    const n = normalizeGitRefs({
      ...base,
      refs: [...base.refs, { name: 'refs/pull/1/head', kind: 'branch', target: sha(4) }],
      ignoredRefs: ['refs/notes/commits'],
    });
    expect(n.refs.map((r) => r.name)).toEqual(['refs/heads/main', 'refs/tags/v1']);
    expect([...n.ignoredRefs].sort()).toEqual(['refs/notes/commits', 'refs/pull/1/head']);
  });

  it('[FAC-GIT-002] derives kind from the ref namespace and keeps peeled on tags only', () => {
    const n = normalizeGitRefs({
      ...base,
      refs: [
        { name: 'refs/heads/dev', kind: 'tag', target: sha(5), peeled: sha(6) },
        { name: 'refs/tags/v2', kind: 'branch', target: sha(7) },
      ],
    });
    expect(n.refs).toEqual([
      { name: 'refs/heads/dev', kind: 'branch', target: sha(5) },
      { name: 'refs/tags/v2', kind: 'tag', target: sha(7) },
    ]);
  });

  it('[FAC-GIT-001] normalizes a symref default branch to the short name', () => {
    expect(normalizeGitRefs({ ...base, defaultBranch: 'refs/heads/main' }).defaultBranch).toBe(
      'main',
    );
    expect(normalizeGitRefs({ ...base, defaultBranch: null }).defaultBranch).toBeNull();
  });

  it('[FAC-GIT-002] warns about hidden refs, without migrating them', () => {
    const t = translate({ ...base, ignoredRefs: ['refs/pull/2/head', 'refs/notes/commits'] });
    expect(t.warnings).toEqual([
      expect.objectContaining({
        code: 'git-refs.hidden-refs-skipped',
        paths: ['/ignoredRefs'],
        params: { refs: ['refs/notes/commits', 'refs/pull/2/head'] },
      }),
    ]);
    expect((t.desired as GitRefs).ignoredRefs).toEqual([]);
  });

  it('[FAC-GIT-002] a source with no refs warns that the target is created empty', () => {
    const t = translate({ defaultBranch: null, refs: [], ignoredRefs: [], lfs: {} });
    expect(t.warnings.map((w) => w.code)).toEqual(['git-refs.empty-repository']);
    expect(t.blockers).toEqual([]);
  });

  it('[FAC-GIT-004] declares the blob findings that git.prepare raises', () => {
    expect(gitRefsDefinition.findingCodes['git-refs.blob-too-large']).toEqual({ kind: 'blocker' });
    expect(gitRefsDefinition.findingCodes['git-refs.blob-large']).toEqual({ kind: 'warning' });
  });

  describe('compare', () => {
    const cmp = (desired: GitRefs, actual: GitRefs | null) =>
      compareFacet(registry, 'git-refs', desired, actual);

    it('[FAC-GIT-002] equal documents are equal, whatever the order', () => {
      const reversed = { ...base, refs: [...base.refs].reverse() };
      expect(cmp(base, reversed)?.status).toBe('equal');
    });

    it('[FAC-GIT-002] a moved branch, a missing tag and a different default branch differ', () => {
      const actual: GitRefs = {
        ...base,
        defaultBranch: 'trunk',
        refs: [{ name: 'refs/heads/main', kind: 'branch', target: sha(9) }],
      };
      const result = cmp(base, actual);
      expect(result?.status).toBe('different');
      const paths = (result?.diffs ?? []).map((d) => d.path);
      expect(paths).toContain('/defaultBranch');
      expect(paths).toContain('/refs[name=refs/heads/main]/target');
      expect(paths.some((p) => p.startsWith('/refs[name=refs/tags/v1]'))).toBe(true);
    });

    it('[FAC-GIT-002] ignored refs and LFS data are outside the facet parity', () => {
      const actual: GitRefs = {
        ...base,
        ignoredRefs: ['refs/pull/9/head'],
        lfs: { count: 2, bytes: 10, oids: ['a'.repeat(64)] },
      };
      expect(cmp(base, actual)?.status).toBe('equal');
    });

    it('[FAC-GIT-007] an extra framework branch on the target is only an addition', () => {
      const actual: GitRefs = {
        ...base,
        refs: [
          ...base.refs,
          { name: 'refs/heads/git-migrator/ci', kind: 'branch', target: sha(8) },
        ],
      };
      const diffs = cmp(base, actual)?.diffs ?? [];
      expect(diffs.length).toBeGreaterThan(0);
      expect(diffs.every((d) => d.path.startsWith('/refs[name=refs/heads/git-migrator/ci]'))).toBe(
        true,
      );
    });

    it('[LIF-060] an unreadable target is unverifiable', () => {
      expect(cmp(base, null)?.status).toBe('unverifiable');
    });
  });
});
