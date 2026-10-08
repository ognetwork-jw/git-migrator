import { createLogger, type Logger } from '@git-migrator/observability';

type Level = 'debug' | 'info' | 'warn' | 'error';

/** The shape Better Auth accepts as `logger` (`@better-auth/core` `Logger`). */
export interface BetterAuthLogger {
  level: Level;
  disableColors: true;
  log: (level: Level, message: string, ...args: unknown[]) => void;
}

/**
 * Bounded on both sides of the `@` (RFC 5321 limits), so a scan does a fixed amount of work per
 * start position and a long run of address characters cannot make it quadratic.
 */
const EMAIL = /[^\s@"'<>()[\],;:/]{1,64}@[^\s@"'<>()[\],;:/]{1,253}\.[^\s@"'<>()[\],;:/]{1,63}/g;
const REDACTED_EMAIL = '[REDACTED]';
/** Every string and message is cut to this length before any pattern runs. */
export const MAX_LOGGED_TEXT = 4096;
/** Characters a cut could split a token or an address on: the cut backs off over them. */
const WORD_CHAR = /[^\s"'<>()[\],;:]/;
const MAX_BACK_OFF = 256;
const MAX_DEPTH = 6;
/** The number of values one log call writes at most, so shared or huge structures stay cheap. */
const MAX_VALUES = 500;
/** An error `code` that is an identifier, not a credential: short, without token punctuation. */
const ERROR_CODE = /^[A-Za-z0-9_.-]{1,32}$/;

/** Email addresses are personal data and are not covered by the shared redaction rules. */
export function scrubEmails(text: string): string {
  return text.replace(EMAIL, REDACTED_EMAIL);
}

/**
 * Cuts `text` to MAX_LOGGED_TEXT. The cut backs off over a run of address or token characters, so
 * no half address or half token is left for the patterns to miss.
 */
function truncate(text: string): string {
  if (text.length <= MAX_LOGGED_TEXT) return text;
  let cut = MAX_LOGGED_TEXT;
  const floor = cut - MAX_BACK_OFF;
  while (cut > floor && WORD_CHAR.test(text.charAt(cut - 1))) cut -= 1;
  return `${text.slice(0, cut)}[truncated ${text.length - cut} chars]`;
}

function scrubText(text: string): string {
  return scrubEmails(truncate(text));
}

function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '[Unprintable]';
  }
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

interface Walk {
  /** The objects on the current path, to cut cycles. */
  readonly path: WeakSet<object>;
  remaining: number;
}

/** Reads `key`, which may be a throwing getter. */
function read(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return '[Unreadable]';
  }
}

function scrubEntries(value: object, keys: readonly string[], depth: number, walk: Walk) {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (walk.remaining <= 0) {
      out['[truncated]'] = true;
      break;
    }
    out[key] = scrubValue(read(value, key), depth + 1, walk);
  }
  return out;
}

function scrubValue(value: unknown, depth: number, walk: Walk): unknown {
  walk.remaining -= 1;
  if (typeof value === 'string') return scrubText(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (typeof value !== 'object' || value === null) return value;
  if (depth > MAX_DEPTH || walk.remaining <= 0) return '[Truncated]';
  if (walk.path.has(value)) return '[Circular]';
  walk.path.add(value);
  try {
    if (value instanceof Error) {
      // Kept as a plain object with the error's type and its own fields (`code`, `detail`, ...).
      const keys = Object.keys(value).filter((k) => k !== 'cause');
      const ctor = read(value, 'constructor') as { name?: unknown } | undefined;
      const out: Record<string, unknown> = {
        type: safeString(typeof ctor?.name === 'string' ? ctor.name : read(value, 'name')),
        message: scrubText(safeString(read(value, 'message'))),
      };
      const stack = read(value, 'stack');
      if (typeof stack === 'string') out.stack = scrubText(stack);
      Object.assign(out, scrubEntries(value, keys, depth, walk));
      // The shared rules redact any `code` key (it may be an OAuth code). A short identifier such
      // as an SQLSTATE (`23505`) or `ECONNREFUSED` is not a secret, so it is kept as `errorKind`.
      const code = read(value, 'code');
      if (typeof code === 'string' && ERROR_CODE.test(code)) out.errorKind = code;
      else if (typeof code === 'number') out.errorKind = String(code);
      const cause = read(value, 'cause');
      if (cause !== undefined) out.cause = scrubValue(cause, depth + 1, walk);
      return out;
    }
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (const item of value) {
        if (walk.remaining <= 0) {
          out.push('[Truncated]');
          break;
        }
        out.push(scrubValue(item, depth + 1, walk));
      }
      return out;
    }
    if (!isPlainObject(value)) return scrubText(safeString(value));
    return scrubEntries(value, Object.keys(value), depth, walk);
  } finally {
    walk.path.delete(value);
  }
}

/**
 * Routes Better Auth's output through the application logger (DEP-050), so it is JSON, carries
 * `component: auth`, and goes through the shared redaction (ADR-0052). Email addresses are removed
 * as well (recursively, including `cause`), because the shared rules key on field names. Every
 * string is cut to MAX_LOGGED_TEXT first, so a request cannot make scrubbing slow. The first Error
 * becomes the `err` field and any other arguments become `args`, so none is dropped. Logging never
 * throws into the request path: on any failure only the scrubbed message is written.
 */
export function betterAuthLogger(base: Logger = createLogger()): BetterAuthLogger {
  const logger = base.child({ component: 'auth' });
  const write = (level: Level, fields: Record<string, unknown>, message: string) => {
    const method = typeof logger[level] === 'function' ? logger[level] : logger.error;
    method.call(logger, fields, message);
  };
  return {
    level: 'info',
    disableColors: true,
    log: (level, message, ...args) => {
      let text = '[Unprintable]';
      try {
        text = scrubText(safeString(message));
        const walk: Walk = { path: new WeakSet(), remaining: MAX_VALUES };
        const errIndex = args.findIndex((a) => a instanceof Error);
        const fields: Record<string, unknown> = {};
        const rest: unknown[] = [];
        args.forEach((arg, index) => {
          const scrubbed = scrubValue(arg, 0, walk);
          if (index === errIndex) fields.err = scrubbed;
          else rest.push(scrubbed);
        });
        if (rest.length > 0) fields.args = rest;
        write(level, fields, text);
      } catch {
        try {
          write(level, {}, text);
        } catch {
          // Logging must never fail a request.
        }
      }
    },
  };
}
