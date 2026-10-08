/**
 * Field paths (ADP-020).
 *
 * A field path is JSON-Pointer-like. Each `/`-separated segment is a field name, optionally
 * followed by one key selector that addresses an element of a keyed collection, so paths stay
 * stable when arrays reorder:
 *
 *     /description
 *     /rules[pattern=main]/blockForcePush
 *     /refs[name=refs/heads/main]/target
 *
 * The empty string is the document root. Inside the selector the value runs to the first
 * unescaped `]`, so values may contain `/` (`refs/heads/main`) and `=`.
 *
 * Escapes (backslash + the character), chosen so that every string has exactly one rendering:
 *   field name:      `\\` `\/` `\[` `\]` `\*`
 *   selector field:  `\\` `\=` `\[` `\]` `\/` `\*`
 *   selector value:  `\\` `\]` `\*`
 * `*` is escaped everywhere when formatting a concrete path, so that a concrete path used as an
 * Expected Difference pattern matches only itself (and what lies beneath it), and so that a
 * literal `*` (a branch rule whose pattern is `*`) is never confused with the wildcard.
 * Decisions: docs/adr/0056-field-path-and-pattern-syntax.md.
 */

export type FieldPath = string;

/** The key selector of a keyed-collection segment: `[field=value]`. */
export interface KeySelector {
  readonly field: string;
  readonly value: string;
}

export interface PathSegment {
  readonly name: string;
  readonly key?: KeySelector;
}

export class FieldPathError extends Error {
  readonly path: string;
  readonly index: number;
  constructor(message: string, path: string, index: number) {
    super(`${message} (at index ${index} of ${JSON.stringify(path)})`);
    this.name = 'FieldPathError';
    this.path = path;
    this.index = index;
  }
}

const NAME_ESCAPES = new Set(['\\', '/', '[', ']', '*']);
const FIELD_ESCAPES = new Set(['\\', '=', '[', ']', '/', '*']);
const VALUE_ESCAPES = new Set(['\\', ']', '*']);

function escapeWith(text: string, special: ReadonlySet<string>): string {
  let out = '';
  for (const ch of text) out += special.has(ch) ? `\\${ch}` : ch;
  return out;
}

/** Builds a plain field segment. */
export function seg(name: string): PathSegment {
  return { name };
}

/** Builds a keyed-collection element segment: `itemSeg('rules', 'pattern', 'main')`. */
export function itemSeg(name: string, field: string, value: string): PathSegment {
  return { name, key: { field, value } };
}

export function formatSegment(segment: PathSegment): string {
  const name = escapeWith(segment.name, NAME_ESCAPES);
  if (segment.key === undefined) return name;
  const field = escapeWith(segment.key.field, FIELD_ESCAPES);
  const value = escapeWith(segment.key.value, VALUE_ESCAPES);
  return `${name}[${field}=${value}]`;
}

/** Renders segments as a field path. `[]` renders as the root, `''`. */
export function formatFieldPath(segments: readonly PathSegment[]): FieldPath {
  let out = '';
  for (const s of segments) out += `/${formatSegment(s)}`;
  return out;
}

/** Appends segments to an existing path. Equivalent to parse, append, format. */
export function joinFieldPath(parent: FieldPath, ...segments: PathSegment[]): FieldPath {
  return parent + formatFieldPath(segments);
}

/** A value of a segment selector in a pattern. */
export type ValueMatcher =
  | { readonly kind: 'exact'; readonly value: string }
  | { readonly kind: 'prefix'; readonly prefix: string }
  | { readonly kind: 'any' };

export interface PatternSegment {
  readonly name: string;
  readonly key?: { readonly field: string; readonly value: ValueMatcher };
}

export interface ParsedPattern {
  readonly segments: readonly PatternSegment[];
  /** True when the pattern ends in the `**` segment. */
  readonly deep: boolean;
}

type Part = { readonly lit: string } | { readonly star: true };

interface RawSegment {
  readonly name: Part[];
  readonly nameEnd: number;
  readonly field?: Part[];
  readonly value?: Part[];
}

/** Shared scanner. `star` controls whether an unescaped `*` is a wildcard part or a literal. */
function scan(path: string): RawSegment[] {
  if (path === '') return [];
  if (path[0] !== '/') throw new FieldPathError('a field path must start with "/"', path, 0);
  const segments: RawSegment[] = [];
  let i = 0;
  const n = path.length;

  const readText = (
    stops: ReadonlySet<string>,
    escapes: ReadonlySet<string>,
    what: string,
  ): Part[] => {
    const parts: Part[] = [];
    let lit = '';
    while (i < n) {
      const ch = path[i] as string;
      if (ch === '\\') {
        const next = path[i + 1];
        if (next === undefined || !escapes.has(next)) {
          throw new FieldPathError(`invalid escape in ${what}`, path, i);
        }
        lit += next;
        i += 2;
        continue;
      }
      if (stops.has(ch)) break;
      if (ch === '*') {
        if (lit !== '') parts.push({ lit });
        lit = '';
        parts.push({ star: true });
        i++;
        continue;
      }
      lit += ch;
      i++;
    }
    if (lit !== '') parts.push({ lit });
    return parts;
  };

  const NAME_STOPS = new Set(['/', '[', ']']);
  const FIELD_STOPS = new Set(['=', '[', ']']);
  const VALUE_STOPS = new Set([']']);
  // Names and fields may not contain raw delimiters; values may contain `/`, `=` and `[`.
  while (i < n) {
    // Here path[i] === '/'.
    i++;
    const name = readText(NAME_STOPS, NAME_ESCAPES, 'field name');
    const nameEnd = i;
    if (i < n && path[i] === ']') throw new FieldPathError('unexpected "]"', path, i);
    if (i < n && path[i] === '[') {
      i++;
      const field = readText(FIELD_STOPS, FIELD_ESCAPES, 'selector field');
      if (path[i] !== '=') throw new FieldPathError('expected "=" in key selector', path, i);
      i++;
      const value = readText(VALUE_STOPS, VALUE_ESCAPES, 'selector value');
      if (path[i] !== ']') throw new FieldPathError('unterminated key selector', path, i);
      i++;
      if (i < n && path[i] !== '/') {
        throw new FieldPathError('expected "/" after key selector', path, i);
      }
      segments.push({ name, nameEnd, field, value });
    } else {
      segments.push({ name, nameEnd });
    }
  }
  return segments;
}

function literalOf(parts: readonly Part[]): string {
  return parts.map((p) => ('lit' in p ? p.lit : '*')).join('');
}

/**
 * Parses a concrete field path. An unescaped `*` is read as a literal star here (paths produced by
 * `formatFieldPath` always escape it), so adapter or UI input never fails on a branch called `*`.
 * Throws `FieldPathError` on malformed input.
 */
export function parseFieldPath(path: string): PathSegment[] {
  return scan(path).map((raw) => {
    const name = literalOf(raw.name);
    if (raw.field === undefined || raw.value === undefined) return { name };
    return { name, key: { field: literalOf(raw.field), value: literalOf(raw.value) } };
  });
}

export function isFieldPath(path: string): boolean {
  try {
    scan(path);
    return true;
  } catch {
    return false; // scan only ever throws FieldPathError
  }
}

/** Re-renders a path in its single canonical spelling. Throws on malformed input. */
export function canonicalFieldPath(path: string): FieldPath {
  return formatFieldPath(parseFieldPath(path));
}

/**
 * The only way to turn a concrete path into an Expected Difference pattern: it re-renders the path
 * with every `*` escaped, so the pattern matches that path and what lies beneath it, and nothing
 * else. Never store a raw path string as a pattern: `/refs[name=release/*]` is a literal in
 * `parseFieldPath` but a glob in `parsePathPattern`.
 */
export function patternForPath(path: FieldPath): string {
  return canonicalFieldPath(path);
}

/**
 * Parses an Expected Difference pattern (ADP-020):
 * - a selector value may be `*` (any value) or `prefix*` (trailing glob); `\*` is a literal star;
 * - `**` may appear only as the entire final segment (`/hooks[url=*]/**`);
 * - no other wildcard is accepted, and an unaccepted wildcard is an error, never a literal, so a
 *   mistyped pattern is reported instead of silently masking nothing.
 */
export function parsePathPattern(pattern: string): ParsedPattern {
  if (pattern === '') {
    // The root would mask every difference; masking everything must be spelled `/**`.
    throw new FieldPathError(
      'an empty pattern is not allowed (use "/**" for everything)',
      pattern,
      0,
    );
  }
  const raws = scan(pattern);
  const segments: PatternSegment[] = [];
  let deep = false;
  raws.forEach((raw, index) => {
    const isLast = index === raws.length - 1;
    const nameIsDeep =
      raw.name.length === 2 && raw.name.every((p) => 'star' in p) && raw.field === undefined;
    if (nameIsDeep) {
      if (!isLast) throw new FieldPathError('"**" must be the final segment', pattern, raw.nameEnd);
      deep = true;
      return;
    }
    if (raw.name.some((p) => 'star' in p)) {
      throw new FieldPathError(
        'wildcards are allowed only in selector values',
        pattern,
        raw.nameEnd,
      );
    }
    const name = literalOf(raw.name);
    if (raw.field === undefined || raw.value === undefined) {
      segments.push({ name });
      return;
    }
    if (raw.field.some((p) => 'star' in p)) {
      throw new FieldPathError(
        'wildcards are allowed only in selector values',
        pattern,
        raw.nameEnd,
      );
    }
    segments.push({
      name,
      key: { field: literalOf(raw.field), value: valueMatcher(raw.value, pattern, raw.nameEnd) },
    });
  });
  return { segments, deep };
}

function valueMatcher(parts: readonly Part[], pattern: string, at: number): ValueMatcher {
  const stars = parts.filter((p) => 'star' in p).length;
  if (stars === 0) return { kind: 'exact', value: literalOf(parts) };
  const last = parts[parts.length - 1] as Part;
  if (stars > 1 || !('star' in last)) {
    throw new FieldPathError(
      '"*" is allowed only as the whole value or as a trailing glob',
      pattern,
      at,
    );
  }
  const prefix = literalOf(parts.slice(0, -1));
  return prefix === '' ? { kind: 'any' } : { kind: 'prefix', prefix };
}
