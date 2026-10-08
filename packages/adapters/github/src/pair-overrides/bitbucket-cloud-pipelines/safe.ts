/**
 * Validation of every value that is copied from the source file into the workflow (FAC-PIP-002,
 * generated workflows must be safe). A source value either passes one of these checks or is
 * reported as unsupported; none is ever placed inside a `${{ }}` expression.
 */

/** A YAML mapping as parsed (arrays and null excluded). */
export type Mapping = Record<string, unknown>;

/** A plain object: arrays, Maps, Sets, Dates and other class instances are not mappings. */
export function isMapping(value: unknown): value is Mapping {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Own-property read: `constructor`, `__proto__` and the like never reach a prototype. */
export function own(map: Mapping, key: string): unknown {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

function isUnprintable(c: number): boolean {
  return (
    c < 0x20 ||
    (c >= 0x7f && c <= 0x9f) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x200e ||
    c === 0x200f ||
    (c >= 0x202a && c <= 0x202e) ||
    (c >= 0x2066 && c <= 0x2069)
  );
}

/**
 * Printable text for paths and comments: control characters, line and paragraph separators and
 * bidirectional overrides become "?", so nothing can end a comment line or reorder text.
 */
export function printable(text: string, max = 160): string {
  let clean = '';
  for (const ch of text) clean += isUnprintable(ch.codePointAt(0) ?? 0) ? '?' : ch;
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

const PLAIN_KEY = /^[A-Za-z0-9_-]+$/;

/** `base.key`, or `base['key']` for keys that are not plain words. */
export function keyPath(base: string, key: string): string {
  if (PLAIN_KEY.test(key)) return base === '' ? key : `${base}.${key}`;
  return `${base}['${printable(key, 80).replaceAll("'", '"')}']`;
}

export function indexPath(base: string, index: number): string {
  return `${base}[${index}]`;
}

/** `${{` in a value would be evaluated by the workflow engine. */
export function hasExpression(text: string): boolean {
  return text.includes('${{');
}

/** Free text (names, scripts, paths, values): a string, no expression, no NUL. */
export function isSafeText(value: unknown): value is string {
  return typeof value === 'string' && !hasExpression(value) && !value.includes('\0');
}

/** One-line text (names, paths). */
export function isSafeLine(value: unknown): value is string {
  return isSafeText(value) && value.trim() !== '' && !/[\r\n]/.test(value) && value.length <= 512;
}

/** Branch and tag globs. No brace sets, character classes, `+`, `?`, `!` or quotes. */
const GLOB = /^[A-Za-z0-9_.*/-]+$/;
export function isSafeGlob(value: unknown): value is string {
  return (
    typeof value === 'string' && GLOB.test(value) && !value.startsWith('/') && value.length <= 256
  );
}

/** File globs of a cache key: safe inside `hashFiles('…')`, so no quotes, `$`, braces or spaces. */
export function isSafeHashGlob(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.*/@-]+$/.test(value) && value.length <= 256;
}

/** Image names: `registry/name:tag@sha256:…`. No variables. */
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/;
export function isSafeImage(value: unknown): value is string {
  return typeof value === 'string' && IMAGE.test(value) && value.length <= 256;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER.test(value) && value.length <= 128;
}

/** Environment names. */
export function isSafeName(value: unknown): value is string {
  return (
    typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9 _.-]*$/.test(value) && value.length <= 128
  );
}

export function isWord(value: unknown): value is string {
  return typeof value === 'string' && PLAIN_KEY.test(value) && value.length <= 128;
}

/** File-name slug of a pipeline key. */
export function slug(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return s === '' ? 'pipeline' : s;
}

/** Variable references in script text: `$NAME` and `${NAME…}`. */
export function variableReferences(script: string): string[] {
  const names = new Set<string>();
  for (const m of script.matchAll(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*))/g)) {
    names.add(m[1] ?? m[2] ?? '');
  }
  return [...names].filter((n) => n !== '');
}

/** The whole value is one reference: `$NAME` or `${NAME}`. */
export function wholeReference(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const m = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/.exec(value.trim());
  return m?.[1] ?? m?.[2];
}
