import { describe, expect, it } from 'vitest';
import {
  branchPatternCovers,
  branchPatternIncludes,
  branchPatternPrefix,
  branchRuleApplyOrder,
  compareBranchRuleApplyOrder,
  isLiteralBranchPattern,
  matchesEveryBranch,
} from './index.ts';

describe('branch-rule apply order (ADR-0113)', () => {
  it('[FAC-BRR-002] literals first, the match-everything rule after every other wildcard rule', () => {
    const rules = ['**/*', 'release/**/*', 'main', '*', 'release/v1*', 'dev'].map((pattern) => ({
      pattern,
    }));
    expect(branchRuleApplyOrder(rules).map((r) => r.pattern)).toEqual([
      'dev',
      'main',
      'release/v1*',
      'release/**/*',
      '*',
      '**/*',
    ]);
  });

  it('[FAC-BRR-002] does not depend on the input order and does not change the input', () => {
    const a = [{ pattern: '**/*' }, { pattern: 'a*' }, { pattern: 'b*' }];
    const copy = structuredClone(a);
    const forward = branchRuleApplyOrder(a);
    expect(a).toEqual(copy);
    expect(branchRuleApplyOrder([...a].reverse())).toEqual(forward);
    expect(compareBranchRuleApplyOrder('a*', 'a*')).toBe(0);
  });

  it('[FAC-BRR-002] pattern helpers', () => {
    expect(isLiteralBranchPattern('release/1.0')).toBe(true);
    expect(isLiteralBranchPattern('ma?n')).toBe(false);
    expect(branchPatternPrefix('release/v1*')).toBe('release/v1');
    expect(branchPatternPrefix('main')).toBe('main');
    expect(matchesEveryBranch('**/*')).toBe(true);
    expect(matchesEveryBranch('*')).toBe(false);
  });

  it('[FAC-BRR-003] `]` makes a wildcard rule for priority but matches itself', () => {
    expect(isLiteralBranchPattern('foo]')).toBe(false);
    expect(branchPatternPrefix('foo]')).toBe('foo');
    expect(branchPatternIncludes('*]', 'foo]')).toBe(true);
  });

  it('[FAC-BRR-003] inclusion is decided segment by segment and conservatively', () => {
    expect(branchPatternCovers('*', '*hotfix')).toBe(true);
    expect(branchPatternCovers('*hotfix', '*')).toBe(false);
    expect(branchPatternCovers('release/**/*', 'release/*')).toBe(true);
    expect(branchPatternCovers('release/*', 'release/**/*')).toBe(false);
    expect(branchPatternCovers('*a/*', '*a/a')).toBe(true);
    expect(branchPatternCovers('*/*/*', '*/a/b*')).toBe(true);
    expect(branchPatternCovers('a*a', 'a')).toBe(false);
    expect(branchPatternCovers('**/*', 'ma?n')).toBe(true);
    expect(branchPatternCovers('a*', 'a*')).toBe(false);
    expect(branchPatternIncludes('ma?n', 'main')).toBeUndefined();
  });

  it('[FAC-BRR-003] the apply order is topological: `*hotfix` before `*` despite equal prefixes', () => {
    expect(
      branchRuleApplyOrder([{ pattern: '*' }, { pattern: '*hotfix' }]).map((r) => r.pattern),
    ).toEqual(['*hotfix', '*']);
    expect(compareBranchRuleApplyOrder('*', '*hotfix')).toBeLessThan(0);
  });
});
