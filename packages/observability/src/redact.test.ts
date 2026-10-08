import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  isSensitiveKey,
  MAX_TEXT_LENGTH,
  REDACT_PATHS,
  REDACTED,
  redactString,
  redactValue,
} from './redact.ts';

/*
 * Secret-shaped test values are assembled at run time from fragments, so that no secret-shaped
 * literal is committed (gitleaks runs on the repository). See ADR-0052.
 */
const j = (...parts: string[]): string => parts.join('');
const BODY = j('Q2x7Rk9Lm3', 'Np8Qr1St6U', 'v4Wx0Yz5Ab2Cd9Ef');
const JWT = j('ey', 'JhbGciOiJIUzI1NiJ9', '.', 'ey', 'JzdWIiOiJ4In0', '.', 'c2lnbmF0dXJlMTIz');

describe('secret redaction of header lines (DEP-050)', () => {
  it('[DEP-050] redacts the whole Authorization value, not only its scheme', () => {
    const out = redactString(j('Authorization: tok', 'en abcdefSECRET'));
    expect(out).toBe(`Authorization: ${REDACTED}`);
  });

  it('[DEP-050] redacts a Digest Authorization header to the end of its line', () => {
    const out = redactString(j('Authorization: Dig', 'est username=bob response=SECRETx'));
    expect(out).not.toContain('SECRETx');
    expect(out).not.toContain('bob');
  });

  it('[DEP-050] redacts every cookie in a Cookie header, not only the first', () => {
    const out = redactString(j('Cookie: a=SECRET', 'A; b=SECRET', 'B'));
    expect(out).toBe(`Cookie: ${REDACTED}`);
  });

  it('[DEP-050] redacts Set-Cookie, X-Api-Key and X-Auth-Token header values', () => {
    expect(redactString('Set-Cookie: sid=abc; Path=/')).toBe(`Set-Cookie: ${REDACTED}`);
    expect(redactString('x-api-key: key-value-1')).toBe(`x-api-key: ${REDACTED}`);
    expect(redactString('X-Auth-Token: t1 t2')).toBe(`X-Auth-Token: ${REDACTED}`);
  });

  it('[DEP-050] keeps the lines after a redacted header line', () => {
    expect(redactString('Cookie: a=1\nstatus: 200')).toBe(`Cookie: ${REDACTED}\nstatus: 200`);
  });
});

describe('secret redaction of credential schemes and token shapes (DEP-050)', () => {
  it('[DEP-050] redacts Bearer and Basic credentials wherever they appear', () => {
    expect(redactString(j('sent Bear', 'er ', BODY))).toBe(`sent Bearer ${REDACTED}`);
    expect(redactString(j('Basic dXNlcjpwYXNz'))).toBe(`Basic ${REDACTED}`);
  });

  it('[DEP-050] redacts signed JWT tokens', () => {
    expect(redactString(`id ${JWT} done`)).toBe(`id ${REDACTED} done`);
  });

  it('[DEP-050] redacts classic and fine-grained GitHub token shapes', () => {
    for (const prefix of ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_']) {
      const token = prefix + BODY;
      expect(redactString(`value ${token} end`), prefix).toBe(`value ${REDACTED} end`);
    }
    const pat = j('github', '_pat_', BODY, BODY.slice(0, 6));
    expect(redactString(`x ${pat} y`)).toBe(`x ${REDACTED} y`);
  });

  it('[DEP-050] redacts Bitbucket ATBB and ATCTT token shapes', () => {
    expect(redactString(`t ${j('ATBB', BODY)} u`)).toBe(`t ${REDACTED} u`);
    expect(redactString(`t ${j('ATCT', 'T', BODY)} u`)).toBe(`t ${REDACTED} u`);
  });

  it('[DEP-050] redacts Slack-style and AWS access key identifiers', () => {
    expect(redactString(`a ${j('xox', 'b-', '1234567890-abcdefghij')} b`)).toBe(`a ${REDACTED} b`);
    expect(redactString(`k ${j('AKI', 'A', 'ABCDEFGHIJKLMNOP')} z`)).toBe(`k ${REDACTED} z`);
  });

  it('[DEP-050] redacts a long prefixed token with an underscore-separated prefix', () => {
    const token = j('acme', '_svc_', BODY, BODY);
    expect(redactString(`x ${token} y`)).toBe(`x ${REDACTED} y`);
  });

  it('[DEP-050] keeps short prefixed identifiers that are not secret-shaped', () => {
    expect(redactString('run run_42 and repo_name_x')).toBe('run run_42 and repo_name_x');
  });
});

describe('secret redaction of private keys (DEP-050)', () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 1024,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  const pem = privateKey;
  const body = pem.split('\n')[1] ?? '';

  it('[DEP-050] redacts a complete RSA private key block', () => {
    const out = redactString(`key follows\n${pem}end`);
    expect(out).toBe('key follows\n[REDACTED PRIVATE KEY]\nend');
    expect(out).not.toContain(body);
  });

  it('[DEP-050] redacts a key block whose END marker is missing, to the end of the text', () => {
    const out = redactString(`pem: ${j('-----BEGIN ', 'OPENSSH PRIVATE KEY-----')}\n${body}`);
    expect(out).toBe('pem: [REDACTED PRIVATE KEY]');
  });

  it('[DEP-050] redacts several key blocks and keeps the text between them', () => {
    const out = redactString(`${pem}between${pem}`);
    expect(out).toBe('[REDACTED PRIVATE KEY]\nbetween[REDACTED PRIVATE KEY]\n');
  });

  it('[DEP-050] redacts a key block written with escaped newlines inside JSON', () => {
    const escaped = pem.replaceAll('\n', '\\n');
    expect(redactString(`{"key":"${escaped}"}`)).not.toContain(body);
  });
});

describe('secret redaction of URLs and key-value pairs (DEP-050)', () => {
  it('[DEP-050] removes URL userinfo, keeping the host and path', () => {
    expect(redactString(j('clone https://x-token-auth:', BODY, '@host.example/org/repo.git'))).toBe(
      `clone https://${REDACTED}@host.example/org/repo.git`,
    );
    expect(redactString('postgres://app:p%40ss@db.internal:5432/gm')).toBe(
      `postgres://${REDACTED}@db.internal:5432/gm`,
    );
  });

  it('[DEP-050] leaves URLs without userinfo unchanged', () => {
    const text = 'GET https://api.example.com/v1/repos?page=2 returned 200';
    expect(redactString(text)).toBe(text);
  });

  it('[DEP-050] redacts an unquoted password up to the end of the line, spaces included', () => {
    expect(redactString(j('connect pass', 'word=hunter 2 TAIL'))).toBe(
      `connect password=${REDACTED}`,
    );
  });

  it('[DEP-050] stops an unquoted value at a query delimiter and keeps the next parameter', () => {
    expect(redactString('/cb?sig=abc123&page=2')).toBe(`/cb?sig=${REDACTED}&page=2`);
    expect(redactString('/cb?code=xyz&state=ok')).toBe(`/cb?code=${REDACTED}&state=ok`);
  });

  it('[DEP-050] redacts quoted and escaped JSON values of sensitive keys', () => {
    expect(redactString(j('{"pass', 'word":"hun ter"}'))).toBe(`{"password":"${REDACTED}"}`);
    expect(redactString('{\\"token\\":\\"abc\\"}')).toBe(`{\\"token\\":\\"${REDACTED}\\"}`);
    expect(redactString(j("'pass", "word': 'x y'"))).toBe(`'password': '${REDACTED}'`);
  });

  it('[DEP-050] redacts the parameter families named in the requirement', () => {
    for (const name of [
      'pwd',
      'auth',
      'jwt',
      'dsn',
      'sig',
      'signature',
      'key',
      'code',
      'session',
      'bearer',
      'client_secret',
      'access_token',
      'refresh_token',
      'api_key',
      'private_key',
    ]) {
      expect(redactString(`${name}=VALUE1 next`), name).toBe(`${name}=${REDACTED}`);
    }
  });

  it('[DEP-050] leaves ordinary keys and their values alone', () => {
    expect(redactString('user=gm status=ok count=3')).toBe('user=gm status=ok count=3');
    expect(redactString('statusText: fine')).toBe('statusText: fine');
  });

  it('[DEP-050] keeps non-secret keys before a secret one', () => {
    expect(redactString(j('user=gm pass', 'word=x'))).toBe(`user=gm password=${REDACTED}`);
  });
});

describe('key names (DEP-050)', () => {
  it('[DEP-050] recognises secret names in any casing and separator style', () => {
    for (const key of [
      'Authorization',
      'dbPassword',
      'github_token',
      'client-secret',
      'apiKey',
      'Set-Cookie',
      'sig',
    ]) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
  });

  it('[DEP-050] does not treat unrelated names as secrets', () => {
    for (const key of ['runId', 'statusText', 'passenger', 'keyboard', 'signalCount', 'bypass']) {
      expect(isSensitiveKey(key), key).toBe(false);
    }
  });
});

describe('secret redaction of values (DEP-050)', () => {
  it('[DEP-050] replaces the value of every sensitive key, whatever its type', () => {
    const out = redactValue({
      token: 'abc',
      password: 'x',
      apiKey: 1234,
      privateKey: { pem: 'nested' },
      clientSecret: 'shh',
      headers: { Authorization: 'Bearer zzz', accept: 'application/json' },
      cookie: 'sid=1',
      credentials: { user: 'u' },
      dbPassword: 'p',
      runId: 'run-1',
    });
    expect(out).toEqual({
      token: REDACTED,
      password: REDACTED,
      apiKey: REDACTED,
      privateKey: REDACTED,
      clientSecret: REDACTED,
      headers: { Authorization: REDACTED, accept: 'application/json' },
      cookie: REDACTED,
      credentials: REDACTED,
      dbPassword: REDACTED,
      runId: 'run-1',
    });
  });

  it('[DEP-050] keeps null and undefined under sensitive keys so the shape stays visible', () => {
    expect(redactValue({ token: null, password: undefined })).toEqual({
      token: null,
      password: undefined,
    });
  });

  it('[DEP-050] scrubs strings inside arrays and nested objects', () => {
    const out = redactValue({
      urls: [j('https://u:', BODY, '@h.example/a'), { note: 'x' }],
    });
    expect(out).toEqual({
      urls: [`https://${REDACTED}@h.example/a`, { note: 'x' }],
    });
  });

  it('[DEP-050] returns errors as plain objects with a scrubbed message and stack', () => {
    const error = new TypeError(j('clone failed for https://u:', BODY, '@h.example/r.git'));
    error.stack = `TypeError: ${error.message}\n    at x`;
    const out = redactValue(error) as Record<string, unknown>;
    expect(out).toMatchObject({
      type: 'TypeError',
      message: `clone failed for https://${REDACTED}@h.example/r.git`,
    });
    expect(JSON.stringify(out)).not.toContain(BODY);
  });

  it('[DEP-050] scrubs an error cause and the members of an AggregateError', () => {
    const inner = new Error(j('inner Authorization: Bearer ', BODY));
    const outer = new Error('outer', { cause: inner });
    const aggregate = new AggregateError([new Error(j('pass', 'word=oops1234')), outer], 'many');
    const out = JSON.stringify(redactValue(aggregate));
    expect(out).not.toContain(BODY);
    expect(out).not.toContain('oops1234');
    expect(out).toContain('"cause"');
  });

  it('[DEP-050] drops functions and symbols, and summarizes binary data', () => {
    expect(
      redactValue({
        fn: () => 1,
        sym: Symbol('s'),
        bytes: new Uint8Array([1, 2]),
      }),
    ).toEqual({
      fn: undefined,
      sym: undefined,
      bytes: '[binary]',
    });
  });

  it('[DEP-050] passes dates and non-string primitives through', () => {
    const at = new Date('2026-10-08T00:00:00Z');
    expect(redactValue({ at, n: 3, ok: true, none: null })).toEqual({
      at,
      n: 3,
      ok: true,
      none: null,
    });
  });

  it('[DEP-050] summarizes class instances by their string form, scrubbed', () => {
    class Sample {
      toString(): string {
        return j('Sample pass', 'word=oops');
      }
    }
    expect(redactValue({ item: new Sample() })).toEqual({
      item: `Sample password=${REDACTED}`,
    });
  });

  it('[DEP-050] cuts cycles and very deep values instead of recursing forever', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;
    expect(redactValue(cyclic)).toEqual({ name: 'loop', self: '[Circular]' });

    let deep: Record<string, unknown> = { leaf: 'value' };
    for (let i = 0; i < 12; i += 1) deep = { child: deep };
    expect(JSON.stringify(redactValue(deep))).toContain('[Truncated]');
  });

  it('[DEP-050] shared, non-circular references are copied, not reported as cycles', () => {
    const shared = { a: 1 };
    expect(redactValue({ x: shared, y: shared })).toEqual({
      x: { a: 1 },
      y: { a: 1 },
    });
  });

  it('[DEP-050] the pino redact paths cover the usual secret locations', () => {
    expect(REDACT_PATHS).toEqual(
      expect.arrayContaining(['headers.authorization', '*.password', '*.*.token', 'privateKey']),
    );
  });
});

describe('bounded scanning (DEP-050)', () => {
  const MEGABYTE = 1024 * 1024;
  const shapes: [string, string][] = [
    ['dash-separated words', 'a-'],
    ['dotted words', 'a.'],
    ['repeated scheme', 'a://'],
    ['repeated key', 'password='],
    ['repeated header', 'Cookie:'],
    ['repeated JWT head', '-eyJ'],
    ['repeated PEM begin', j('-----BEGIN ', 'PRIVATE KEY-----')],
    ['repeated token prefix', 'ghp_'],
    ['repeated prefixed word', 'ab_'],
  ];

  for (const [name, unit] of shapes) {
    it(`[DEP-050] scans a 1 MB ${name} input within the time budget`, () => {
      const input = unit.repeat(Math.ceil(MEGABYTE / unit.length));
      const started = performance.now();
      const out = redactString(input);
      const elapsed = performance.now() - started;
      expect(elapsed).toBeLessThan(1000);
      expect(out.length).toBeLessThanOrEqual(MAX_TEXT_LENGTH + 64);
    });
  }

  it('[DEP-050] cuts text longer than the scan limit and marks the cut', () => {
    const out = redactString(`${'x'.repeat(MAX_TEXT_LENGTH)} tail`);
    expect(out).toContain('[truncated');
    expect(out).not.toContain('tail');
  });

  it('[DEP-050] a token split by the scan limit is removed, not left as a fragment', () => {
    const token = j('ghp_', BODY);
    const input = `${'-'.repeat(MAX_TEXT_LENGTH - 20)}${token}${'z'.repeat(10)}`;
    const out = redactString(input);
    expect(out).not.toContain(BODY.slice(0, 8));
  });
});

describe('encoded, folded and spaced secrets (DEP-050)', () => {
  it('[DEP-050] redacts a value after a percent-encoded separator', () => {
    // A sensitive word followed by an encoded separator is caught before decoding, so the text
    // stays as written; the encoded key=value pair is caught in the decoded level.
    expect(redactString('token%3Dabc')).toBe(`token%3D${REDACTED}`);
    expect(redactString('?a=1&password%3Dhunter&b=2')).toBe(`?a=1&password%3D${REDACTED}&b=2`);
    expect(redactString('?a=1&x_pw%3D1%26user_password%3Dhunter')).toBe(
      `?a=1&x_pw=1%26user_password=${REDACTED}`,
    );
  });

  it('[DEP-050] does not stop a percent-encoded value at an encoded ampersand', () => {
    // `%26` stays encoded in the shadow, so it cannot end the value: over-redaction, fail safe.
    expect(redactString('client_secret%3Dabc%26grant_type%3Dx')).toBe(
      `client_secret%3D${REDACTED}`,
    );
    expect(redactString('client_secret=abc&grant_type=x')).toBe(
      `client_secret=${REDACTED}&grant_type=x`,
    );
  });

  it('[DEP-050] redacts a percent-encoded Authorization header and a nested redirect token', () => {
    expect(redactString('Authorization%3A%20Bearer%20abc')).toBe(`Authorization: ${REDACTED}`);
    expect(redactString('redirect=https%3A%2F%2Fh%2F%3Faccess_token%3Dabc')).toBe(
      `redirect=https://h/?access_token=${REDACTED}`,
    );
  });

  it('[DEP-050] redacts a doubly percent-encoded token', () => {
    expect(redactString('x%253Dtoken%25253Dabc')).toContain(REDACTED);
    expect(redactString('x%253Dtoken%25253Dabc')).not.toContain('abc');
  });

  it('[DEP-050] text without percent encoding is returned unchanged', () => {
    expect(redactString('path /a/b 100% done')).toBe('path /a/b 100% done');
  });

  it('[DEP-050] redacts header values continued on folded lines', () => {
    expect(redactString('Authorization: Digest a,\r\n  response="abc"\r\nnext: line')).toBe(
      `Authorization: ${REDACTED}\r\nnext: line`,
    );
    expect(redactString('Cookie: a=1;\r\n b=abc')).toBe(`Cookie: ${REDACTED}`);
  });

  it('[DEP-050] a quoted value with a raw newline is redacted to its closing quote, not only its first line', () => {
    expect(redactString('password="abc\ndef" tail')).toBe(`password="${REDACTED}" tail`);
  });

  it('[DEP-050] an unclosed quoted value is redacted to the end of the text', () => {
    expect(redactString('token="abc\nmore text')).toBe(`token="${REDACTED}`);
  });

  it('[DEP-050] a sensitive word followed by whitespace redacts one value run', () => {
    expect(redactString('login with password hunter2 now')).toBe(
      `login with password ${REDACTED} now`,
    );
    expect(redactString('bad password is abc123')).toBe(`bad password is ${REDACTED}`);
    expect(redactString('api key ABCDEF123456')).toBe(`api key ${REDACTED}`);
    expect(redactString('run --password VALUE1 --dry')).toBe(`run --password ${REDACTED} --dry`);
  });

  it('[DEP-050] a quoted value after a sensitive word is redacted whole', () => {
    expect(redactString('password "a b c" end')).toBe(`password "${REDACTED}" end`);
  });

  it('[DEP-050] decodes percent escapes as UTF-8 and keeps ordinary text as written', () => {
    expect(redactString('caf%C3%A9 and %E2%9C%93 ok')).toBe('caf%C3%A9 and %E2%9C%93 ok');
    expect(redactString('password%EF%BC%9AHUNTER_FW')).toBe(`password%EF%BC%9A${REDACTED}`);
    expect(redactString('x=1&password%EF%BC%9A%20HUNTER_FW')).not.toContain('HUNTER_FW');
  });

  it('[DEP-050] fullwidth colon and equals sign separate a key from its value', () => {
    expect(redactString('password：HUNTER_FW')).toBe(`password：${REDACTED}`);
    expect(redactString('password： HUNTER')).toBe(`password： ${REDACTED}`);
    expect(redactString('token＝HUNTER_EQ')).toBe(`token＝${REDACTED}`);
  });

  it('[DEP-050] a form-encoded plus is a space', () => {
    expect(redactString('password+is+HUNTER_PL')).toBe(`password+is+${REDACTED}`);
    expect(redactString('Bearer+HUNTER_PB')).toBe(`Bearer ${REDACTED}`);
  });

  it('[DEP-050] a sensitive word may be followed by is, was, a colon or an equals sign', () => {
    expect(redactString('the password is: LEAKO')).toBe(`the password is: ${REDACTED}`);
    expect(redactString('password was = LEAKP')).toBe(`password was = ${REDACTED}`);
    expect(redactString('password == LEAKQ')).toBe(`password =${REDACTED}`);
    expect(redactString('the pin is 1234 ok')).toBe(`the pin is ${REDACTED} ok`);
    expect(redactString('passcode LEAKR')).toBe(`passcode ${REDACTED}`);
    expect(redactString('password:')).toBe('password:');
  });

  it('[DEP-050] redacts the user:secret argument of a command line', () => {
    expect(redactString('curl -u bob:LEAKS https://h/x')).toBe(`curl -u ${REDACTED} https://h/x`);
    expect(redactString('curl --user bob:LEAKT -s')).toBe(`curl --user ${REDACTED} -s`);
    expect(redactString("curl -u 'bob:LEAKU v' -s")).toBe(`curl -u ${REDACTED} -s`);
    expect(redactString('curl --proxy-user=bob:LEAKV')).toBe(`curl --proxy-user=${REDACTED}`);
    expect(redactString('ls -u root')).toBe('ls -u root');
  });

  it('[DEP-050] redacts a url-safe base64 user:secret', () => {
    const blob = Buffer.from('user:se>cret???>valu~e').toString('base64url');
    expect(blob).toMatch(/[-_]/);
    expect(redactString(`cred ${blob} end`)).toBe(`cred ${REDACTED} end`);
  });

  it('[DEP-050] redacts a base64 blob that decodes to user:secret', () => {
    const blob = Buffer.from(['gm', 'secretvalue'].join(':')).toString('base64');
    expect(redactString(`cred ${blob} end`)).toBe(`cred ${REDACTED} end`);
  });

  it('[DEP-050] keeps base64 text that does not decode to a credential pair', () => {
    const blob = Buffer.from('plain text without a colon').toString('base64');
    expect(redactString(`data ${blob}`)).toBe(`data ${blob}`);
  });

  it('[DEP-050] scans encoded and spaced inputs of 1 MB within the time budget', () => {
    for (const unit of [
      '%3D',
      '%25',
      'password ',
      'password=',
      '\r\n ',
      '"x\n',
      'api key ',
      '--token ',
      '%2526',
      '%E3%80%80',
      'password is ',
      'password+',
      '-u ',
      '-u "a',
      'password was ==',
      'a-_'.repeat(8),
    ]) {
      const input = unit.repeat(Math.ceil((1024 * 1024) / unit.length));
      const started = performance.now();
      redactString(input);
      expect(performance.now() - started, unit).toBeLessThan(1000);
    }
  });
});

describe('chained scrub, encoded structure and nested escapes (DEP-050)', () => {
  it('[DEP-050] keeps a redaction that only the scrub before decoding made', () => {
    expect(redactString('git clone https://bob:ab%2FcdLEAK@host.example/a/b.git')).toBe(
      `git clone https://${REDACTED}@host.example/a/b.git`,
    );
    expect(redactString('curl -u bob:pa%20ssTAIL')).toBe(`curl -u ${REDACTED}`);
    expect(redactString('password hunter2%20TAIL')).toBe(`password ${REDACTED}`);
  });

  it('[DEP-050] redacts userinfo whose password holds a decoded / ? or #', () => {
    expect(redactString('url=https%3A%2F%2Fbob%3Aab%252FcdLEAK%40h%2Fx')).toBe(
      `url=https://${REDACTED}@h/x`,
    );
    expect(redactString('see https://bob:a/b?c#d@h/x now')).toBe(`see https://${REDACTED}@h/x now`);
    expect(redactString('see https://registry.example/@scope/pkg')).toBe(
      'see https://registry.example/@scope/pkg',
    );
  });

  it('[DEP-050] treats %22 and %27 as quotes in keys, separators and values', () => {
    expect(redactString('payload=%7B%22password%22%3A%22LEAK%22%7D')).toBe(
      `payload={%22password%22:%22${REDACTED}%22}`,
    );
    expect(redactString('d=%7B%22user%22%3A%22bob%22%2C%22pwd%22%3A%22LEAK%22%7D')).toBe(
      `d={%22user%22:%22bob%22%2C%22pwd%22:%22${REDACTED}%22}`,
    );
    expect(redactString('body=%7B%22access_token%22%3A+%22LEAK%22%7D')).toBe(
      `body={%22access_token%22:+%22${REDACTED}%22}`,
    );
    expect(redactString('d=%7B%27password%27%3A%27LEAK%27%7D')).toBe(
      `d={%27password%27:%27${REDACTED}%27}`,
    );
  });

  it('[DEP-050] an escaped quote one level deeper does not close an escaped JSON value', () => {
    expect(redactString('{\\"password\\":\\"a\\\\\\"LEAK\\",\\"user\\":\\"bob\\"}')).toBe(
      `{\\"password\\":\\"${REDACTED}\\",\\"user\\":\\"bob\\"}`,
    );
    expect(redactString('{\\"password\\":\\"a\\\\\\\\\\\\\\"LEAK\\"}')).toBe(
      `{\\"password\\":\\"${REDACTED}\\"}`,
    );
    expect(redactString('{"password":"a\\\\","user":"bob"}')).toBe(
      `{"password":"${REDACTED}","user":"bob"}`,
    );
  });

  it('[DEP-050] a closing quote followed by a word character does not close the value', () => {
    expect(redactString('{"password":"a"LEAK"}')).toBe(`{"password":"${REDACTED}"}`);
    expect(redactString('say "hello"world')).toBe('say "hello"world');
  });

  it('[DEP-050] Unicode and encoded spaces separate a word from its value', () => {
    expect(redactString('password\u00A0LEAK')).toBe(`password\u00A0${REDACTED}`);
    expect(redactString('password\u2003LEAK')).toBe(`password\u2003${REDACTED}`);
    expect(redactString('Bearer\u00A0LEAK')).toBe(`Bearer ${REDACTED}`);
    expect(redactString('password%20%3D%20LEAK')).toBe(`password%20%3D%20${REDACTED}`);
  });

  it('[DEP-050] a rule may start right after an escape', () => {
    expect(redactString('"ok\\npwd=LEAK"')).not.toContain('LEAK');
    expect(redactString('ok%5Cnpasscode%20LEAK')).not.toContain('LEAK');
    expect(redactString(j('%22gh', 'p_', BODY, '%22'))).toBe(`%22${REDACTED}%22`);
  });

  it('[DEP-050] handles triple percent-encoding', () => {
    expect(redactString('x%253Dtoken%25253DLEAK')).not.toContain('LEAK');
  });

  it('[DEP-050] scans the new adversarial shapes of 1 MB within the time budget', () => {
    for (const unit of [
      'a://b:',
      'a://b:/',
      '%22a://',
      'password+',
      '%22',
      '%5C%22',
      '\\\\\\"',
      'password=\\"',
      'password="a"b',
      '"a"b',
      '%22password%22:%22',
      'password %22',
      'password=%5C%22a%22',
      '\u00A0password\u00A0',
      '\\npwd',
      'cred+',
      '%20Ym9i',
      j('-----BEGIN+', 'PRIVATE+KEY-----'),
    ]) {
      const input = unit.repeat(Math.ceil((1024 * 1024) / unit.length));
      const started = performance.now();
      redactString(input);
      expect(performance.now() - started, unit).toBeLessThan(1000);
    }
  });
});
