/**
 * JSON Canonicalization Scheme (RFC 8785) and content hashing.
 *
 * `canonicalize` is a strict serializer: it accepts exactly the values that survive a JSON round
 * trip unambiguously and throws `CanonicalJsonError` for everything else, so a hash is never
 * computed over a silently altered document. Decisions: docs/adr/0055-core-pure-sha256-and-jcs.md.
 */
import { sha256Hex } from './sha256.ts';

export class CanonicalJsonError extends Error {
  readonly pointer: string;
  constructor(message: string, pointer: string) {
    super(`${message} at "${pointer}"`);
    this.name = 'CanonicalJsonError';
    this.pointer = pointer;
  }
}

export interface CanonicalizeOptions {
  /**
   * What to do with integers outside +-(2^53 - 1). RFC 8785 serializes every number as an IEEE 754
   * double, so `allow` (default) follows the RFC. `reject` is for callers that must not lose
   * precision (use strings for such values).
   */
  readonly unsafeIntegers?: 'allow' | 'reject';
  /** Maximum nesting depth (default 512). */
  readonly maxDepth?: number;
}

const DEFAULT_MAX_DEPTH = 512;

function pointerOf(path: readonly string[]): string {
  return path.map((p) => `/${p.replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');
}

function quote(value: string, path: readonly string[]): string {
  if (!value.isWellFormed()) {
    throw new CanonicalJsonError('lone surrogate in string (not I-JSON)', pointerOf(path));
  }
  return JSON.stringify(value);
}

/** Serializes `value` as RFC 8785 canonical JSON. */
export function canonicalize(value: unknown, options: CanonicalizeOptions = {}): string {
  const rejectUnsafe = options.unsafeIntegers === 'reject';
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const stack = new Set<object>();

  const visit = (v: unknown, path: string[]): string => {
    if (v === null) return 'null';
    switch (typeof v) {
      case 'boolean':
        return v ? 'true' : 'false';
      case 'string':
        return quote(v, path);
      case 'number': {
        if (!Number.isFinite(v)) {
          throw new CanonicalJsonError(`non-finite number (${String(v)})`, pointerOf(path));
        }
        if (rejectUnsafe && Number.isInteger(v) && !Number.isSafeInteger(v)) {
          throw new CanonicalJsonError('integer outside the safe range', pointerOf(path));
        }
        // ECMAScript Number-to-string is what RFC 8785 section 3.2.2.3 mandates; -0 becomes "0".
        return JSON.stringify(v);
      }
      case 'object':
        break;
      default:
        throw new CanonicalJsonError(`unsupported value of type ${typeof v}`, pointerOf(path));
    }
    const obj = v as object;
    if (path.length >= maxDepth) {
      throw new CanonicalJsonError(`nesting deeper than ${maxDepth}`, pointerOf(path));
    }
    if (stack.has(obj)) throw new CanonicalJsonError('circular reference', pointerOf(path));
    stack.add(obj);
    try {
      if (Array.isArray(obj)) {
        const parts: string[] = [];
        for (let i = 0; i < obj.length; i++) {
          // `in` distinguishes holes; both holes and explicit undefined are rejected.
          const item: unknown = i in obj ? obj[i] : undefined;
          path.push(String(i));
          if (item === undefined) {
            throw new CanonicalJsonError('undefined array element', pointerOf(path));
          }
          parts.push(visit(item, path));
          path.pop();
        }
        return `[${parts.join(',')}]`;
      }
      const proto = Object.getPrototypeOf(obj);
      if (proto !== Object.prototype && proto !== null) {
        throw new CanonicalJsonError('not a plain object', pointerOf(path));
      }
      const record = obj as Record<string, unknown>;
      // Default sort compares UTF-16 code units, which is the RFC 8785 section 3.2.3 order.
      const keys = Object.keys(record).sort();
      const parts: string[] = [];
      for (const key of keys) {
        const member = record[key];
        if (member === undefined) continue; // an absent optional field hashes like a missing one
        path.push(key);
        parts.push(`${quote(key, path)}:${visit(member, path)}`);
        path.pop();
      }
      return `{${parts.join(',')}}`;
    } finally {
      stack.delete(obj);
    }
  };

  return visit(value, []);
}

/** `sha256(JCS(value))` as lowercase hex: `FacetSnapshot.hash`, `ManualTask.paramsHash` (DOM-001). */
export function hashCanonical(value: unknown, options?: CanonicalizeOptions): string {
  return sha256Hex(canonicalize(value, options));
}
