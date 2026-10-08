# ADR-0052: Log redaction: keys, values, arguments and bounded scanning

- Status: accepted (spec updated)
- Date: 2026-10-08
- Affects: DEP-050, ARC-030, ADP-071, LIF-044

## Context

DEP-050 says secrets are redacted "with pino `redact` paths". Pino `redact` matches object paths only. It cannot see a secret inside a message, a URL, a header line, a PEM block inside a string, or an error. The spec lists what must never reach logs: tokens, Authorization headers, passwords, private keys, credential JSON and URLs with userinfo (ADP-071 names the same risk for git remotes). Git and provider failures put credentials into error text, so the message path matters as much as the field path.

A review found that a regex-only scrub fails open in several ways: a header whose scheme is the only thing removed, a cookie list where the second cookie leaks, token shapes that were not in the list, escaped JSON, unquoted values with spaces, and quadratic backtracking on long input.

## Decision

Redaction fails safe. Where a rule can only guess the extent of a secret, it removes more rather than less. Rules are structural where the format allows (whole header values, whole sensitive-key values) and token shapes are a second line.

**Layer 1: pino `redact`** with the paths in `REDACT_PATHS` (DEP-050).

**Layer 2: a deep scrub** of every log call before pino formats it (`packages/observability/src/redact.ts`, `logger.ts`). The scrub is ordered so that encodings are removed first and the most specific rules run before the broad ones:

1. **Input bound.** A string longer than 65,536 UTF-16 code units is cut to 65,280 code units (64 Ki minus 256), and up to 256 trailing token-like characters before the cut are dropped too, so a token split by the cut is not left as a fragment. The cut is marked `[truncated N chars]`.
2. **Chained scrub over percent-decoded levels.** The scrub (rules 3 to 10, `scrubPlain`) first runs on the text as written. Then, up to three times, the result is decoded by one level (`decodeLevel`) and the decoded level is scrubbed again:

   ```
   output = level = scrubPlain(text)
   repeat at most 3 times:
     decoded = decodeLevel(level); stop if decoded == level
     level = scrubPlain(decoded)
     if level != decoded: output = level      // this level found something encoding had hidden
   return output
   ```

   Each level is decoded from the *already scrubbed* level before it, so every `[REDACTED]` made so far is in it, and a later scrub can only remove more: the output is a superset of the redactions of the plain scrub by construction (a seeded property test checks this, `redact.property.test.ts`). The output is the deepest level whose scrub redacted something; when no decoded level did, the scrubbed text is written as it came in, so ordinary text such as `caf%C3%A9` stays encoded.

   One level of decoding turns each `%XX` escape into its byte, read as UTF-8 (an invalid sequence stays as `%XX`), and then turns a `%25` that is followed by two hex digits into `%`, so `%2526` becomes `%26` for the next level; triple encoding is therefore handled. These escapes stay encoded, so that a value containing them is not split by them: `%26` (`&`), `%3B` (`;`), `%22` (`"`), `%27` (`'`), `%0A`, `%0D`, `%5C` (`\`), `%2C` (`,`), `%23` (`#`), `%25` (`%`) and every whitespace character (`%20`, `%09`, `%C2%A0`, `%E3%80%80`, ...). A real encoded delimiter after a secret then only over-redacts, which fails safe (`password=p%26ss%26TAIL&next=/` loses `p%26ss%26TAIL`). Because these escapes stay encoded, the rules below treat them as what they encode: `%22` and `%27` are quotes, `%5C` is a backslash, and encoded whitespace is spacing. A rule may also start right after any `%XX` escape (`%22password`, `%2Cghp_...`) and right after a string escape (`\n`, `\u000a`, `%5Cn`), whose last character would otherwise look like part of a word (`"ok\npwd=..."`).
3. **Private key blocks.** Every `-----BEGIN … PRIVATE KEY-----` (including `PGP PRIVATE KEY BLOCK`; the spaces may be `+` or `%20`) is replaced up to its matching END marker, or to the end of the text when the END marker is missing.
4. **Header lines.** For `Proxy-Authorization`, `Authorization`, `Set-Cookie`, `Cookie`, `X-Api-Key` and `X-Auth-Token`, the whole value is replaced, including folded continuation lines (`\r?\n` followed by spaces or tabs). `Cookie: [REDACTED]` covers every cookie.
5. **Credential schemes and command-line users.** `Bearer`, `Basic` and `Digest` followed by their credential are replaced wherever they appear. The space may be any Unicode space, encoded whitespace or a form-encoded `+` (`Bearer+TOKEN`). The `user:secret` argument of `-u`, `-U`, `--user` and `--proxy-user` (separated by a space or `=`, quoted or not, or attached as in `-ubob:pw`) is replaced.
6. **Token shapes.** Signed JWTs; GitHub classic and fine-grained tokens; Bitbucket `ATBB` and `ATCTT` tokens; Slack-style `xox` identifiers; AWS `AKIA` key identifiers; and any prefixed token of 32 or more characters with an underscore-separated prefix.
7. **Base64 credential pairs.** A run of 16 or more base64 or base64url characters (`+ / - _`) that decodes to `user:secret` text (a printable name, a colon, then printable characters) is replaced. Because `+` is also a form-encoded space, each `+`-separated piece of a run is tested as well, and a run right after `%` is also tested without the escape's two hex digits. Other base64 text is kept.
8. **URL userinfo.** `scheme://user:password@host` keeps the scheme and host and replaces the userinfo. Userinfo with no `/`, `?` or `#` runs to the last `@` before one of them. Userinfo of the form `user:secret` whose secret holds a raw `/`, `?` or `#` (a decoded `%2F`, `%3F`, `%23`) is also replaced, up to the last `@` before a space or a quote and at most 512 characters of secret; this also redacts `https://host:8080/path@x` (a port, then a path with `@`), an accepted false positive. A scheme may start after a `+`, and is at most 32 characters.
9. **Sensitive key-value pairs.** A key is sensitive when its name contains `password`, `passwd`, `passphrase`, `secret`, `token`, `authorization`, `cookie`, `credential`, `signature`, `bearer`, `private_key`, `api_key`, `access_token`, `refresh_token`, `client_secret`, `jwt` or `dsn`, `passcode`, or when one of its words is `pwd`, `pin`, `pass`, `auth`, `sig`, `key`, `code`, `session`, `cred` or `creds`. The separator between key and value is `:` or `=`, or their fullwidth forms U+FF1A and U+FF1D, with optional spacing on both sides (any Unicode space, a tab, encoded whitespace or a form-encoded `+`). The key may be quoted with any quote token below (`%22password%22:%22…%22`, `\"token\":`). After a backslash, a key that begins with a string escape is also read without it (`\npwd` is `pwd`). Matching ignores case and separators, so `dbPassword`, `client-secret` and `api_key` match. The value replaced is:
   - a quoted value (`"…"` or `'…'`) up to its closing quote, with JSON escapes. Quoted values may span newlines. A quote that never closes runs to the end of the (capped) text, which is the fail-safe choice;
   - a value opened by an escaped or encoded quote: up to 16 backslashes or `%5C` escapes, then `"`, `'`, `%22` or `%27` (`\"…\"`, `\\\"…\\\"`, `%22…%22`, `%5C%22…%5C%22`). It closes only at the same quote token with exactly the same escape prefix, not preceded by a further backslash or `%5C`. So in `{\"password\":\"a\\\"b\"}` the `\\\"` (an escaped quote one level deeper) does not close the value. Where the nesting is ambiguous this reads the longer value;
   - in every quoted form, a closing quote followed by a word character does not close the value (`"a"b"` is read as one value to its last quote), which fails safe for malformed text;
   - otherwise, everything up to the end of the line or the next literal `&` or `;`. A space does not end an unquoted value, so `password=hunter 2 TAIL` loses `TAIL` too.
10. **Sensitive word followed by a value.** A sensitive word (`password`, `passwd`, `passphrase`, `passcode`, `pwd`, `pin`, `secret`, `token`, `credential`, `api[ _+-]?key` and `client[ _+-]?secret`, where the joiner may also be `%20`; matching ignores case), then spacing (any Unicode space such as U+00A0, U+2003 or U+3000, a tab, encoded whitespace or a form-encoded `+`), then optionally `is` or `was`, then optionally separators (`:`, `=`, their fullwidth forms, or encoded `%3A`, `%3D`, `%EF%BC%9A`, `%EF%BC%9D`, any number), then one value. The value is a quoted string (any quote token, as in rule 9), or one run of characters that ends at whitespace, `&` or `;`; it is never a separator, encoded or not. So `login with password hunter2 now` loses `hunter2` only, `the password is: X`, `password was = X`, `password+is+X` and `--password VALUE` lose their value. The rule accepts false positives (see Consequences). It runs after rule 9. It is written as sequential sticky patterns, not one regex, so no part backtracks into another.
11. **Object keys.** For structured values the key rule applies to object keys, and `null` and `undefined` are kept so the field's presence stays visible.
12. **Errors.** Message, stack and own properties are scrubbed, and so are `cause` and `AggregateError.errors`, depth-limited and cycle-safe.
13. **Positional arguments.** After the message string, every string argument (`'tok %s', secret`) is written as `[REDACTED]`. Such a value has no key to judge it by, so the logger drops it. Callers pass secrets as fields or do not log them.

**Linear time.** Every regex starts only at the beginning of a run of word characters (lookbehind) or right after an escape, or is bounded (`{min,512}`, `{5,1024}`, a scheme of at most 32 characters), so no start position can rescan a long run. Escaped and encoded quoted values are found with a forward `indexOf` scan that never moves back. Unbounded classes exclude `-` where a `-`-joined input could otherwise rescan them. The end-of-block search for private keys uses a single forward scan. A 1 MB input of each adversarial shape runs in well under the 1 s test budget (measured worst case about 100 ms after the 64 KiB cut). Decoding is linear: each level rewrites the text once, and the scrub runs at most four times (the text and three decoded levels), still linear.

## Consequences

- False positives, accepted and tested: a sensitive key with a harmless value loses it (for example `tokenCount: 5`, or `status code: 200` if `code` is a word of the key). Prose is affected too: `password reset requested` is written as `password [REDACTED] requested` (`logger.test.ts`), and `token expired` loses `expired`. Losing a word in a log line is cheap; leaking a token is not.
- Percent-decoding changes logged text only when it hid a secret: a decoded level is logged only if its scrub redacted something. Text whose secret is found before decoding stays encoded (`token%3Dabc` is written as `token%3D[REDACTED]`). Because delimiter and whitespace escapes stay encoded, a value containing `%26`, `%0A` or `%20` is redacted whole, and an encoded `&` after a secret hides the parameters that follow it (`client_secret%3Dabc%26grant_type%3Dx` becomes `client_secret%3D[REDACTED]`).
- Known limit: a provider access token longer than 512 characters is redacted up to 512 characters. Such tokens are not known to exist; a longer token would leak its tail.
- Known limit: a secret with no recognizable shape, no sensitive key name and no sensitive word before it is not redacted. Callers must put secrets under sensitive keys or not log them. Positional arguments are dropped entirely (rule 13).
- Known limits (exotic, accepted): percent-encoding nested more than three levels deep; JSON keys written with hex or unicode escapes (`\u0070assword`); a secret with no recognizable shape, no sensitive key and no sensitive word before it; tokens longer than 512 characters (above); invalid UTF-8 bytes or overlong escapes (`%C0%AF`) inside a key or used as a separator, which stay encoded; zero-width characters (U+200B, U+2060) inside a key or a sensitive word; fullwidth or other look-alike letters in a sensitive word (`ｐａｓｓｗｏｒｄ`); an encoded NUL or newline (`%00`, `%0A`) between a sensitive word and its value; more than 16 levels of backslash escaping before a quote; a `user:secret` URL password longer than 512 characters that also holds a `/`, `?` or `#`.
- Known limit: a base64 blob that is not `user:secret` text is not decoded further, and a secret with a sensitive word in another language is not recognised.
- The token shapes name the prefixes of well-known credentials. They are token formats, not provider vocabulary in the sense of GLO-002, and they live in one module.
- Provider clients must never place credentials in logged values. This scrub is the second line.

## Alternatives

- Per-encoding patterns (one regex for `%3D`, another for `%26`, …): each new encoding is a new fail-open edge. The decoded shadow covers them in one place.
- Only pino `redact` paths (the literal DEP-050 reading): misses every secret in a message, URL, header line or error string.
- A regex-only scrub with unbounded, nested quantifiers: quadratic on repeated input, and each new shape adds another fail-open edge. Rejected in favour of the structural rules above.
- Redacting in each caller: relies on every caller. The logger is the single choke point.

## Affected requirements

DEP-050 (log redaction), ADP-071 (credentials never in logs), ARC-030 (no secrets in configuration output).
