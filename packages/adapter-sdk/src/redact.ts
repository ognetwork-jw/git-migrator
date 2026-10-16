/**
 * Secret stripping for raw captures (ADP-061) and error messages. Nothing that goes through here
 * may carry a credential: authorization headers, URL userinfo, secret-looking query values and
 * body fields, the request's own credential values (raw, URL-encoded and base64), and token
 * shapes. Generic shapes live here; provider-specific ones come from the adapter (`shapes`).
 *
 * Every scan is linear in the text length: input is capped at `MAX_SCAN_CHARS` plus a margin
 * before any shape runs, built-in shapes use bounded quantifiers or a single forward pass, and
 * nothing nests an unbounded repeat inside another. The scrubbed text is then cut to
 * `MAX_SCAN_CHARS`, dropping the run of non-space characters the cut would split.
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

/** Text longer than this is cut (a captured string is capped far lower). */
export const MAX_SCAN_CHARS = 1024 * 1024;

/** Text past the cut that is still scanned, so a secret that straddles the cut is found whole. */
const CUT_MARGIN = 8192;

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

/**
 * Words that are sensitive only as a whole word of the key (`userPass`, `db_pass`, `X-Auth`), so
 * `author`, `passenger` and `footprint` stay visible.
 */
const SENSITIVE_WORDS: ReadonlySet<string> = new Set(['pass', 'auth', 'otp']);

/**
 * Words that make a compound ending in `key` a credential (`signingKey`, `hmac_key`,
 * `Ocp-Apim-Subscription-Key`). Other compounds (`facetKey`, `bucketKey`, `publicKey`) name
 * identifiers and stay visible.
 */
const SECRET_KEY_QUALIFIERS: ReadonlySet<string> = new Set([
  'signing',
  'hmac',
  'subscription',
  'encryption',
  'decryption',
  'master',
  'shared',
  'client',
  'consumer',
  'license',
  'app',
  'auth',
]);

/** Query parameters that are credentials by convention but too common as body field names. */
const SENSITIVE_QUERY_WHOLE: ReadonlySet<string> = new Set(['key', 'sig', 'code']);

/** Generic credential shapes. Each is linear; see the module comment. */
const SCHEME_TOKEN = /\b(Bearer|Basic)[ \t]{1,16}([A-Za-z0-9._~+/=-]{8,})/gi;
const TOKEN_RUN = /[A-Za-z0-9_.-]{20,}/g;
/** The minimum length of a signed token's header (after `eyJ`) and payload segments. */
const JWT_MIN_SEGMENT = 5;
const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z ]{0,32}PRIVATE KEY-----/g;
const PRIVATE_KEY_END = 'PRIVATE KEY-----';
const URL_SCHEME = /\b(?:https?|ssh|git):\/\//gi;
/** The rest of a URL authority in text: up to a `/` or white space. */
const AUTHORITY_REST = /[^\s/]*/y;

const MAX_DEPTH = 32;

function flatKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The words of a key: split at separators, camelCase humps (`HTTPAuth`) and letter-digit edges.
 * `OAuth` stays one word, so `X-OAuth-Scopes` is not read as `auth`.
 */
function keyWords(key: string): string[] {
  return key
    .replace(/OAuth/g, 'Oauth')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([A-Za-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '');
}

/**
 * True for a field or parameter name that holds a credential (camelCase or delimited): it contains
 * a sensitive substring, has `pass`, `auth` or `otp` as a word, or ends in `key` after a secret
 * qualifier (`signingKey`, `Ocp-Apim-Subscription-Key`).
 */
export function isSensitiveKey(key: string): boolean {
  const flat = flatKey(key);
  if (SENSITIVE_SUBSTRINGS.some((word) => flat.includes(word))) return true;
  const words = keyWords(key);
  if (words.some((word) => SENSITIVE_WORDS.has(word))) return true;
  const n = words.length;
  return n > 1 && words[n - 1] === 'key' && SECRET_KEY_QUALIFIERS.has(words[n - 2] ?? '');
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

/**
 * Replaces every signed token (`eyJ…` header, payload and signature segments joined by dots) in a
 * token run, wherever it starts inside the run (`id.eyJ…`, `run-eyJ…`). One pass over the run's
 * dot-separated segments, so it is linear.
 */
function stripJwts(run: string): string {
  if (!run.includes('eyJ')) return run;
  const segments = run.split('.');
  const out: string[] = [];
  let i = 0;
  while (i < segments.length) {
    const segment = segments[i] ?? '';
    const at = segment.indexOf('eyJ');
    const payload = segments[i + 1];
    const isJwt =
      at >= 0 &&
      segment.length - at - 3 >= JWT_MIN_SEGMENT &&
      payload !== undefined &&
      payload.length >= JWT_MIN_SEGMENT &&
      i + 2 < segments.length;
    if (!isJwt) {
      out.push(segment);
      i += 1;
      continue;
    }
    out.push(`${segment.slice(0, at)}${REDACTED}`);
    i += 3;
  }
  return out.join('.');
}

/**
 * Replaces the scheme and userinfo of every URL in text (`https://user:pw@`, `https://token@`),
 * up to the last `@` before the authority ends (a `/` or white space), so an unescaped `@` in a
 * password does not leave its tail behind. Linear: an authority ends before the next scheme's `//`.
 */
function stripUserinfo(text: string): string {
  const scheme = new RegExp(URL_SCHEME.source, 'gi');
  let out = '';
  let last = 0;
  for (let m = scheme.exec(text); m !== null; m = scheme.exec(text)) {
    const start = m.index + m[0].length;
    AUTHORITY_REST.lastIndex = start;
    const authority = AUTHORITY_REST.exec(text)?.[0] ?? '';
    const at = authority.lastIndexOf('@');
    if (at > 0) {
      out += text.slice(last, m.index) + REDACTED;
      last = start + at + 1;
    }
    scheme.lastIndex = Math.max(start + authority.length, scheme.lastIndex);
  }
  return out + text.slice(last);
}

function stripGenericShapes(text: string): string {
  let out = text.replace(SCHEME_TOKEN, (match, _scheme: string, token: string) =>
    // A credential has a digit or one of + / = _ - ; plain words ("Basic authentication") stay.
    looksLikeCredential(token) ? REDACTED : match,
  );
  out = out.replace(TOKEN_RUN, stripJwts);
  out = stripPrivateKeys(out);
  return stripUserinfo(out);
}

/**
 * Drops everything after the last ASCII white space: the run a cut may have split. Other spaces
 * (U+00A0, ...) do not stop it, so the drop errs on the side of removing more.
 */
function dropPartialRun(text: string): string {
  const lastSpace = Math.max(
    text.lastIndexOf(' '),
    text.lastIndexOf('\n'),
    text.lastIndexOf('\t'),
    text.lastIndexOf('\r'),
    text.lastIndexOf('\f'),
    text.lastIndexOf('\v'),
  );
  return text.slice(0, lastSpace + 1);
}

function scrub(text: string, options: ScrubOptions): string {
  let out = text;
  for (const form of secretForms(options.secrets ?? [])) out = out.split(form).join(REDACTED);
  for (const shape of options.shapes ?? []) out = out.replace(globalShape(shape), REDACTED);
  return stripGenericShapes(out);
}

/**
 * Scrubs one string. Declared secrets go first, longest form first, so a partial shape match
 * cannot leave part of a secret behind; then adapter shapes, then the generic ones. Text longer
 * than `MAX_SCAN_CHARS` is scrubbed up to `MAX_SCAN_CHARS + CUT_MARGIN` characters, so a secret
 * that straddles the limit is found whole, then cut to `MAX_SCAN_CHARS`; the run of non-space
 * characters at the cut (which may be the head of a secret past the margin) is dropped.
 */
export function stripText(text: string, options: ScrubOptions = {}): string {
  if (text.length <= MAX_SCAN_CHARS) return scrub(text, options);
  const scrubbed = scrub(text.slice(0, MAX_SCAN_CHARS + CUT_MARGIN), options);
  return dropPartialRun(scrubbed.slice(0, MAX_SCAN_CHARS));
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

/**
 * A `Link` header: every `<url>` (of any length) is stripped as a URL, the rest as text. One
 * forward scan: after a `<` with no closing `>`, the rest is text.
 */
function stripLinkHeader(value: string, options: ScrubOptions): string {
  const limit = MAX_SCAN_CHARS + CUT_MARGIN;
  const bounded = value.length > limit ? value.slice(0, limit) : value;
  let links = '';
  let last = 0;
  for (let open = bounded.indexOf('<'); open >= 0; open = bounded.indexOf('<', last)) {
    const close = bounded.indexOf('>', open + 1);
    if (close < 0) break;
    links += `${bounded.slice(last, open)}<${stripUrl(bounded.slice(open + 1, close), options)}>`;
    last = close + 1;
  }
  return stripText(links + bounded.slice(last), options);
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

/**
 * Strips an `application/x-www-form-urlencoded` body: sensitive keys replaced, the rest scrubbed.
 * A body longer than `MAX_SCAN_CHARS` is cut there and the parameter the cut splits is dropped.
 */
export function stripForm(text: string, options: ScrubOptions = {}): string {
  const cut = text.length > MAX_SCAN_CHARS;
  const pairs = [...new URLSearchParams(cut ? text.slice(0, MAX_SCAN_CHARS) : text)];
  if (cut) pairs.pop();
  const out = new URLSearchParams();
  for (const [key, value] of pairs) {
    out.append(key, isSensitiveKey(key) ? REDACTED : stripText(value, options));
  }
  return out.toString().split('%5BREDACTED%5D').join(REDACTED);
}
