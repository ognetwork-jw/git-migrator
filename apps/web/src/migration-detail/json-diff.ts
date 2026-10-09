/**
 * Structural comparison for the side-by-side JSON trees of the Facets tab (UI-022). It marks which
 * entries of one tree differ from the same place in another tree. It is a reading aid: the
 * authoritative differences are the ParityResult's paths, which the tab lists separately.
 * Arrays are compared by index.
 */

export type JsonMark = 'same' | 'changed' | 'only_here';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Deep equality for JSON values (key order does not matter). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]))
    );
  }
  return false;
}

/**
 * How the entry `key` of `value` compares to the entry of `other` (`undefined`: the other tree has
 * no such place). `only_here` means the other tree has nothing there.
 */
export function markEntry(
  value: unknown,
  other: unknown,
  key: string | number,
  hasOther: boolean,
): JsonMark {
  if (!hasOther) return 'same';
  const container = other as Record<string | number, unknown> | unknown[] | null | undefined;
  const present =
    Array.isArray(container) && typeof key === 'number'
      ? key < container.length
      : isRecord(container) && Object.hasOwn(container, String(key));
  if (!present) return 'only_here';
  const counterpart = Array.isArray(container)
    ? container[key as number]
    : (container as Record<string, unknown>)[String(key)];
  return jsonEqual(value, counterpart) ? 'same' : 'changed';
}

/** The entries of an object or array as `[key, value]` pairs; an object's keys are sorted. */
export function entriesOf(value: unknown): [string | number, unknown][] {
  if (Array.isArray(value)) return value.map((v, i) => [i, v]);
  if (isRecord(value)) {
    return Object.keys(value)
      .sort()
      .map((k) => [k, value[k]]);
  }
  return [];
}

export const isContainer = (value: unknown): value is Record<string, unknown> | unknown[] =>
  Array.isArray(value) || isRecord(value);

/** A short text of a scalar for the tree. Strings are quoted; nothing is `undefined`. */
export function scalarText(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? 'null';
}

/** The `decisions` of a Facet's translation, validated to a list (the API sends `unknown`). */
export function decisionsOf(value: unknown): {
  path: string;
  fidelity: string;
  accepted: 'policy' | 'migration' | false;
  policyKey?: string;
  note?: string;
}[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((d: unknown) => {
    if (!isRecord(d) || typeof d.path !== 'string' || typeof d.fidelity !== 'string') return [];
    const accepted = d.accepted === 'policy' || d.accepted === 'migration' ? d.accepted : false;
    return [
      {
        path: d.path,
        fidelity: d.fidelity,
        accepted,
        ...(typeof d.policyKey === 'string' ? { policyKey: d.policyKey } : {}),
        ...(typeof d.note === 'string' ? { note: d.note } : {}),
      },
    ];
  });
}
