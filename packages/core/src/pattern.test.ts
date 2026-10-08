import { describe, expect, it } from 'vitest';
import { FieldPathError, itemSeg, parsePathPattern, seg } from './field-path.ts';
import { compilePattern, findMatchingPattern, matchesPattern, matchParsed } from './pattern.ts';

describe('[ADP-020] Expected Difference pattern matching', () => {
  it('[ADP-020] a path equal to the pattern matches', () => {
    expect(matchesPattern('/description', '/description')).toBe(true);
    expect(
      matchesPattern('/rules[pattern=main]/enforcement', '/rules[pattern=main]/enforcement'),
    ).toBe(true);
  });

  it('[ADP-020] a path beneath the pattern matches; an ancestor or sibling does not', () => {
    expect(matchesPattern('/rules[pattern=main]', '/rules[pattern=main]/blockForcePush')).toBe(
      true,
    );
    expect(matchesPattern('/rules[pattern=main]', '/rules[pattern=main]/a/b/c')).toBe(true);
    expect(matchesPattern('/rules[pattern=main]/blockForcePush', '/rules[pattern=main]')).toBe(
      false,
    );
    expect(matchesPattern('/rules[pattern=main]', '/rules[pattern=dev]/x')).toBe(false);
    expect(matchesPattern('/a/b', '/a')).toBe(false);
    expect(matchesPattern('/a/b', '/a/c')).toBe(false);
    expect(matchesPattern('/a', '/ab')).toBe(false);
    expect(matchesPattern('/a', '')).toBe(false);
  });

  it('[ADP-020] "*" as an entire key value matches any value, including slashes and empty', () => {
    const p = '/rules[pattern=*]/enforcement';
    expect(matchesPattern(p, '/rules[pattern=main]/enforcement')).toBe(true);
    expect(matchesPattern(p, '/rules[pattern=release/1.x]/enforcement')).toBe(true);
    expect(matchesPattern(p, '/rules[pattern=]/enforcement')).toBe(true);
    expect(matchesPattern(p, '/rules[pattern=main]/other')).toBe(false);
    expect(matchesPattern(p, '/rules[pattern=main]')).toBe(false);
  });

  it('[ADP-020] "*" must still agree on the collection name and the key field', () => {
    expect(matchesPattern('/rules[pattern=*]', '/rules[name=main]')).toBe(false);
    expect(matchesPattern('/rules[pattern=*]', '/other[pattern=main]')).toBe(false);
  });

  it('[ADP-020] a trailing glob matches a prefix, including the bare prefix, and nothing shorter', () => {
    const p = '/refs[name=refs/heads/git-migrator/*]';
    expect(matchesPattern(p, '/refs[name=refs/heads/git-migrator/docs]')).toBe(true);
    expect(matchesPattern(p, '/refs[name=refs/heads/git-migrator/docs/x]/target')).toBe(true);
    expect(matchesPattern(p, '/refs[name=refs/heads/git-migrator/]')).toBe(true);
    expect(matchesPattern(p, '/refs[name=refs/heads/git-migrator]')).toBe(false);
    expect(matchesPattern(p, '/refs[name=refs/heads/git-migratorx/a]')).toBe(false);
    expect(matchesPattern(p, '/refs[name=refs/heads/main]')).toBe(false);
    expect(matchesPattern(p, '/refs[name=refs/tags/git-migrator/a]')).toBe(false);
  });

  it('[ADP-020] "**" as the final segment matches any depth, including the node itself', () => {
    const p = '/hooks[url=*]/**';
    expect(matchesPattern(p, '/hooks[url=https://x.example/h]')).toBe(true);
    expect(matchesPattern(p, '/hooks[url=https://x.example/h]/active')).toBe(true);
    expect(matchesPattern(p, '/hooks[url=a]/events[name=push]/x/y/z')).toBe(true);
    expect(matchesPattern(p, '/hooks')).toBe(false);
    expect(matchesPattern(p, '/other[url=a]')).toBe(false);
    expect(matchesPattern('/**', '/anything[k=v]/at/all')).toBe(true);
    expect(matchesPattern('/**', '')).toBe(true);
    expect(matchesPattern('/a/**', '/a')).toBe(true);
    expect(matchesPattern('/a/**', '/b')).toBe(false);
  });

  it('[ADP-020] "**" and "*" differ: "*" never spans segments, "**" ends the pattern', () => {
    expect(matchesPattern('/a[k=*]', '/a[k=x]/b')).toBe(true); // beneath
    expect(matchesPattern('/a[k=*]/c', '/a[k=x]/b/c')).toBe(false); // * is one key value, not a depth
    expect(matchesPattern('/a[k=*]/c', '/a[k=x]/c')).toBe(true);
  });

  it('[ADP-020] a bare collection name does not match its keyed elements, and vice versa', () => {
    expect(matchesPattern('/hooks', '/hooks[url=x]')).toBe(false);
    expect(matchesPattern('/hooks/**', '/hooks[url=x]')).toBe(false);
    expect(matchesPattern('/hooks[url=*]', '/hooks')).toBe(false);
    expect(matchesPattern('/hooks', '/hooks')).toBe(true);
  });

  it('[ADP-020] a literal star key matches itself only, not other keys', () => {
    expect(matchesPattern('/rules[pattern=\\*]', '/rules[pattern=\\*]/x')).toBe(true);
    expect(matchesPattern('/rules[pattern=\\*]', '/rules[pattern=main]')).toBe(false);
    expect(matchesPattern('/rules[pattern=*]', '/rules[pattern=\\*]')).toBe(true);
  });

  it('[ADP-020] unicode keys compare by code point sequence without normalization', () => {
    expect(matchesPattern('/a[k=\u00e9*]', '/a[k=\u00e9t\u00e9]')).toBe(true);
    expect(matchesPattern('/a[k=\u00e9*]', '/a[k=e\u0301t\u00e9]')).toBe(false);
    expect(matchesPattern('/a[k=😀*]', '/a[k=😀x]')).toBe(true);
  });

  it('[ADP-020] a concrete path used as a pattern matches itself and below only', () => {
    const concrete = '/rules[pattern=a\\*b\\]]/enforcement';
    expect(matchesPattern(concrete, concrete)).toBe(true);
    expect(matchesPattern(concrete, `${concrete}/deeper`)).toBe(true);
    expect(matchesPattern(concrete, '/rules[pattern=aXb\\]]/enforcement')).toBe(false);
  });

  it('[ADP-020] accepts parsed segments, compiled patterns and pattern lists', () => {
    const segs = [itemSeg('rules', 'pattern', 'main'), seg('x')];
    expect(matchesPattern('/rules[pattern=*]', segs)).toBe(true);
    const parsed = parsePathPattern('/rules[pattern=main]/x');
    expect(matchParsed(parsed, segs)).toBe(true);
    expect(matchesPattern(parsed, segs)).toBe(true);
    const compiled = compilePattern('/rules[pattern=m*]');
    expect(compiled('/rules[pattern=main]/x')).toBe(true);
    expect(compiled(segs)).toBe(true);
    expect(compiled('/rules[pattern=zzz]')).toBe(false);
    expect(findMatchingPattern(['/a', '/rules[pattern=*]', '/rules[pattern=main]'], segs)).toBe(1);
    expect(findMatchingPattern(['/a'], segs)).toBe(-1);
    expect(findMatchingPattern([], '/x')).toBe(-1);
  });

  it('[ADP-020] malformed patterns and paths throw instead of matching', () => {
    expect(() => matchesPattern('/a*', '/a')).toThrow(FieldPathError);
    expect(() => matchesPattern('', '/a')).toThrow(FieldPathError);
    expect(() => matchesPattern('/a', 'a')).toThrow(FieldPathError);
    expect(() => compilePattern('/**/x')).toThrow(FieldPathError);
    expect(() => findMatchingPattern(['/a*'], '/a')).toThrow(FieldPathError);
  });
});
