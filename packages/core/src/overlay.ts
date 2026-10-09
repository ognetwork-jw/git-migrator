/**
 * Overlay merge (LIF-048). An Overlay's partial canonical document is merged onto the desired
 * target document, overlay values winning. Pure; the Run step applies the result and records the
 * `overlay` Expected Differences for the merged paths. Decisions: docs/adr/0380-migration-steps.md.
 */
import {
  type DocumentSchema,
  flattenDocument,
  normalizeDocument,
  renderKeyValue,
} from './collections.ts';
import { type FieldPath, formatFieldPath, parseFieldPath, seg } from './field-path.ts';

/** Keys that would reach a prototype if assigned through a plain object. */
export const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

export class OverlayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OverlayError';
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export interface OverlayMerge<T> {
  /** The merged document, normalized (ADP-021). */
  readonly merged: T;
  /** The concrete field paths the overlay sets, for the `overlay` Expected Differences. */
  readonly paths: FieldPath[];
}

/**
 * Merges `overlay` onto `desired`:
 * - objects merge field by field; any other value of the overlay replaces the desired one;
 * - keyed collections (ADP-021) merge by key: an element with a known key merges into it, a new
 *   key is added; elements the overlay does not name stay;
 * - sets of primitives and any other value are replaced by the overlay's (as parity merges, T-072);
 * - a key that could reach a prototype (`__proto__`, `constructor`, `prototype`) anywhere in the
 *   overlay is refused, whatever validation happened before.
 * Neither input is changed. Throws `OverlayError` for an overlay that is not a plain object or
 * breaks ADP-021.
 */
export function mergeOverlay<T>(
  desired: T,
  overlay: unknown,
  schema: DocumentSchema,
): OverlayMerge<T> {
  if (!isPlainObject(overlay)) throw new OverlayError('an overlay must be an object');
  assertSafe(overlay, []);
  const collections = new Map(
    schema.collections.map((c) => [
      formatFieldPath(c.path.split('/').filter(Boolean).map(seg)),
      c.key,
    ]),
  );

  const mergeValue = (base: unknown, over: unknown, names: string[]): unknown => {
    const schemaPath = formatFieldPath(names.map(seg));
    const keyField = collections.get(schemaPath);
    if (keyField !== undefined && Array.isArray(over)) {
      return mergeKeyed(Array.isArray(base) ? base : [], over, keyField, names);
    }
    if (isPlainObject(over)) {
      const existing = isPlainObject(base) ? base : {};
      const out: Record<string, unknown> = Object.fromEntries(Object.entries(existing));
      const entries = Object.entries(over);
      for (const [key, value] of entries) {
        if (value === undefined) continue;
        // defineProperty keeps a data property of that name, never a prototype assignment.
        Object.defineProperty(out, key, {
          value: mergeValue(existing[key], value, [...names, key]),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return out;
    }
    return structuredClone(over);
  };

  const mergeKeyed = (
    base: readonly unknown[],
    over: readonly unknown[],
    keyField: string,
    names: string[],
  ): unknown[] => {
    const out = base.map((el) => structuredClone(el));
    const index = new Map<string, number>();
    out.forEach((el, i) => {
      const key = isPlainObject(el) ? renderKeyValue(el[keyField]) : undefined;
      if (key !== undefined) index.set(key, i);
    });
    for (const el of over) {
      const key = isPlainObject(el) ? renderKeyValue(el[keyField]) : undefined;
      if (!isPlainObject(el) || key === undefined) {
        throw new OverlayError(`a collection element has no "${keyField}" key`);
      }
      const at = index.get(key);
      if (at === undefined) {
        index.set(key, out.length);
        out.push(structuredClone(el));
      } else {
        out[at] = mergeValue(out[at], el, names);
      }
    }
    return out;
  };

  let paths: FieldPath[];
  try {
    // The key field of an element only names it; the element's other fields are what is merged.
    paths = [...flattenDocument(overlay, schema).keys()]
      .filter((path) => {
        const segments = parseFieldPath(path);
        const last = segments.at(-1);
        const parent = segments.at(-2);
        return !(last && !last.key && parent?.key && parent.key.field === last.name);
      })
      .sort();
  } catch (error) {
    throw new OverlayError(`the overlay breaks the collection rules: ${(error as Error).message}`);
  }
  const merged = mergeValue(desired, overlay, []);
  try {
    return { merged: normalizeDocument(merged as T, schema), paths };
  } catch (error) {
    throw new OverlayError(
      `the merged document breaks the collection rules: ${(error as Error).message}`,
    );
  }
}

function assertSafe(value: unknown, trail: string[]): void {
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) assertSafe(v, [...trail, String(i)]);
  } else if (isPlainObject(value)) {
    for (const key of Object.getOwnPropertyNames(value)) {
      if (UNSAFE_KEYS.has(key)) {
        throw new OverlayError(`the overlay has a forbidden key at /${[...trail, key].join('/')}`);
      }
      assertSafe(value[key], [...trail, key]);
    }
  }
}
