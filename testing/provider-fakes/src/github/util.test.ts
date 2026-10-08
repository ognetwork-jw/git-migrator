import { describe, expect, it } from 'vitest';
import { fnmatch, iso, slugify } from './util.ts';

describe('branch protection patterns (File.fnmatch with FNM_PATHNAME)', () => {
  it.each([
    ['main', 'main', true],
    ['main', 'Main', false],
    ['qa/*', 'qa/foo', true],
    ['qa/*', 'qa/foo/bar', false],
    ['qa/**/*', 'qa/foo/bar', true],
    ['qa/**/*', 'qa/foo', true],
    ['qa/**/*', 'qa', false],
    ['*', 'main', true],
    ['*', 'feature/x', false],
    ['**/*', 'feature/x/y', true],
    ['release-?', 'release-1', true],
    ['release-?', 'release-12', false],
    ['v[0-9]*', 'v1.2', true],
    ['v[0-9]*', 'vx', false],
    ['v[!0-9]*', 'vx', true],
    ['a.b', 'axb', false],
    ['a\\*b', 'a*b', true],
    ['a\\*b', 'axb', false],
    ['a[', 'a[', true],
    ['ma*', 'main', true],
    ['*-rc', 'v1-rc', true],
  ])('[FAC-BRR-002] fnmatch(%j, %j) is %s', (pattern, name, expected) => {
    expect(fnmatch(pattern, name)).toBe(expected);
  });
});

describe('helpers', () => {
  it('[TST-011] slugify matches team slugs', () => {
    expect(slugify('Platform Team')).toBe('platform-team');
    expect(slugify('  A / B__c  ')).toBe('a-b-c');
    expect(slugify('Ünï')).toBe('uni');
  });

  it('[TST-011] iso drops milliseconds like GitHub timestamps', () => {
    expect(iso(Date.UTC(2026, 9, 8, 1, 2, 3, 456))).toBe('2026-10-08T01:02:03Z');
  });
});
