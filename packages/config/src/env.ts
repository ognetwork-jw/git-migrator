import type { z } from 'zod';
import { ConfigSchema } from './schema.ts';

/** One configuration key that a GM_* environment variable can override. */
export interface EnvOverrideKey {
  /** Key path in the configuration, for example `['quota', 'safetyFactor']`. */
  readonly path: readonly string[];
  /** The environment variable, for example `GM_QUOTA_SAFETY_FACTOR`. */
  readonly envVar: string;
  readonly schema: z.ZodType;
}

type Def = {
  type: string;
  innerType?: z.ZodType;
  in?: z.ZodType;
  shape?: Record<string, z.ZodType>;
};
const WRAPPERS = new Set(['default', 'prefault', 'optional', 'nonoptional']);
const SCALARS = new Set(['string', 'number', 'boolean', 'enum']);

/**
 * The environment variable for a key path: `GM_` followed by each segment in SCREAMING_SNAKE_CASE,
 * joined with underscores. `quota.safetyFactor` becomes `GM_QUOTA_SAFETY_FACTOR` and
 * `worker.standard.concurrency.runs` becomes `GM_WORKER_STANDARD_CONCURRENCY_RUNS`.
 */
export function envVarFor(path: readonly string[]): string {
  const segments = path.map((segment) =>
    segment.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase(),
  );
  return ['GM', ...segments].join('_');
}

function isScalar(schema: z.ZodType): boolean {
  const def = schema._zod.def as Def;
  if (SCALARS.has(def.type)) return true;
  if (WRAPPERS.has(def.type) && def.innerType) return isScalar(def.innerType);
  if (def.type === 'pipe' && def.in) return isScalar(def.in);
  return false;
}

function collect(schema: z.ZodType, path: string[], out: EnvOverrideKey[]): void {
  const def = schema._zod.def as Def;
  if (def.type === 'object' && def.shape) {
    for (const [key, child] of Object.entries(def.shape)) collect(child, [...path, key], out);
    return;
  }
  if (WRAPPERS.has(def.type) && def.innerType) {
    collect(def.innerType, path, out);
    return;
  }
  // Lists, records and unions cannot be addressed by one variable, so they are not overridable.
  if (path.length > 0 && isScalar(schema)) {
    out.push({ path, envVar: envVarFor(path), schema });
  }
}

/**
 * Every scalar key of the configuration that a GM_* variable can override (ARC-030). Lists
 * (`endpoints`, `routes`, `auth.roleMappings`) and dynamic maps (`quota.overrides`) are configured
 * in the file only. The result is derived from the schema, so it cannot drift from it.
 */
export function envOverrideKeys(schema: z.ZodType = ConfigSchema): readonly EnvOverrideKey[] {
  const out: EnvOverrideKey[] = [];
  collect(schema, [], out);
  return out;
}

/** Plain decimal numbers only: `0x2000`, `1e3` and `Infinity` stay text and fail validation. */
const NUMERIC_LITERAL = /^-?\d+(?:\.\d+)?$/;

/**
 * Converts a raw environment string to the type the key expects. Text the key's schema accepts as it
 * is stays text (URLs, enums, durations, cron). A numeric literal becomes a number and `true`/`false`
 * become booleans, so the schema judges the value by its rules (for example "greater than 0").
 */
function coerce(text: string, schema: z.ZodType): unknown {
  if (schema.safeParse(text).success) return text;
  const trimmed = text.trim();
  if (NUMERIC_LITERAL.test(trimmed)) return Number(trimmed);
  if (text === 'true' || text === 'false') return text === 'true';
  return text;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface EnvOverrideResult {
  /** The configuration document with the overrides applied. */
  readonly value: unknown;
  /** Dotted key path to the variable that set it. */
  readonly applied: ReadonlyMap<string, string>;
}

/**
 * Applies the GM_* overrides to a configuration document. A variable that is unset or empty is
 * ignored, so an empty value in a Kubernetes manifest does not blank a key. Variables that match
 * no key (GM_CONFIG_FILE, GM_WORKER_ROLE, GM_SCRATCH_DIR, ...) are not configuration and are ignored.
 * The input is not modified.
 */
export function applyEnvOverrides(
  document: Record<string, unknown>,
  env: Readonly<Record<string, string | undefined>>,
  keys: readonly EnvOverrideKey[] = envOverrideKeys(),
): EnvOverrideResult {
  const value = structuredClone(document);
  const applied = new Map<string, string>();
  for (const key of keys) {
    const text = env[key.envVar];
    if (text === undefined || text === '') continue;
    let container: Record<string, unknown> = value;
    let reachable = true;
    for (const segment of key.path.slice(0, -1)) {
      if (container[segment] === undefined) container[segment] = {};
      const next = container[segment];
      if (!isPlainObject(next)) {
        // The file already gives this section a non-mapping value; the schema reports that.
        reachable = false;
        break;
      }
      container = next;
    }
    if (!reachable) continue;
    const last = key.path[key.path.length - 1] as string;
    container[last] = coerce(text, key.schema);
    applied.set(key.path.join('.'), key.envVar);
  }
  return { value, applied };
}
