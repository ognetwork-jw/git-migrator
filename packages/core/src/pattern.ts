/**
 * Expected Difference pattern matching (ADP-020).
 *
 * "A pattern matches a diff when the diff's path equals the pattern, or lies beneath it":
 * the pattern's segments must be a prefix of the path's segments. Per segment:
 * - names compare exactly;
 * - a segment with a key selector matches only a path segment with the same name, the same key
 *   field and a matching value (`*` any, `prefix*` starts-with, otherwise exact);
 * - a segment without a selector matches only a path segment without one (`/hooks` does not match
 *   `/hooks[url=x]`; write `/hooks[url=*]`).
 * A trailing `**` matches zero or more further segments. Because "beneath" is already implied, it
 * changes nothing about matching and exists to make the intent explicit (`/hooks[url=*]/**`).
 * A pattern longer than the path never matches: a difference at an ancestor is not masked by a
 * pattern about one of its fields.
 */
import {
  type FieldPath,
  type ParsedPattern,
  type PathSegment,
  type PatternSegment,
  parseFieldPath,
  parsePathPattern,
  type ValueMatcher,
} from './field-path.ts';

function valueMatches(matcher: ValueMatcher, value: string): boolean {
  switch (matcher.kind) {
    case 'any':
      return true;
    case 'prefix':
      return value.startsWith(matcher.prefix);
    case 'exact':
      return value === matcher.value;
  }
}

function segmentMatches(pattern: PatternSegment, path: PathSegment): boolean {
  if (pattern.name !== path.name) return false;
  if (pattern.key === undefined || path.key === undefined) {
    return pattern.key === undefined && path.key === undefined;
  }
  return pattern.key.field === path.key.field && valueMatches(pattern.key.value, path.key.value);
}

/** Matches an already parsed pattern against already parsed path segments. */
export function matchParsed(pattern: ParsedPattern, path: readonly PathSegment[]): boolean {
  if (pattern.segments.length > path.length) return false;
  return pattern.segments.every((p, i) => segmentMatches(p, path[i] as PathSegment));
}

/**
 * Matches `path` against `pattern`. Throws `FieldPathError` if either is malformed (a pattern is
 * validated by `parsePathPattern`; compile it once with `compilePattern` when matching many paths).
 */
export function matchesPattern(
  pattern: string | ParsedPattern,
  path: FieldPath | readonly PathSegment[],
): boolean {
  const parsedPattern = typeof pattern === 'string' ? parsePathPattern(pattern) : pattern;
  const segments = typeof path === 'string' ? parseFieldPath(path) : path;
  return matchParsed(parsedPattern, segments);
}

/** Compiles a pattern once. The returned predicate accepts a path string or segments. */
export function compilePattern(
  pattern: string,
): (path: FieldPath | readonly PathSegment[]) => boolean {
  const parsed = parsePathPattern(pattern);
  return (path) => matchParsed(parsed, typeof path === 'string' ? parseFieldPath(path) : path);
}

/** Index of the first pattern that matches `path`, or -1. Patterns are parsed once per call. */
export function findMatchingPattern(
  patterns: readonly string[],
  path: FieldPath | readonly PathSegment[],
): number {
  const segments = typeof path === 'string' ? parseFieldPath(path) : path;
  return patterns.findIndex((p) => matchParsed(parsePathPattern(p), segments));
}
