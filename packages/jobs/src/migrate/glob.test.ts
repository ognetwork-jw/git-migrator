import { describe, expect, it } from 'vitest';
import { branchPatternMatches } from './glob.ts';

describe('[LIF-040] branch patterns of protection rules (step 3a)', () => {
  it('[LIF-040] * stops at a slash, ** does not, ? is one character', () => {
    expect(branchPatternMatches('main', 'main')).toBe(true);
    expect(branchPatternMatches('main', 'mainline')).toBe(false);
    expect(branchPatternMatches('release/*', 'release/1.0')).toBe(true);
    expect(branchPatternMatches('release/*', 'release/1/2')).toBe(false);
    expect(branchPatternMatches('release/**', 'release/1/2')).toBe(true);
    expect(branchPatternMatches('feature/?', 'feature/a')).toBe(true);
    expect(branchPatternMatches('feature/?', 'feature/ab')).toBe(false);
    expect(branchPatternMatches('*', 'git-migrator/ci')).toBe(false);
    expect(branchPatternMatches('**', 'git-migrator/ci')).toBe(true);
    expect(branchPatternMatches('git-migrator/*', 'git-migrator/codeowners')).toBe(true);
  });

  it('[LIF-040] a hostile pattern is judged without backtracking (the test would time out otherwise)', () => {
    expect(branchPatternMatches(`${'*a'.repeat(200)}b`, 'a'.repeat(400))).toBe(false);
  });
});
