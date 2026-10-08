import { createHash } from 'node:crypto';

/** An error that becomes a GitHub-shaped JSON error response. */
export class GhError extends Error {
  readonly status: number;
  readonly errors?: (ValidationIssue | string)[];
  readonly headers: Record<string, string>;
  readonly docUrl?: string;
  constructor(
    status: number,
    message: string,
    options: {
      errors?: (ValidationIssue | string)[];
      headers?: Record<string, string>;
      docUrl?: string;
    } = {},
  ) {
    super(message);
    this.status = status;
    this.errors = options.errors;
    this.headers = options.headers ?? {};
    this.docUrl = options.docUrl;
  }
}

export interface ValidationIssue {
  resource: string;
  code: string;
  field?: string;
  message?: string;
}

export const notFound = (message = 'Not Found'): GhError => new GhError(404, message);
export const validationFailed = (...errors: ValidationIssue[]): GhError =>
  new GhError(422, 'Validation Failed', { errors });
export const invalidField = (resource: string, field: string, message?: string): GhError =>
  validationFailed({ resource, code: message ? 'custom' : 'invalid', field, message });
export const forbidden = (message = 'Resource not accessible by integration'): GhError =>
  new GhError(403, message);

export function sha1(...parts: (string | Buffer)[]): string {
  const h = createHash('sha1');
  for (const p of parts) h.update(p);
  return h.digest('hex');
}

export const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
export const b64url = (s: string | Buffer): string => Buffer.from(s).toString('base64url');

/** Lower-case, spaces and runs of other characters to `-`, like GitHub's team slugs. */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

/**
 * Ruby `File.fnmatch` with `File::FNM_PATHNAME` (branch protection patterns, provider doc S14):
 * `*` and `?` never match `/`, `**` followed by `/` matches zero or more directories, `[...]` is a
 * character class, `\` escapes. Case-sensitive.
 */
export function fnmatch(pattern: string, name: string): boolean {
  return new RegExp(`^${globToRegex(pattern)}$`, 's').test(name);
}

function globToRegex(pattern: string): string {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === '*') {
      if (pattern[i + 1] === '*' && pattern[i + 2] === '/' && (i === 0 || pattern[i - 1] === '/')) {
        re += '(?:[^/]+/)*';
        i += 2;
      } else if (pattern[i + 1] === '*') {
        re += '[^/]*';
        i += 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const end = pattern.indexOf(']', i + 2);
      if (end === -1) re += '\\[';
      else {
        let cls = pattern.slice(i + 1, end);
        if (cls.startsWith('!')) cls = `^${cls.slice(1)}`;
        re += `[${cls.replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else if (c === '\\' && i + 1 < pattern.length) {
      i += 1;
      re += escapeRe(pattern[i] as string);
    } else re += escapeRe(c);
  }
  return re;
}

const escapeRe = (c: string): string => c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

export const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

export function clone<T>(v: T): T {
  return structuredClone(v);
}

/** A domain error that GraphQL reports in `errors[]` and REST maps to a 422. */
export class RuleError extends Error {}
