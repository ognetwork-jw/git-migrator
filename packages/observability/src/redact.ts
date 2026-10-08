/** The replacement written in place of every secret. */
export const REDACTED = '[REDACTED]';
/** Replacement for a private key block. */
export const REDACTED_KEY = '[REDACTED PRIVATE KEY]';
/** Longer strings are cut before scanning, so scan time is bounded (see ADR-0052). */
export const MAX_TEXT_LENGTH = 64 * 1024;

/** Key names that mark a secret when they appear inside the key, ignoring case and separators. */
const SECRET_SUBSTRINGS = [
  'password',
  'passwd',
  'passphrase',
  'passcode',
  'secret',
  'token',
  'authorization',
  'cookie',
  'credential',
  'signature',
  'bearer',
  'privatekey',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'clientsecret',
  'jwt',
  'dsn',
];

/** Key words that mark a secret only as a whole word (`api_key`, `sig`, `code`), to avoid noise. */
const SECRET_WORDS = new Set([
  'pwd',
  'pin',
  'pass',
  'auth',
  'jwt',
  'dsn',
  'sig',
  'key',
  'code',
  'session',
  'bearer',
  'cred',
  'creds',
]);

/**
 * True when a key name (an object key, a header name, a query or form parameter) names a secret.
 * `Authorization`, `dbPassword`, `client_secret`, `api_key`, `sig` and `code` all match.
 */
export function isSensitiveKey(key: string): boolean {
  const compact = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (SECRET_SUBSTRINGS.some((word) => compact.includes(word))) return true;
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  return words.some((word) => SECRET_WORDS.has(word));
}

/** Pino `redact` paths (DEP-050). They cover the usual shapes; the deep scrub covers the rest. */
export const REDACT_PATHS: readonly string[] = [
  'authorization',
  '*.authorization',
  '*.*.authorization',
  'headers.authorization',
  'password',
  '*.password',
  '*.*.password',
  'token',
  '*.token',
  '*.*.token',
  'secret',
  '*.secret',
  '*.*.secret',
  'privateKey',
  '*.privateKey',
  '*.*.privateKey',
  'credentials',
  '*.credentials',
  '*.*.credentials',
];

// Every pattern below is linear in the input: a start position is only tried at the beginning of a
// run of word characters (lookbehind), or right after a `%XX` escape, and no quantifier nests inside
// another. See ADR-0052.

/**
 * Lookbehind that also lets a rule start right after a percent escape that stays encoded in the
 * shadow (`%22password`, `%2Cghp_…`), or after a string escape such as `\n` or `\u000a` in JSON
 * text (`"ok\npwd=…"`, also with the backslash encoded as `%5C`), where the escape's last character would otherwise count as the preceding
 * word character.
 */
const AFTER_ESCAPE = String.raw`(?<=%[0-9A-Fa-f]{2}|(?:\\|%5[Cc])(?:[nrtbfv]|u[0-9A-Fa-f]{4}))`;

/**
 * A percent-encoded whitespace character. Whitespace escapes stay encoded in the shadow (so an
 * encoded space inside a value does not split it), and the spacing rules accept them instead.
 */
const ENC_SPACE = `%(?:20|09|0B|0C|C2%A0|E1%9A%80|E2%80%8[0-9A]|E2%80%A[89F]|E2%81%9F|E3%80%80|EF%BB%BF)`;
/** Spacing: any Unicode space, a tab, or an encoded one. */
const SPACING = String.raw`(?:[\p{Zs}\t]|${ENC_SPACE})`;

/** Header lines whose whole value is secret: the value runs to the end of the line. */
const SECRET_HEADER = new RegExp(
  String.raw`(?:(?<![\w-])|${AFTER_ESCAPE})(proxy-authorization|authorization|set-cookie|cookie|x-api-key|x-auth-token)${SPACING}*:[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*`,
  'giu',
);
/** `Bearer`, `Basic` and `Digest` credentials wherever they appear. A space may be a `+`. */
const AUTH_SCHEME = new RegExp(
  String.raw`(?:(?<![\w-])|${AFTER_ESCAPE})(Bearer|Basic|Digest)(?:${SPACING}|\+)+\S+`,
  'giu',
);
/** A command-line credential: `curl -u user:secret`, `--user user:secret`, `--proxy-user=user:secret`. */
const CLI_USER = new RegExp(
  String.raw`(?:(?<![\w-])|${AFTER_ESCAPE})(-u|-U|--user|--proxy-user)(${SPACING}+|=)?(?:"[^"]*:[^"]*"|'[^']*:[^']*'|[^\s:'"]+:\S*)`,
  'giu',
);
/** Known credential shapes: signed tokens, provider access tokens and key identifiers, and any long prefixed token. */
const TOKEN_SHAPE = new RegExp(
  [
    // Signed JWT: three base64url segments. Segments include `-`, so each is bounded.
    String.raw`(?:(?<![A-Za-z0-9_])|${AFTER_ESCAPE})eyJ[A-Za-z0-9_-]{5,1024}\.[A-Za-z0-9_-]{5,1024}\.[A-Za-z0-9_-]{0,1024}`,
    // Provider access tokens and key identifiers. Bounded, so a token longer than 512 characters
    // is redacted up to that length (ADR-0052).
    `(?:(?<![A-Za-z0-9])|${AFTER_ESCAPE})(?:gh[pousr]_[A-Za-z0-9]{20,512}|github_pat_[A-Za-z0-9_]{20,512}|AT(?:BB|CTT)[A-Za-z0-9_=-]{16,512}|xox[abprs]-[A-Za-z0-9-]{10,512}|AKIA[0-9A-Z]{16})`,
    // Any long prefixed token, such as `acme_svc_<32+ characters>`. No `-` in the class.
    `(?:(?<![A-Za-z0-9_])|${AFTER_ESCAPE})[A-Za-z]{2,12}_[A-Za-z0-9_]{32,}`,
  ].join('|'),
  'g',
);
/** A URL scheme. Bounded, and it may start after a `+` (`error:+https://`), so no start rescans a long run. */
const SCHEME = String.raw`(?:(?<![a-z0-9.-])|${AFTER_ESCAPE})([a-z][a-z0-9+.-]{0,31}:\/\/)`;
/** URL userinfo with no `/`, `?` or `#` in it: `https://user:secret@host`, `https://token@host`. */
const USERINFO = new RegExp(String.raw`${SCHEME}[^\s/?#]*@`, 'gi');
/**
 * URL userinfo of the form `user:secret@` whose secret holds a `/`, `?` or `#` (a decoded `%2F`):
 * `https://bob:ab/cd@host`. The secret part is bounded to 512 characters and runs to the last `@`
 * before a space or a quote, which fails safe when the path holds another `@`.
 */
const USERINFO_PAIR = new RegExp(
  String.raw`${SCHEME}[^\s/?#:@"'<>]{0,256}:[^\s"'<>]{0,512}@`,
  'gi',
);
/** A space in a key block marker: a space, a form-encoded `+` or `%20`. */
const PEM_SPACE = '(?: |\\+|%20)';
const PEM_BEGIN = new RegExp(
  `-----BEGIN${PEM_SPACE}(?:[A-Z0-9]|${PEM_SPACE}){0,40}PRIVATE${PEM_SPACE}KEY(?:${PEM_SPACE}BLOCK)?-----`,
  'g',
);
const PEM_END = new RegExp(
  `-----END${PEM_SPACE}(?:[A-Z0-9]|${PEM_SPACE}){0,40}PRIVATE${PEM_SPACE}KEY(?:${PEM_SPACE}BLOCK)?-----`,
  'g',
);
/**
 * A quote token: `"` or `'`, or their percent escapes `%22` and `%27` (they stay encoded in the
 * shadow), after up to 16 backslashes or `%5C` escapes (JSON inside a string, at any depth).
 */
const QUOTE_TOKEN = String.raw`(?:\\|%5[Cc]){0,16}(?:["']|%2[27])`;
/** `:` and `=`, and their fullwidth forms U+FF1A and U+FF1D. */
const SEPARATOR_CHAR = String.raw`[:=\uFF1A\uFF1D]`;
/** A parameter or object key that may be quoted, possibly escaped as in JSON inside a string. */
const KEY = new RegExp(
  String.raw`(?:(?<![\w%-])|${AFTER_ESCAPE})[\w-]+(?=(?:${QUOTE_TOKEN})?(?:${SPACING}|\+)*${SEPARATOR_CHAR})`,
  'giu',
);
/** The closing quote of a key, the separator, and spacing (a form-encoded `+` too) around it. */
const SEPARATOR = new RegExp(
  String.raw`(?:${QUOTE_TOKEN})?(?:${SPACING}|\+)*${SEPARATOR_CHAR}(?:${SPACING}|\+)*`,
  'iuy',
);
/** The opening quote of a value: its escape prefix (group 1) and its quote token (group 2). */
const QUOTE_OPEN = /((?:\\|%5[Cc]){0,16})("|'|%22|%27)/y;
// Plain quoted bodies may span newlines and run to the closing quote, or to the end of the text
// when the quote never closes (fail safe). Each alternative starts with a different character, so
// the patterns stay linear.
const DOUBLE_BODY = /(?:[^"\\]|\\[\s\S])*/y;
const SINGLE_BODY = /(?:[^'\\]|\\[\s\S])*/y;
/** Unquoted values run to the end of the line or to a query or form delimiter. Spaces do not end them. */
const UNQUOTED_BODY = /[^\r\n&;]*/y;
const WORD_CHAR = /\w/;
const TOKEN_CHAR = /[A-Za-z0-9_\-+/=.:@%]/;
/** A run of base64 characters, at least 16 long; decoded and tested by `redactBase64Credentials`. */
const BASE64_RUN = /[A-Za-z0-9+/_-]{16,}={0,2}/g;
/** Decoded text that is a `user:secret` credential pair. */
const DECODED_CREDENTIAL = /^[A-Za-z0-9._@-]+:[\x21-\x7e]+$/;
/** The words that mark a secret in prose or in a command line (`password hunter2`, `--pin 1234`). */
const SPACED_WORD = new RegExp(
  String.raw`(?:(?<!\w)|${AFTER_ESCAPE})(?:password|passwd|passphrase|passcode|pwd|pin|secret|token|credential|api(?:[ _+-]|%20)?key|client(?:[ _+-]|%20)?secret)(?![\w-])`,
  'gi',
);
/** Spacing between a word and its value: any Unicode space (U+00A0, U+2003, U+3000, …), a tab or a form-encoded `+`. */
const SPACE_RUN = new RegExp(String.raw`(?:${SPACING}|\+)*`, 'iuy');
const IS_WAS = /(?:is|was)(?![\w-])/iy;
/** Separators between a word and its value, also percent-encoded (`%3D`), so a separator is never taken as the value. */
const LINK_RUN = /(?:[:=\uFF1A\uFF1D]|%3[AD]|%EF%BC%9[AD])*/iy;
const SPACED_RUN = /[^\s&;]+/y;
/** Percent-encoded byte runs, decoded in the shadow copy. */
const PERCENT_RUN = /(?:%[0-9A-Fa-f]{2})+/g;
/** `%25` that forms a new escape (`%2526`, `%2520`): it becomes `%` after the level is decoded. */
const NESTED_PERCENT = /%25(?=[0-9A-Fa-f]{2})/g;
/** Percent-encoding levels removed at most (triple encoding); see ADR-0052. */
const MAX_DECODE_LEVELS = 3;
/**
 * Escapes that stay encoded in the shadow (ADR-0052): `&`, `;`, `"`, `'`, LF, CR, `\\`, `,`, `#` and
 * `%`, and every whitespace character (`%20`, `%C2%A0`, …; see `decodeRun`). A value that contains
 * one is not split by it, so a real encoded separator only over-redacts.
 */
const KEPT_ENCODED = new Set([0x26, 0x3b, 0x22, 0x27, 0x0a, 0x0d, 0x5c, 0x2c, 0x23, 0x25]);
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const WHITESPACE = /\s/gu;
const WHITESPACE_CHAR = /\s/u;

/** Cuts text longer than MAX_TEXT_LENGTH, dropping any token that the cut might split. */
function truncate(text: string): string {
  let head = text.slice(0, MAX_TEXT_LENGTH - 256);
  let cut = head.length;
  while (cut > head.length - 256 && cut > 0 && TOKEN_CHAR.test(head.charAt(cut - 1))) cut -= 1;
  head = head.slice(0, cut);
  return `${head}[truncated ${text.length - head.length} chars]`;
}

/** Replaces every private key block; a block without its END marker runs to the end of the text. */
function redactPemBlocks(text: string): string {
  let out = '';
  let cursor = 0;
  PEM_BEGIN.lastIndex = 0;
  let begin = PEM_BEGIN.exec(text);
  while (begin) {
    out += text.slice(cursor, begin.index) + REDACTED_KEY;
    PEM_END.lastIndex = begin.index + begin[0].length;
    const end = PEM_END.exec(text);
    if (!end) return out;
    cursor = end.index + end[0].length;
    PEM_BEGIN.lastIndex = cursor;
    begin = PEM_BEGIN.exec(text);
  }
  return out + text.slice(cursor);
}

interface ValueSpan {
  readonly end: number;
  readonly open: string;
  readonly close: string;
}

/** True when the text just before `at` ends with a backslash or a `%5C` escape. */
function escapedAt(text: string, at: number): boolean {
  if (text.charAt(at - 1) === '\\') return true;
  return at >= 3 && text.slice(at - 3, at).toUpperCase() === '%5C';
}

/**
 * True when a quote that ends just before `at` can close a value: it is not followed by a word
 * character. `"a"LEAK"` is malformed, and is read as one value to its last quote (fail safe).
 */
function closesValue(text: string, at: number): boolean {
  return !WORD_CHAR.test(text.charAt(at));
}

/**
 * The span of a quoted value that starts at `start`, or undefined when no quote opens there. A plain
 * `"` or `'` value follows JSON escaping. An escaped or percent-encoded quote (`\"`, `\\\"`, `%22`,
 * `%5C%22`) closes only at the same quote token with exactly the same escape prefix, not preceded by
 * a further backslash: `\"a\\\"b\"` is one value. A quote followed by a word character does not
 * close a value. Where the nesting is ambiguous this picks the longer value, and a value that never
 * closes runs to the end of the text (fail safe).
 */
function quotedValueAt(text: string, start: number): ValueSpan | undefined {
  QUOTE_OPEN.lastIndex = start;
  const opened = QUOTE_OPEN.exec(text);
  if (!opened) return undefined;
  const prefix = opened[1] ?? '';
  const quote = opened[2] ?? '';
  const bodyStart = start + opened[0].length;
  if (prefix === '' && (quote === '"' || quote === "'")) {
    const body = quote === '"' ? DOUBLE_BODY : SINGLE_BODY;
    let from = bodyStart;
    for (;;) {
      body.lastIndex = from;
      const end = from + (body.exec(text)?.[0].length ?? 0);
      if (text.charAt(end) !== quote) return { end, open: quote, close: '' };
      if (!closesValue(text, end + 1)) {
        from = end + 1;
        continue;
      }
      return { end: end + 1, open: quote, close: quote };
    }
  }
  const needle = quote.length === 1 ? quote : quote.slice(0, 1);
  const upperQuote = quote.toUpperCase();
  let from = bodyStart;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at < 0) return { end: text.length, open: prefix + quote, close: '' };
    from = at + 1;
    if (text.slice(at, at + quote.length).toUpperCase() !== upperQuote) continue;
    const prefixStart = at - prefix.length;
    if (prefixStart < bodyStart || text.slice(prefixStart, at) !== prefix) continue;
    if (escapedAt(text, prefixStart) || !closesValue(text, at + quote.length)) continue;
    const close = text.slice(prefixStart, at + quote.length);
    return { end: at + quote.length, open: prefix + quote, close };
  }
}

/** Returns the end of the value that starts at `start`, with its opening and closing quote text. */
function valueAt(text: string, start: number): ValueSpan {
  const quoted = quotedValueAt(text, start);
  if (quoted) return quoted;
  UNQUOTED_BODY.lastIndex = start;
  const match = UNQUOTED_BODY.exec(text);
  return { end: start + (match?.[0].length ?? 0), open: '', close: '' };
}

/**
 * The name of a key found at `index`. After a backslash the key may begin with a string escape
 * (`\npwd` is a newline and `pwd`; `\token` may be a tab and `oken`, or `token`), so the name with
 * the escape removed is used when it is the sensitive reading.
 */
function keyName(text: string, index: number, key: string): string {
  const afterBackslash =
    text.charAt(index - 1) === '\\' || text.slice(index - 3, index).toUpperCase() === '%5C';
  if (!afterBackslash || isSensitiveKey(key)) return key;
  const lead = /^(?:[nrtbfv]|u[0-9A-Fa-f]{4})/.exec(key)?.[0] ?? '';
  return key.slice(lead.length);
}

/** Redacts the value of every sensitive key, in `key=value`, `"key": "value"` and escaped JSON forms. */
function redactKeyValues(text: string): string {
  let out = '';
  let cursor = 0;
  KEY.lastIndex = 0;
  for (let found = KEY.exec(text); found; found = KEY.exec(text)) {
    if (found.index < cursor || !isSensitiveKey(keyName(text, found.index, found[0]))) continue;
    SEPARATOR.lastIndex = found.index + found[0].length;
    const separator = SEPARATOR.exec(text);
    if (!separator) continue;
    const start = found.index + found[0].length + separator[0].length;
    const value = valueAt(text, start);
    if (value.end === start) continue;
    out += text.slice(cursor, start) + value.open + REDACTED + value.close;
    cursor = value.end;
  }
  return out + text.slice(cursor);
}

/**
 * Removes secrets from a string. Whole header values of authorization and cookie headers are removed;
 * private key blocks, credential schemes, known token shapes and URL userinfo are replaced; and the
 * value of every sensitive key is replaced in `key=value`, quoted and escaped JSON forms. Text that
 * holds no secret is returned unchanged. Text longer than MAX_TEXT_LENGTH is cut first.
 */
export function redactString(input: string): string {
  const text = input.length > MAX_TEXT_LENGTH ? truncate(input) : input;
  // Chained scrub (ADR-0052). Each level is the percent-decoded form of the level before it AFTER
  // that level was scrubbed, so every redaction already made is still in it, and its scrub can only
  // remove more. The output is the deepest level whose scrub found something that encoding had
  // hidden (`token%3Dabc`, `%22password%22%3A…`); when no level did, the scrubbed text is written
  // as it came in, so ordinary text such as `caf%C3%A9` is not decoded.
  let output = scrubPlain(text);
  let level = output;
  for (let depth = 0; depth < MAX_DECODE_LEVELS; depth += 1) {
    const decoded = decodeLevel(level);
    if (decoded === level) break;
    level = scrubPlain(decoded);
    if (level !== decoded) output = level;
  }
  return output;
}

/**
 * Scrubs one form of the text, without percent-decoding it. Every rule here is linear; see
 * ADR-0052. Exported for the property test that checks `redactString` removes at least as much.
 */
export function scrubPlain(input: string): string {
  let text = redactPemBlocks(input);
  text = text.replace(SECRET_HEADER, (_match, name: string) => `${name}: ${REDACTED}`);
  text = text.replace(AUTH_SCHEME, (_match, scheme: string) => `${scheme} ${REDACTED}`);
  text = text.replace(
    CLI_USER,
    (_match, flag: string, link: string | undefined) => `${flag}${link ?? ' '}${REDACTED}`,
  );
  text = text.replace(TOKEN_SHAPE, REDACTED);
  text = redactBase64Credentials(text);
  text = text.replace(USERINFO, (_match, scheme: string) => `${scheme}${REDACTED}@`);
  text = text.replace(USERINFO_PAIR, (_match, scheme: string) => `${scheme}${REDACTED}@`);
  text = redactKeyValues(text);
  return redactSpacedSecrets(text);
}

/**
 * Redacts the value that follows a sensitive word after spacing, an optional `is` or `was`, and an
 * optional `:` or `=`: `password hunter2`, `the password is: x`, `password was = x`, `password+is+x`.
 * The value is a quoted string (plain, escaped or percent-encoded quotes, as for key values) or one
 * run of characters that ends at whitespace, `&` or `;`, and it is never a lone `:` or `=`. Done
 * with sticky patterns in sequence, so no pattern backtracks into another. This also catches prose
 * such as "password reset", which becomes "password [REDACTED]" (ADR-0052).
 */
function redactSpacedSecrets(text: string): string {
  let out = '';
  let cursor = 0;
  SPACED_WORD.lastIndex = 0;
  for (let word = SPACED_WORD.exec(text); word; word = SPACED_WORD.exec(text)) {
    if (word.index < cursor) continue;
    let at = word.index + word[0].length;
    const wordEnd = at;
    SPACE_RUN.lastIndex = at;
    at += SPACE_RUN.exec(text)?.[0].length ?? 0;
    IS_WAS.lastIndex = at;
    if (IS_WAS.test(text)) {
      at = IS_WAS.lastIndex;
      SPACE_RUN.lastIndex = at;
      at += SPACE_RUN.exec(text)?.[0].length ?? 0;
    }
    LINK_RUN.lastIndex = at;
    at += LINK_RUN.exec(text)?.[0].length ?? 0;
    SPACE_RUN.lastIndex = at;
    at += SPACE_RUN.exec(text)?.[0].length ?? 0;
    if (at === wordEnd) continue;
    const quoted = quotedValueAt(text, at);
    let end: number;
    let replacement = REDACTED;
    if (quoted) {
      end = quoted.end;
      replacement = quoted.open + REDACTED + quoted.close;
    } else {
      SPACED_RUN.lastIndex = at;
      const run = SPACED_RUN.exec(text)?.[0];
      if (run === undefined) continue;
      end = at + run.length;
    }
    out += text.slice(cursor, at) + replacement;
    cursor = end;
    SPACED_WORD.lastIndex = cursor;
  }
  return out + text.slice(cursor);
}

/** Percent-encodes one character as UTF-8, in upper case (`%C2%A0`). */
function encodeChar(char: string): string {
  return Buffer.from(char, 'utf8')
    .toString('hex')
    .toUpperCase()
    .replace(/../g, (hex) => `%${hex}`);
}

/**
 * Decodes one run of `%XX` escapes as UTF-8. Delimiters (KEPT_ENCODED), whitespace and invalid
 * sequences stay encoded.
 */
function decodeRun(run: string): string {
  const escapes = run.split('%').slice(1);
  let out = '';
  let pending: string[] = [];
  const flush = (): void => {
    if (pending.length === 0) return;
    try {
      out += UTF8.decode(Buffer.from(pending.join(''), 'hex')).replace(WHITESPACE, encodeChar);
    } catch {
      for (const hex of pending) {
        const byte = Number.parseInt(hex, 16);
        const char = String.fromCharCode(byte);
        out += byte < 0x80 && !WHITESPACE_CHAR.test(char) ? char : `%${hex.toUpperCase()}`;
      }
    }
    pending = [];
  };
  for (const hex of escapes) {
    if (KEPT_ENCODED.has(Number.parseInt(hex, 16))) {
      flush();
      out += `%${hex.toUpperCase()}`;
    } else {
      pending.push(hex);
    }
  }
  flush();
  return out;
}

/**
 * Removes one level of percent encoding: escapes are decoded as UTF-8, except the delimiter escapes
 * in KEPT_ENCODED, and then a `%25` that forms a new escape becomes `%` (`%2526` becomes `%26`, and
 * `%2520` becomes `%20`, which the next level decodes). One level per call, so a value encoded twice
 * is scrubbed at each level.
 */
export function decodeLevel(text: string): string {
  return text.replace(PERCENT_RUN, decodeRun).replace(NESTED_PERCENT, '%');
}

/** True when base64 text decodes to a `user:secret` pair. */
function isBase64Credential(run: string): boolean {
  return DECODED_CREDENTIAL.test(Buffer.from(run, 'base64').toString('latin1'));
}

/**
 * Replaces a base64 run that decodes to `user:secret` text, so an encoded credential is not logged.
 * A form-encoded space is a `+`, which is also a base64 character, so when the whole run is not a
 * credential each `+`-separated piece is tested too. A run right after `%` may start with the hex
 * digits of an escape that stayed encoded (`%20…`), so it is also tested without them.
 */
function redactBase64Credentials(text: string): string {
  return text.replace(BASE64_RUN, (run: string, offset: number) => {
    if (isBase64Credential(run)) return REDACTED;
    const afterEscape = text.charAt(offset - 1) === '%' && /^[0-9A-Fa-f]{2}/.test(run);
    const pieces = run.split('+').map((piece, index) => {
      const lead = index === 0 && afterEscape ? piece.slice(0, 2) : '';
      const rest = piece.slice(lead.length);
      return rest.length >= 16 && isBase64Credential(rest) ? lead + REDACTED : piece;
    });
    return pieces.join('+');
  });
}

const MAX_DEPTH = 8;

function isPlainContainer(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null || proto === Array.prototype;
}

/**
 * Returns a copy of `value` with secrets removed. Strings are scrubbed with `redactString`. The value
 * of any key that `isSensitiveKey` accepts is replaced with `[REDACTED]`, whatever it holds. Errors
 * keep their name and are returned as plain objects, including `cause` and `errors`, with scrubbed
 * message and stack. Cycles and values nested deeper than MAX_DEPTH are cut.
 */
export function redactValue(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (typeof value !== 'object' || value === null) return value;
  if (value instanceof Date) return value;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return '[binary]';
  if (depth >= MAX_DEPTH) return '[Truncated]';
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  try {
    if (value instanceof Error) {
      const out: Record<string, unknown> = {
        type: value.constructor.name,
        message: redactString(value.message),
      };
      if (value.stack !== undefined) out.stack = redactString(value.stack);
      // `cause` and `errors` are not enumerable, so they are read explicitly.
      const extra: Record<string, unknown> = { ...value };
      if ('cause' in value) extra.cause = value.cause;
      const members = (value as unknown as { errors?: unknown }).errors;
      if (Array.isArray(members)) extra.errors = members;
      for (const [key, child] of Object.entries(extra)) {
        out[key] = isSensitiveKey(key) ? REDACTED : redactValue(child, depth + 1, seen);
      }
      return out;
    }
    if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1, seen));
    if (!isPlainContainer(value)) return redactString(String(value));

    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (isSensitiveKey(key) && child !== undefined && child !== null) {
        out[key] = REDACTED;
      } else {
        out[key] = redactValue(child, depth + 1, seen);
      }
    }
    return out;
  } finally {
    seen.delete(value);
  }
}
