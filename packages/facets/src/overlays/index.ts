/**
 * Overlay document validation (DOM-001, DOM-003, UI-032, LIF-048). Pure: the server endpoint that
 * writes Overlays and the browser editor run the same checks.
 *
 * An Overlay is a partial canonical document merged onto the desired target document. The check is
 * the Facet's own Zod schema in a deep-partial, strict form: every object field becomes optional,
 * unknown keys are refused, and field-level rules (formats, ranges, enums) still apply. Rules that
 * need a whole document (cross-field refinements, collection key uniqueness) are dropped because a
 * partial document cannot satisfy them.
 */
import type { DocumentParser } from '@git-migrator/core';
import { z } from 'zod';

/** Largest Overlay document, as serialized JSON in UTF-8 bytes. */
export const OVERLAY_MAX_BYTES = 64 * 1024;
/** Deepest nesting of an Overlay document. */
export const OVERLAY_MAX_DEPTH = 32;
/** Keys that are refused at any depth: they can change an object's prototype when merged. */
export const OVERLAY_FORBIDDEN_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];

export interface OverlayIssue {
  /** Dot-separated path into the document; empty for the document itself. */
  readonly path: string;
  readonly message: string;
}

type AnySchema = z.ZodType;
interface Def {
  readonly type: string;
  readonly [key: string]: unknown;
}

const defOf = (schema: AnySchema): Def => (schema as unknown as { _zod: { def: Def } })._zod.def;

/** The deep-partial strict form of a Facet schema. Leaves keep their own rules. */
export function deepPartialStrict(schema: AnySchema): AnySchema {
  const def = defOf(schema);
  switch (def.type) {
    case 'object': {
      const shape = def.shape as Record<string, AnySchema>;
      const next: Record<string, AnySchema> = {};
      for (const key of Object.keys(shape)) {
        const field = shape[key];
        if (field !== undefined) next[key] = deepPartialStrict(field);
      }
      return z.strictObject(next).partial();
    }
    case 'array':
      return z.array(deepPartialStrict(def.element as AnySchema));
    case 'optional':
    case 'default':
    case 'prefault':
    case 'nonoptional':
    case 'readonly':
      // A default must not be applied: the Overlay says what it overrides, nothing more.
      return deepPartialStrict(def.innerType as AnySchema).optional();
    case 'nullable':
      return deepPartialStrict(def.innerType as AnySchema).nullable();
    case 'union':
      return z.union((def.options as AnySchema[]).map(deepPartialStrict) as [AnySchema, AnySchema]);
    case 'record':
      return z.record(def.keyType as z.ZodString, deepPartialStrict(def.valueType as AnySchema));
    default:
      return schema;
  }
}

const compiled = new WeakMap<object, AnySchema>();

function partialSchemaOf(parser: DocumentParser<unknown>): AnySchema | undefined {
  const cached = compiled.get(parser);
  if (cached) return cached;
  if (typeof (parser as { _zod?: unknown })._zod !== 'object') return undefined;
  const schema = deepPartialStrict(parser as AnySchema);
  compiled.set(parser, schema);
  return schema;
}

/** The first forbidden key or excessive depth in a JSON value, found iteratively. */
function structuralIssue(value: unknown): OverlayIssue | undefined {
  const stack: { value: unknown; path: string; depth: number }[] = [{ value, path: '', depth: 0 }];
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined || typeof item.value !== 'object' || item.value === null) continue;
    if (item.depth > OVERLAY_MAX_DEPTH) {
      return { path: item.path, message: `nesting deeper than ${OVERLAY_MAX_DEPTH} levels` };
    }
    for (const [key, child] of Object.entries(item.value)) {
      const path = item.path === '' ? key : `${item.path}.${key}`;
      if (OVERLAY_FORBIDDEN_KEYS.includes(key)) {
        return { path, message: `the key "${key}" is not allowed` };
      }
      stack.push({ value: child, path, depth: item.depth + 1 });
    }
  }
  return undefined;
}

/** Serialized size in UTF-8 bytes, or `undefined` when the value is not JSON-serializable. */
export function overlayBytes(value: unknown): number | undefined {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? undefined : new TextEncoder().encode(text).length;
  } catch {
    return undefined;
  }
}

/**
 * Every problem of an Overlay document for a Facet whose schema is `parser`; empty when the
 * document is valid. The caller stores the document it was given, not a parsed copy.
 */
export function validateOverlayDocument(
  parser: DocumentParser<unknown>,
  data: unknown,
): OverlayIssue[] {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return [{ path: '', message: 'must be a JSON object' }];
  }
  const bytes = overlayBytes(data);
  if (bytes === undefined) return [{ path: '', message: 'must be JSON' }];
  if (bytes > OVERLAY_MAX_BYTES) {
    return [{ path: '', message: `larger than ${OVERLAY_MAX_BYTES} bytes` }];
  }
  const structural = structuralIssue(data);
  if (structural) return [structural];
  const schema = partialSchemaOf(parser);
  if (schema === undefined) return [{ path: '', message: 'the Facet schema cannot be applied' }];
  const result = schema.safeParse(data);
  if (result.success) return [];
  return result.error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}
