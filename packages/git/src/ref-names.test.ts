import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { isValidRefName } from './ref-names.ts';
import { assertDeletableRef } from './service.ts';

function gitSays(name: string): boolean {
  try {
    execFileSync('git', ['check-ref-format', name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('ref names', () => {
  const names = [
    'refs/heads/main',
    'refs/heads/feature/\u00fcber',
    'refs/heads/user@team',
    'refs/tags/v1.0.0+build.1',
    'refs/heads/\u65e5\u672c\u8a9e/\u30d6\u30e9\u30f3\u30c1',
    'refs/heads/a.b',
    'refs/heads/a-b_c',
    'refs/heads/.hidden',
    'refs/heads/x.lock',
    'refs/heads/a/.b',
    'refs/heads/a..b',
    'refs/heads/a b',
    'refs/heads/a~b',
    'refs/heads/a^b',
    'refs/heads/a:b',
    'refs/heads/a?b',
    'refs/heads/a*b',
    'refs/heads/a[b',
    'refs/heads/a\\b',
    'refs/heads/a@{b',
    'refs/heads/a//b',
    'refs/heads/a/',
    'refs/heads/a.',
    'refs/heads/\u0001x',
    '/refs/heads/a',
    '@',
    'refs',
    '',
  ];

  it.each(names)('[LIF-043] %j is valid exactly when git check-ref-format says so', (name) => {
    expect(isValidRefName(name)).toBe(gitSays(name));
  });

  it('[LIF-043] deleteRefs accepts valid branch and tag names, including ones with +, @ and non-ASCII', () => {
    for (const ref of [
      'refs/tags/v1.0.0+build.1',
      'refs/heads/feature/\u00fcber',
      'refs/heads/user@team',
      'refs/heads/git-migrator-not/x',
    ]) {
      expect(() => assertDeletableRef(ref), ref).not.toThrow();
    }
  });

  it('[LIF-043] deleteRefs still refuses globs, colons, a leading +, other namespaces and framework branches', () => {
    for (const ref of [
      'main',
      'refs/heads/*',
      'refs/heads/a:b',
      '+refs/heads/main',
      'refs/heads/git-migrator/codeowners',
      'refs/pull/1/head',
      'refs/heads/../x',
      'refs/heads/',
      'refs/tags/v1.lock',
      'refs/heads/a b',
      'refs/remotes/origin/main',
      'refs/notes/commits',
    ]) {
      expect(() => assertDeletableRef(ref), ref).toThrow(/Refusing/);
    }
  });
});
