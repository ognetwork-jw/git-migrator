import { matchesPattern } from '@git-migrator/core';
import { describe, expect, it } from 'vitest';
import { exclusionPatterns } from './expected-differences.ts';

describe('[AUTH-050] exclusion Expected Difference patterns', () => {
  it('[AUTH-050] covers every place the principal can appear', () => {
    const paths = exclusionPatterns('{acc-1}');
    expect(paths.map((p) => [p.facetKey, p.path])).toEqual([
      ['access-control', '/grants[principal=identity:{acc-1}]'],
      ['members', '/members[principal=identity:{acc-1}]'],
      ['teams', '/teams[slug=*]/members[principal=identity:{acc-1}]'],
      ['branch-rules', '/rules[pattern=*]/restrictPushes[principal=identity:{acc-1}]'],
      ['branch-rules', '/rules[pattern=*]/restrictMerges[principal=identity:{acc-1}]'],
      ['branch-rules', '/rules[pattern=*]/forcePushExempt[principal=identity:{acc-1}]'],
      ['branch-rules', '/rules[pattern=*]/deletionExempt[principal=identity:{acc-1}]'],
      ['code-ownership', '/owners[pattern=*]/principals[principal=identity:{acc-1}]'],
    ]);
  });

  it('[AUTH-050] the patterns match their principal, and only that principal', () => {
    const patterns = exclusionPatterns('123');
    const hit = (facetKey: string, path: string) =>
      patterns.some((p) => p.facetKey === facetKey && matchesPattern(p.path, path));
    expect(hit('access-control', '/grants[principal=identity:123]')).toBe(true);
    expect(hit('access-control', '/grants[principal=identity:123]/permission')).toBe(true);
    expect(hit('access-control', '/grants[principal=identity:1234]')).toBe(false);
    expect(hit('teams', '/teams[slug=devs]/members[principal=identity:123]')).toBe(true);
    expect(hit('teams', '/teams[slug=devs]/members[principal=identity:999]')).toBe(false);
    expect(hit('branch-rules', '/rules[pattern=main]/restrictMerges[principal=identity:123]')).toBe(
      true,
    );
    expect(hit('code-ownership', '/owners[pattern=*]/principals[principal=identity:123]')).toBe(
      true,
    );
  });

  it('[AUTH-050] a star in an id is escaped, never a wildcard', () => {
    const patterns = exclusionPatterns('a*');
    const grants = patterns[0] as { path: string };
    expect(matchesPattern(grants.path, '/grants[principal=identity:a*]')).toBe(true);
    expect(matchesPattern(grants.path, '/grants[principal=identity:abc]')).toBe(false);
  });
});
