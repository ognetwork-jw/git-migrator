/**
 * Secret stripping for raw captures (ADP-061) and error messages. Nothing that goes through here
 * may carry a credential: authorization headers, URL userinfo, secret-looking query values and
 * body fields, the request's own credential values (raw, URL-encoded and base64), and token
 * shapes. Generic shapes live here; provider-specific ones come from the adapter (`shapes`).
 *
 * Every scan is linear in the text length: input is capped at `MAX_SCAN_CHARS` before any shape
 * runs, built-in shapes use bounded quantifiers or a single pass over token runs, and nothing
 * nests an unbounded repeat inside another.
 */

export const REDACTED = '[REDACTED]';

/** What to scrub besides key-based rules. */
export interface ScrubOptions {
  /** Credential values the request used. Their raw, URL-encoded and base64 forms are removed. */
  readonly secrets?: readonly string[];
  /**
   * Adapter-supplied token shapes (provider prefixes). Applied with the global flag, after the
   * declared secrets. They MUST be linear and bounded (for example `/\bprefix_[A-Za-z0-9]{20,256}\b/`):
   * no nested or overlapping unbounded repeats, because they run synchronously on response text.
   */
  readonly shapes?: readonly RegExp[];
}

/** Secrets shorter than this cannot be scrubbed without wrecking ordinary text; callers refuse them. */
export const MIN_SECRET_LENGTH = 4;

/** Text longer than this is cut before scanning (a captured string is capped far lower). */
export const MAX_SCAN_CHARS = 1024 * 1024;

/** Substrings that make a key sensitive, matched on the key lower-cased with separators removed. */
const SENSITIVE_SUBSTRINGS: readonly string[] = [
  'token',
  'secret',
  'password',
  'passwd',
  'passphrase',
  'pwd',
  'apikey',
  'privatekey',
  'sshkey',
  'accesskey',
  'credential',
  'authorization',
  'cookie',
  'signature',
  'bearer',
  'session',
  'jwt',
  'assertion',
];

/** Words that are sensitive only as the whole key, so `author` and `footprint` stay visible. */
const SENSITIVE_WHOLE: ReadonlySet<string> = new Set(['pass', 'auth', 'otp']);

/** Query parameters that are credentials by convention but too common as body field names. */
const SENSITIVE_QUERY_WHOLE: ReadonlySet<string> = new Set(['key', 'sig', 'code']);

/** Generic credential shapes. Each is linear; see the module comment. */
const SCHEME_TOKEN = /\b(Bearer|Basic)[ \t]{1,16}([A-Za-z0-9._~+/=-]{8,})/gi;
const TOKEN_RUN = /[A-Za-z0-9_.-]{20,}/g;
const JWT_PREFIX = /^eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/;
const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z ]{0,32}PRIVATE KEY-----/g;
const PRIVATE_KEY_END = 'PRIVATE KEY-----';
const URL_USERINFO = /\b(?:https?|ssh|git):\/\/[^\s/@:]{1,256}:[^\s/@]{1,256}@/gi;

const MAX_DEPTH = 32;

function flatKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** True for a field or parameter name that holds a credential (camelCase or delimited). */
export function isSensitiveKey(key: string): boolean {
  const flat = flatKey(key);
  return SENSITIVE_WHOLE.has(flat) || SENSITIVE_SUBSTRINGS.some((word) => flat.includes(word));
}

function isSensitiveQuery(key: string): boolean {
  return isSensitiveKey(key) || SENSITIVE_QUERY_WHOLE.has(flatKey(key));
}

export function isSensitiveHeader(name: string): boolean {
  return isSensitiveKey(name) || /^x-amz-security/i.test(name);
}

/** Percent-encodes every byte that is not an ASCII letter or digit (what strict encoders emit). */
function percentEncodeAll(text: string): string {
  let out = '';
  for (const byte of Buffer.from(text, 'utf8')) {
    const ch = String.fromCharCode(byte);
    out += /[A-Za-z0-9]/.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** Raw, URL-encoded (three encoders) and base64 forms of each secret, longest first. */
function secretForms(secrets: readonly string[]): string[] {
  const forms = new Set<string>();
  for (const secret of secrets) {
    if (secret === '') continue;
    forms.add(secret);
    forms.add(encodeURIComponent(secret));
    forms.add(new URLSearchParams({ s: secret }).toString().slice(2));
    forms.add(percentEncodeAll(secret));
    forms.add(Buffer.from(secret, 'utf8').toString('base64'));
    forms.add(Buffer.from(secret, 'utf8').toString('base64url'));
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

function globalShape(shape: RegExp): RegExp {
  return shape.global ? shape : new RegExp(shape.source, `${shape.flags}g`);
}

/** A digit, one of + / = _ - , or an upper-case letter after the first (mixed case): not a plain word. */
function looksLikeCredential(token: string): boolean {
  return /[0-9+/=_-]/.test(token) || /[A-Z]/.test(token.slice(1));
}

/** Replaces each private key block (to its END line, or to the end of the text) in one pass. */
function stripPrivateKeys(text: string): string {
  const begin = new RegExp(PRIVATE_KEY_BEGIN.source, 'g');
  let out = '';
  let last = 0;
  for (let m = begin.exec(text); m !== null; m = begin.exec(text)) {
    const after = m.index + m[0].length;
    const endStart = text.indexOf('-----END ', after);
    const endTail = endStart < 0 ? -1 : text.indexOf(PRIVATE_KEY_END, endStart);
    const stop = endTail < 0 ? text.length : endTail + PRIVATE_KEY_END.length;
    out += text.slice(last, m.index) + REDACTED;
    last = stop;
    begin.lastIndex = stop;
  }
  return out + text.slice(last);
}

function stripGenericShapes(text: string): string {
  let out = text.replace(SCHEME_TOKEN, (match, _scheme: string, token: string) =>
    // A credential has a digit or one of + / = _ - ; plain words ("Basic authentication") stay.
    looksLikeCredential(token) ? REDACTED : match,
  );
  out = out.replace(TOKEN_RUN, (run) => {
    const jwt = JWT_PREFIX.exec(run);
    return jwt === null ? run : `${REDACTED}${run.slice(jwt[0].length)}`;
  });
  out = stripPrivateKeys(out);
  return out.replace(URL_USERINFO, REDACTED);
}

/**
 * Scrubs one string. The text is cut at `MAX_SCAN_CHARS` first. Declared secrets go first, longest
 * form first, so a partial shape match cannot leave part of a secret behind; then adapter shapes,
 * then the generic ones.
 */
export function stripText(text: string, options: ScrubOptions = {}): string {
  let out = text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text;
  for (const form of secretForms(options.secrets ?? [])) out = out.split(form).join(REDACTED);
  for (const shape of options.shapes ?? []) out = out.replace(globalShape(shape), REDACTED);
  return stripGenericShapes(out);
}

/**
 * Strips a URL: userinfo removed, fragment dropped, values of secret-looking query parameters
 * replaced. A value that is not a parseable URL is scrubbed as text.
 */
export function stripUrl(url: string, options: ScrubOptions = {}): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return stripText(url, options);
  }
  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  for (const key of [...new Set(parsed.searchParams.keys())]) {
    if (isSensitiveQuery(key)) parsed.searchParams.set(key, REDACTED);
  }
  return stripText(parsed.toString().split('%5BREDACTED%5D').join(REDACTED), options);
}

/** A `Link` header: every `<url>` is stripped as a URL, the rest as text. */
function stripLinkHeader(value: string, options: ScrubOptions): string {
  const bounded = value.length > MAX_SCAN_CHARS ? value.slice(0, MAX_SCAN_CHARS) : value;
  const links = bounded.replace(
    /<([^>]{0,4096})>/g,
    (_match, url: string) => `<${stripUrl(url, options)}>`,
  );
  return stripText(links, options);
}

/**
 * Copies headers with every sensitive value replaced and the others scrubbed (declared secrets,
 * shapes; `Location` and `Link` as URLs). Names are lower-cased.
 */
export function stripHeaders(
  headers: Iterable<readonly [string, string]> | Headers,
  options: ScrubOptions = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  const entries = headers instanceof Headers ? headers.entries() : headers;
  for (const [name, value] of entries) {
    const lower = name.toLowerCase();
    if (isSensitiveHeader(name)) out[lower] = REDACTED;
    else if (lower === 'location') out[lower] = stripUrl(value, options);
    else if (lower === 'link') out[lower] = stripLinkHeader(value, options);
    else out[lower] = stripText(value, options);
  }
  return out;
}

/** Deep-copies a JSON value. The whole value of a sensitive key is replaced, whatever its type. */
export function stripBody(value: unknown, options: ScrubOptions = {}, depth = 0): unknown {
  if (typeof value === 'string') return stripText(value, options);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => stripBody(item, options, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? REDACTED : stripBody(item, options, depth + 1);
  }
  return out;
}

/** Strips an `application/x-www-form-urlencoded` body: sensitive keys replaced, the rest scrubbed. */
export function stripForm(text: string, options: ScrubOptions = {}): string {
  const params = new URLSearchParams(
    text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text,
  );
  const out = new URLSearchParams();
  for (const [key, value] of params) {
    out.append(key, isSensitiveKey(key) ? REDACTED : stripText(value, options));
  }
  return out.toString().split('%5BREDACTED%5D').join(REDACTED);
}
