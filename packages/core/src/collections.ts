/**
 * Keyed collections and document normalization (ADP-020, ADP-021).
 *
 * ADP-021: every array in a canonical document is either a keyed collection (declared with its
 * key field) or a set of primitives. Keyed collections are sorted by their rendered key, so
 * ordering never produces a difference and field paths can address elements by key. Sets are
 * deduplicated and sorted. Anything else (an undeclared array, a duplicate key, a missing key) is
 * reported as an issue; `normalizeDocument` refuses such documents instead of guessing.
 * Decisions: docs/adr/0057-collection-normalization.md.
 */
import {
  type FieldPath,
  formatFieldPath,
  itemSeg,
  type PathSegment,
  parseFieldPath,
  seg,
} from './field-path.ts';

/** A keyed collection declaration (`FacetDefinition.collections`). */
export interface CollectionKeySpec {
  /**
   * Field names from the document root to the array, as a field path of plain names:
   * `/rules` or, for an array inside the elements of another collection, `/rules/restrictPushes`.
   */
  readonly path: string;
  /** The element field holding the natural key. */
  readonly key: string;
}

/** What `normalizeDocument` needs to know about a facet's arrays. */
export interface DocumentSchema {
  readonly collections: readonly CollectionKeySpec[];
  /** Paths (as in `CollectionKeySpec.path`) of arrays of primitives, compared as sorted sets. */
  readonly sets?: readonly string[];
}

/** `PrincipalRef` as used for keys: rendered `kind:id` (ADP-020). */
export interface PrincipalKey {
  readonly kind: string;
  readonly id: string | number;
}

export type CollectionIssueCode =
  | 'root_not_object'
  | 'not_array'
  | 'undeclared_array'
  | 'not_object'
  | 'missing_key'
  | 'invalid_key'
  | 'duplicate_key'
  | 'invalid_set_member'
  | 'invalid_value';

export interface CollectionIssue {
  readonly code: CollectionIssueCode;
  /** Concrete field path of the offending collection, element or value. */
  readonly path: FieldPath;
  readonly message: string;
}

export class CollectionError extends Error {
  readonly issues: readonly CollectionIssue[];
  constructor(issues: readonly CollectionIssue[]) {
    super(
      `invalid document: ${issues.map((i) => `${i.code} at ${JSON.stringify(i.path)}`).join('; ')}`,
    );
    this.name = 'CollectionError';
    this.issues = issues;
  }
}

/** A declaration problem (programmer error), as opposed to a problem in a document. */
export class CollectionSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CollectionSpecError';
  }
}

/** Code-unit order, the same order JCS uses for member names. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Renders a key value to the string used in field paths and for ordering: strings as they are,
 * finite numbers and booleans in their JSON form, `{kind, id}` principals as `kind:id`.
 * Returns `undefined` for anything else (including the empty string, which cannot identify an
 * element).
 */
export function renderKeyValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value === '' ? undefined : value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value === 'boolean') return String(value);
  if (isPlainObject(value)) {
    const { kind, id } = value;
    const keys = Object.keys(value);
    const idOk =
      (typeof id === 'string' && id !== '') || (typeof id === 'number' && Number.isFinite(id));
    if (keys.length === 2 && typeof kind === 'string' && kind !== '' && idOk)
      return `${kind}:${id}`;
  }
  return undefined;
}

interface Compiled {
  readonly collections: ReadonlyMap<string, string>; // schema path -> key field
  readonly sets: ReadonlySet<string>;
}

function schemaPathOf(path: string, what: string): string {
  let segments: PathSegment[];
  try {
    segments = parseFieldPath(path);
  } catch {
    throw new CollectionSpecError(`${what} ${JSON.stringify(path)} is not a field path`);
  }
  if (segments.length === 0 || segments.some((s) => s.key !== undefined)) {
    throw new CollectionSpecError(`${what} ${JSON.stringify(path)} must be plain field names`);
  }
  return formatFieldPath(segments);
}

function compile(schema: DocumentSchema): Compiled {
  const collections = new Map<string, string>();
  for (const spec of schema.collections) {
    const p = schemaPathOf(spec.path, 'collection path');
    if (spec.key === '') throw new CollectionSpecError(`collection ${p} has an empty key field`);
    if (collections.has(p)) throw new CollectionSpecError(`collection ${p} is declared twice`);
    collections.set(p, spec.key);
  }
  const sets = new Set<string>();
  for (const raw of schema.sets ?? []) {
    const p = schemaPathOf(raw, 'set path');
    if (collections.has(p)) {
      throw new CollectionSpecError(`${p} is declared as both a keyed collection and a set`);
    }
    sets.add(p);
  }
  return { collections, sets };
}

type Primitive = null | boolean | number | string;

function primitiveRank(v: Primitive): number {
  return v === null ? 0 : typeof v === 'boolean' ? 1 : typeof v === 'number' ? 2 : 3;
}

function comparePrimitives(a: Primitive, b: Primitive): number {
  const ra = primitiveRank(a);
  const rb = primitiveRank(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === 'number') return a - (b as number);
  if (typeof a === 'string') return compareStrings(a, b as string);
  if (typeof a === 'boolean') return Number(a) - Number(b as boolean);
  return 0;
}

function isPrimitive(v: unknown): v is Primitive {
  return (
    v === null ||
    typeof v === 'boolean' ||
    typeof v === 'string' ||
    (typeof v === 'number' && Number.isFinite(v))
  );
}

interface Walk {
  readonly compiled: Compiled;
  readonly issues: CollectionIssue[];
}

function report(w: Walk, code: CollectionIssueCode, path: PathSegment[], message: string): void {
  w.issues.push({ code, path: formatFieldPath(path), message });
}

/**
 * Validates and normalizes a non-array `value` (found at schema path `names`, concrete path
 * `path`). Arrays are handled by `visitMember`, the only place that can meet one: an array nested
 * directly in an array is never visited, because collection elements must be objects and set
 * members primitives. Returns a normalized deep copy; `undefined` members are dropped.
 */
function visit(w: Walk, value: unknown, names: string[], path: PathSegment[]): unknown {
  if (isPlainObject(value)) {
    // fromEntries defines own properties, so a member named "__proto__" is kept, not turned into
    // a prototype assignment.
    const entries: [string, unknown][] = [];
    for (const name of Object.keys(value)) {
      const member = value[name];
      if (member === undefined) continue;
      entries.push([name, visitMember(w, member, [...names, name], path, name)]);
    }
    return Object.fromEntries(entries);
  }
  if (isPrimitive(value)) return value;
  report(w, 'invalid_value', path, 'not a JSON value');
  return value;
}

function visitMember(
  w: Walk,
  member: unknown,
  names: string[],
  parentPath: PathSegment[],
  name: string,
): unknown {
  const here = [...parentPath, seg(name)];
  // `null` is a legal value of a nullable array (`PrincipalRef[] | null`: null = unrestricted,
  // [] = nobody). It passes through and stays distinct from [].
  if (member === null) return null;
  if (!Array.isArray(member)) {
    const schemaPath = formatFieldPath(names.map(seg));
    if (w.compiled.collections.has(schemaPath) || w.compiled.sets.has(schemaPath)) {
      report(w, 'not_array', here, 'declared as an array but is not one');
      return member;
    }
    return visit(w, member, names, here);
  }
  const schemaPath = formatFieldPath(names.map(seg));
  const keyField = w.compiled.collections.get(schemaPath);
  if (keyField !== undefined) return visitCollection(w, member, names, parentPath, name, keyField);
  if (w.compiled.sets.has(schemaPath)) return visitSet(w, member, here);
  report(w, 'undeclared_array', here, 'arrays must be keyed collections or sets of primitives');
  return member;
}

function visitCollection(
  w: Walk,
  items: readonly unknown[],
  names: string[],
  parentPath: PathSegment[],
  name: string,
  keyField: string,
): unknown[] {
  const here = [...parentPath, seg(name)];
  const keyed: { key: string; value: unknown }[] = [];
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (!isPlainObject(item)) {
      report(w, 'not_object', here, `element ${index} is not an object`);
      return;
    }
    if (!(keyField in item) || item[keyField] === undefined) {
      report(w, 'missing_key', here, `element ${index} has no "${keyField}"`);
      return;
    }
    const key = renderKeyValue(item[keyField]);
    if (key === undefined) {
      report(w, 'invalid_key', here, `element ${index} has an unusable "${keyField}"`);
      return;
    }
    const elementPath = [...parentPath, itemSeg(name, keyField, key)];
    if (seen.has(key)) {
      report(w, 'duplicate_key', elementPath, `"${keyField}" is not unique`);
      return;
    }
    seen.add(key);
    keyed.push({ key, value: visit(w, item, names, elementPath) });
  });
  keyed.sort((a, b) => compareStrings(a.key, b.key));
  return keyed.map((k) => k.value);
}

function visitSet(w: Walk, items: readonly unknown[], here: PathSegment[]): Primitive[] {
  const members: Primitive[] = [];
  for (const [index, item] of items.entries()) {
    if (!isPrimitive(item)) {
      report(w, 'invalid_set_member', here, `element ${index} is not a finite JSON primitive`);
      continue;
    }
    members.push(Object.is(item, -0) ? 0 : item);
  }
  members.sort(comparePrimitives);
  return members.filter(
    (m, i) => i === 0 || comparePrimitives(members[i - 1] as Primitive, m) !== 0,
  );
}

function run(doc: unknown, schema: DocumentSchema): { value: unknown; issues: CollectionIssue[] } {
  const w: Walk = { compiled: compile(schema), issues: [] };
  if (!isPlainObject(doc)) {
    report(w, 'root_not_object', [], 'a canonical document is an object');
    return { value: doc, issues: w.issues };
  }
  return { value: visit(w, doc, [], []), issues: w.issues };
}

/** Lists every violation of ADP-021 in `doc` without throwing. */
export function validateCollections(doc: unknown, schema: DocumentSchema): CollectionIssue[] {
  return run(doc, schema).issues;
}

/**
 * Returns a normalized deep copy of `doc`: keyed collections sorted by rendered key, primitive
 * sets deduplicated and sorted, `undefined` members dropped, empty collections kept as `[]`.
 * Idempotent. Throws `CollectionError` listing every violation; throws `CollectionSpecError` for a
 * bad declaration.
 */
export function normalizeDocument<T>(doc: T, schema: DocumentSchema): T {
  const { value, issues } = run(doc, schema);
  if (issues.length > 0) throw new CollectionError(issues);
  return value as T;
}

/** Result of `getAtPath`. */
export type PathLookup =
  | { readonly found: true; readonly value: unknown }
  | { readonly found: false };

/**
 * Resolves a concrete field path against a document. A keyed segment selects the element of the
 * array `name` whose `field` renders to the segment's value (the first one if the document is not
 * normalized and has duplicates).
 */
export function getAtPath(doc: unknown, path: FieldPath | readonly PathSegment[]): PathLookup {
  const segments = typeof path === 'string' ? parseFieldPath(path) : path;
  let current: unknown = doc;
  for (const s of segments) {
    if (!isPlainObject(current) || !Object.hasOwn(current, s.name)) return { found: false };
    const next = current[s.name];
    if (s.key === undefined) {
      current = next;
      continue;
    }
    if (!Array.isArray(next)) return { found: false };
    const { field, value } = s.key;
    const hit: unknown = next.find(
      (el) => isPlainObject(el) && renderKeyValue(el[field]) === value,
    );
    if (hit === undefined) return { found: false };
    current = hit;
  }
  return current === undefined ? { found: false } : { found: true, value: current };
}

/**
 * Flattens a normalized document to `path -> leaf` entries, where a leaf is a primitive, a
 * primitive set, an empty object or an empty keyed collection. Keyed elements are addressed by key
 * (`/rules[pattern=main]/blockForcePush`), so the result does not depend on array order.
 */
export function flattenDocument(doc: unknown, schema: DocumentSchema): Map<FieldPath, unknown> {
  const compiled = compile(schema);
  const out = new Map<FieldPath, unknown>();
  const walk = (value: unknown, names: string[], path: PathSegment[]): void => {
    if (!isPlainObject(value)) {
      out.set(formatFieldPath(path), value);
      return;
    }
    const keys = Object.keys(value).filter((k) => value[k] !== undefined);
    if (keys.length === 0 && path.length > 0) out.set(formatFieldPath(path), value);
    for (const name of keys) {
      const member = value[name];
      const childNames = [...names, name];
      const schemaPath = formatFieldPath(childNames.map(seg));
      const keyField = compiled.collections.get(schemaPath);
      if (keyField === undefined || !Array.isArray(member)) {
        walk(member, childNames, [...path, seg(name)]);
        continue;
      }
      if (member.length === 0) out.set(formatFieldPath([...path, seg(name)]), member);
      const seen = new Set<string>();
      for (const el of member) {
        const key = isPlainObject(el) ? renderKeyValue(el[keyField]) : undefined;
        if (key === undefined) {
          throw new CollectionError([
            {
              code: 'invalid_key',
              path: formatFieldPath([...path, seg(name)]),
              message: 'unkeyed element',
            },
          ]);
        }
        const elementPath = [...path, itemSeg(name, keyField, key)];
        if (seen.has(key)) {
          throw new CollectionError([
            {
              code: 'duplicate_key',
              path: formatFieldPath(elementPath),
              message: `"${keyField}" is not unique`,
            },
          ]);
        }
        seen.add(key);
        walk(el, childNames, elementPath);
      }
    }
  };
  walk(doc, [], []);
  return out;
}
