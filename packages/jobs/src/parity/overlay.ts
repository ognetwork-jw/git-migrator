/**
 * LIF-048 / LIF-060 step 2: an Overlay's partial canonical document is merged onto the desired
 * target document, and the overlay values win. Pure. Decisions: docs/adr/0396-parity-engine-and-verified-status.md.
 */
import { type DocumentSchema, renderKeyValue } from '@git-migrator/core';

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const clone = <V>(value: V): V => structuredClone(value);

/**
 * Objects merge member by member. A keyed collection (declared in `schema.collections`) merges by
 * the rendered key: an overlay element merges onto the element with the same key, or is added.
 * Every other value (a primitive, a set, an undeclared array) is replaced by the overlay's. Neither
 * input is changed.
 */
export function mergeOverlay(schema: DocumentSchema, desired: unknown, overlay: unknown): unknown {
  const keys = new Map(schema.collections.map((c) => [c.path, c.key]));
  const merge = (base: unknown, over: unknown, path: string): unknown => {
    if (isObject(base) && isObject(over)) {
      const out: Record<string, unknown> = { ...clone(base) };
      for (const [name, value] of Object.entries(over)) {
        const at = `${path}/${name}`;
        out[name] = name in out ? merge(out[name], value, at) : clone(value);
      }
      return out;
    }
    const keyField = keys.get(path);
    if (keyField !== undefined && Array.isArray(base) && Array.isArray(over)) {
      const out = clone(base) as unknown[];
      const index = (item: unknown): string | undefined =>
        isObject(item) ? renderKeyValue(item[keyField]) : undefined;
      for (const element of over) {
        const k = index(element);
        const at = k === undefined ? -1 : out.findIndex((x) => index(x) === k);
        out[at === -1 ? out.length : at] =
          at === -1 ? clone(element) : merge(out[at], element, path);
      }
      return out;
    }
    return clone(over);
  };
  return merge(desired, overlay, '');
}
