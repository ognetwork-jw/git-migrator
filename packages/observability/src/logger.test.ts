import { generateKeyPairSync } from 'node:crypto';
import { context, trace } from '@opentelemetry/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from './logger.ts';
import { REDACTED } from './redact.ts';
import { startTracing, type TracingHandle } from './tracing.ts';

type Line = Record<string, unknown>;

/** A sink that keeps every written line, so a test reads exactly what would reach stdout. */
function sink() {
  const lines: string[] = [];
  return {
    destination: { write: (line: string) => void lines.push(line) },
    records: (): Line[] => lines.map((line) => JSON.parse(line) as Line),
    text: (): string => lines.join(''),
  };
}

/*
 * Secret-shaped values are assembled at run time from fragments, so no secret-shaped literal is
 * committed (the repository runs gitleaks). See ADR-0052.
 */
const j = (...parts: string[]): string => parts.join('');
const BODY = j('Q2x7Rk9Lm3', 'Np8Qr1St6U', 'v4Wx0Yz5Ab2Cd9Ef');
const GH_TOKEN = j('gh', 'p_', BODY);
const JWT = j('ey', 'JhbGciOiJIUzI1NiJ9', '.', 'ey', 'JzdWIiOiJ4In0', '.', 'c2lnbmF0dXJlMTIz');
const { privateKey: PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 1024,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});
const KEY_BODY = PRIVATE_KEY.split('\n')[1] ?? '';

/** Each entry: a call that must not write its secret, and the secret it must not write. */
const LEAK_CASES: [string, (log: ReturnType<typeof createLogger>) => void, string][] = [
  ['token field', (log) => log.info({ token: GH_TOKEN, attempt: 2 }, 'call'), GH_TOKEN],
  [
    'encoded ampersands inside a password',
    (log) => log.info('username=bob&password=p%26ss%26LEAKA&next=/'),
    'LEAKA',
  ],
  ['encoded semicolon inside a password', (log) => log.info('password=ab%3BLEAKB&x=1'), 'LEAKB'],
  ['encoded quote inside a JSON password', (log) => log.info('{"password":"ab%22LEAKE"}'), 'LEAKE'],
  [
    'double-encoded ampersand inside a password',
    (log) => log.info('password=a%2526LEAKAK&x=1'),
    'LEAKAK',
  ],
  ['encoded newline inside a password', (log) => log.info('password=ab%0ALEAKC'), 'LEAKC'],
  ['encoded CRLF inside a cookie', (log) => log.info('Cookie: a=1%0D%0ALEAKD'), 'LEAKD'],
  ['fullwidth colon', (log) => log.info('password：HUNTER_FW'), 'HUNTER_FW'],
  ['fullwidth colon and space', (log) => log.info('password： HUNTERFW2'), 'HUNTERFW2'],
  ['percent-encoded fullwidth colon', (log) => log.info('password%EF%BC%9AHUNTER_FE'), 'HUNTER_FE'],
  ['plus as space after a word', (log) => log.info('password+is+HUNTER_PL'), 'HUNTER_PL'],
  ['plus as space after a scheme', (log) => log.info('Bearer+HUNTER_PB'), 'HUNTER_PB'],
  ['is-colon after a word', (log) => log.info('the password is: LEAKO'), 'LEAKO'],
  ['was-equals after a word', (log) => log.info('password was = LEAKP'), 'LEAKP'],
  ['curl -u credential', (log) => log.info('curl -u bob:LEAKS https://h/x'), 'LEAKS'],
  ['curl --user credential', (log) => log.info('curl --user bob:LEAKT -s'), 'LEAKT'],
  [
    'url-safe base64 user:secret',
    (log) => log.info(`cred ${Buffer.from('user:se>cret???>valu~e').toString('base64url')}`),
    Buffer.from('user:se>cret???>valu~e').toString('base64url'),
  ],
  [
    'Authorization header value (whole value, not only the scheme)',
    (log) => log.info({ note: 'retry' }, j('Authorization: tok', 'en abcdefSECRET')),
    'abcdefSECRET',
  ],
  [
    'Digest Authorization header',
    (log) =>
      log.info(
        {
          req: {
            headers: {
              Authorization: j('Dig', 'est username=bob response=SECRETx'),
            },
          },
        },
        'req',
      ),
    'SECRETx',
  ],
  [
    'every cookie in a Cookie header',
    (log) => log.warn(j('Cookie: a=SECRET', 'A; b=SECRET', 'B')),
    'SECRETB',
  ],
  ['Set-Cookie header', (log) => log.warn('Set-Cookie: sid=SECRETC; Path=/'), 'SECRETC'],
  ['Bearer credential in a message', (log) => log.info(j('sent Bear', 'er ', BODY)), BODY],
  ['signed JWT in a message', (log) => log.info(`id ${JWT}`), JWT],
  ['GitHub token in a message', (log) => log.info(`clone with ${GH_TOKEN}`), GH_TOKEN],
  ['Bitbucket API token shape', (log) => log.info(j('ATB', 'B', BODY)), BODY],
  [
    'Slack-style key shape',
    (log) => log.info(j('xox', 'b-', '1234567890-abcdefghij')),
    '1234567890-abcdefghij',
  ],
  [
    'AWS access key identifier',
    (log) => log.info(j('AKI', 'A', 'ABCDEFGHIJKLMNOP')),
    'ABCDEFGHIJKLMNOP',
  ],
  [
    'password unquoted with spaces',
    (log) => log.info(j('connect pass', 'word=hunter 2 TAIL')),
    'TAIL',
  ],
  [
    'password in a field',
    (log) => log.info({ password: 'hunter2', user: 'gm' }, 'login'),
    'hunter2',
  ],
  [
    'password in a message',
    (log) => log.warn(j('connect failed, pass', 'word=hunter2')),
    'hunter2',
  ],
  [
    'JSON credential string',
    (log) => log.info(j('loaded {"user":"gm","pass', 'word":"hun ter"}')),
    'hun ter',
  ],
  ['escaped JSON token', (log) => log.info('body {\\"token\\":\\"SECRETQ\\"}'), 'SECRETQ'],
  ['query signature', (log) => log.info('/cb?sig=SECRETS&page=2'), 'SECRETS'],
  ['query code', (log) => log.info('/cb?code=SECRETD&state=ok'), 'SECRETD'],
  [
    'client_secret and access_token pairs',
    (log) => log.info('client_secret=SECRETE access_token=SECRETF'),
    'SECRETF',
  ],
  [
    'private key in a field',
    (log) => log.info({ privateKey: PRIVATE_KEY }, 'loaded app key'),
    KEY_BODY,
  ],
  ['private key in a message', (log) => log.info(`key material: ${PRIVATE_KEY}`), KEY_BODY],
  [
    'private key with escaped newlines in JSON',
    (log) => log.info(`{"k":"${PRIVATE_KEY.replaceAll('\n', '\\n')}"}`),
    KEY_BODY,
  ],
  [
    'credential object',
    (log) => log.info({ credentials: { username: 'gm', password: 'SECRETG' } }, 'creds'),
    'SECRETG',
  ],
  [
    'URL userinfo in a message',
    (log) => log.info(j('cloning https://x-token-auth:', BODY, '@host.example/r.git')),
    BODY,
  ],
  [
    'URL userinfo in a field',
    (log) => log.info({ remote: j('https://u:', BODY, '@h.example/') }, 'remote'),
    BODY,
  ],
  [
    'secret in an error message and cause',
    (log) =>
      log.error(
        {
          job: 'j1',
          err: new Error(j('fetch failed for https://u:SECRETH@h.example/'), {
            cause: new Error(j('Authorization: Basic SECRETI')),
          }),
        },
        'job failed',
      ),
    'SECRETH',
  ],
  [
    'secret in a bound child field',
    (log) => log.child({ apiToken: GH_TOKEN }).info('bound'),
    GH_TOKEN,
  ],
  ['printf argument carrying a token', (log) => log.info('tok %s', GH_TOKEN), GH_TOKEN],
  [
    'positional argument with no recognizable shape',
    (log) => log.info('value %s', 'SECRETJ'),
    'SECRETJ',
  ],
  [
    'sensitive word then space then value',
    (log) => log.info(j('login with pass', 'word hunter2 now')),
    'hunter2',
  ],
  ['sensitive word then space, in prose', (log) => log.info(j('bad pass', 'word ', BODY)), BODY],
  [
    'CLI long option with a space-separated value',
    (log) => log.info(j('run --pass', 'word SECRETL --dry')),
    'SECRETL',
  ],
  [
    'CLI long option with an equals value',
    (log) => log.info(j('run --to', 'ken=SECRETM')),
    'SECRETM',
  ],
  ['quoted value with a raw newline', (log) => log.info(j('pass', 'word="abc\ndef" tail')), 'def'],
  [
    'quoted value with a raw newline, single quotes',
    (log) => log.info(j('pass', "word='abc\ndef' tail")),
    'def',
  ],
  [
    'percent-encoded separator after a token name',
    (log) => log.info(j('x?tok', 'en%3DSECRETN')),
    'SECRETN',
  ],
  [
    'percent-encoded pair in a query string',
    (log) => log.info('/cb?a=1&password%3DSECRETO&b=2'),
    'SECRETO',
  ],
  [
    'percent-encoded ampersand after a secret',
    (log) => log.info('client_secret%3DSECRETP%26grant_type%3Dx'),
    'SECRETP',
  ],
  [
    'percent-encoded Authorization header',
    (log) => log.info('Authorization%3A%20Bearer%20SECRETR'),
    'SECRETR',
  ],
  [
    'percent-encoded redirect carrying a token',
    (log) => log.info('redirect=https%3A%2F%2Fh%2F%3Faccess_token%3DSECRETT'),
    'SECRETT',
  ],
  ['doubly percent-encoded token', (log) => log.info('x%253Dtoken%25253DSECRETU'), 'SECRETU'],
  [
    'folded Digest Authorization continuation',
    (log) => log.info('Authorization: Digest a,\r\n  response="SECRETV"'),
    'SECRETV',
  ],
  ['folded Cookie continuation', (log) => log.info('Cookie: a=1;\r\n b=SECRETW'), 'SECRETW'],
  [
    'base64 user:secret credential',
    (log) => log.info(`cred ${Buffer.from(j('gm', ':SECRETX1234')).toString('base64')}`),
    'SECRETX1234',
  ],
];

describe('logger (DEP-050)', () => {
  it('[DEP-050] writes one JSON object per line with level, time, msg and service', () => {
    const out = sink();
    createLogger({ destination: out.destination, service: 'worker' }).info('started');
    const [record] = out.records();
    expect(record).toMatchObject({
      level: 'info',
      msg: 'started',
      service: 'worker',
    });
    expect(new Date(String(record?.time)).toISOString()).toBe(record?.time);
    expect(record).not.toHaveProperty('pid');
    expect(record).not.toHaveProperty('hostname');
  });

  it('[DEP-050] emits the level as its name and honours the configured level', () => {
    const out = sink();
    const log = createLogger({ destination: out.destination, level: 'warn' });
    log.info('hidden');
    log.warn('shown');
    log.error('also shown');
    expect(out.records().map((record) => record.level)).toEqual(['warn', 'error']);
  });

  it('[DEP-050] keeps bound fields such as runId, migrationId, jobId and component on every line', () => {
    const out = sink();
    const log = createLogger({ destination: out.destination }).child({
      component: 'worker',
      runId: 'run-1',
      migrationId: 'mig-2',
      jobId: 'job-3',
    });
    log.info({ step: 'push' }, 'step done');
    expect(out.records()[0]).toMatchObject({
      component: 'worker',
      runId: 'run-1',
      migrationId: 'mig-2',
      jobId: 'job-3',
      step: 'push',
      msg: 'step done',
    });
  });

  it('[DEP-050] writes the error message as msg and the error under err when the call has no message', () => {
    const out = sink();
    createLogger({ destination: out.destination }).error(new Error('disk full'));
    const [record] = out.records();
    expect(record?.msg).toBe('disk full');
    expect(record?.err).toMatchObject({ type: 'Error', message: 'disk full' });
  });

  it('[DEP-050] keeps an ordinary message and its fields unchanged', () => {
    const out = sink();
    createLogger({ destination: out.destination }).info(
      { runId: 'run-9', count: 3 },
      'run 9 finished: 3 items',
    );
    expect(out.records()[0]).toMatchObject({
      runId: 'run-9',
      count: 3,
      msg: 'run 9 finished: 3 items',
    });
  });
});

describe('logger secret redaction at the output boundary (DEP-050, mandatory)', () => {
  for (const [name, call, secret] of LEAK_CASES) {
    it(`[DEP-050] never writes ${name}`, () => {
      const out = sink();
      call(createLogger({ destination: out.destination, level: 'trace' }));
      expect(out.text()).not.toContain(secret);
      expect(out.text()).toContain('REDACTED');
    });
  }

  it('[DEP-050] redacts a header value in a field while keeping the other fields', () => {
    const out = sink();
    createLogger({ destination: out.destination }).info(
      {
        req: {
          headers: { Authorization: GH_TOKEN, accept: 'application/json' },
        },
      },
      'request',
    );
    expect(out.records()[0]).toMatchObject({
      req: { headers: { Authorization: REDACTED, accept: 'application/json' } },
    });
  });

  it('[DEP-050] writes the surrounding text of a spaced secret unchanged', () => {
    const out = sink();
    createLogger({ destination: out.destination }).info('login with password hunter2 now');
    expect(out.records()[0]?.msg).toBe('login with password [REDACTED] now');
  });

  it('[DEP-050] a sensitive word followed by a space redacts the next word (false positives accepted, ADR-0052)', () => {
    const out = sink();
    createLogger({ destination: out.destination }).info('password reset requested');
    expect(out.records()[0]?.msg).toBe('password [REDACTED] requested');
  });

  it('[DEP-050] writes positional arguments as [REDACTED] (ADR-0052)', () => {
    const out = sink();
    createLogger({ destination: out.destination }).info('processed %s items for %s', '3', 'run-7');
    expect(out.records()[0]?.msg).toBe(`processed ${REDACTED} items for ${REDACTED}`);
  });

  it('[DEP-050] writes the error of a call with a message in err, scrubbed, not dropped', () => {
    const out = sink();
    const error = new Error('boom');
    Object.assign(error, { password: 'SECRETK' });
    createLogger({ destination: out.destination }).error({ job: 'j1', err: error }, 'job failed');
    expect(out.text()).not.toContain('SECRETK');
    expect(out.records()[0]).toMatchObject({
      job: 'j1',
      msg: 'job failed',
      err: { password: REDACTED, message: 'boom' },
    });
  });
});

describe('logger trace correlation (DEP-050)', () => {
  let tracing: TracingHandle;

  beforeAll(() => {
    tracing = startTracing({ serviceName: 'logger-test' });
  });

  afterAll(async () => {
    await tracing.shutdown();
  });

  it('[DEP-050] adds traceId to lines written inside an active span', () => {
    const out = sink();
    const log = createLogger({ destination: out.destination });
    const span = trace.getTracer('logger-test').startSpan('unit-of-work');
    context.with(trace.setSpan(context.active(), span), () => log.info('inside span'));
    span.end();
    expect(out.records()[0]?.traceId).toBe(span.spanContext().traceId);
  });

  it('[DEP-050] omits traceId outside a span', () => {
    const out = sink();
    createLogger({ destination: out.destination }).info('outside span');
    expect(out.records()[0]).not.toHaveProperty('traceId');
  });
});

describe('logger bypasses (DEP-050, T-004 follow-ups)', () => {
  it('[DEP-050] scrubs a child msgPrefix, also when the secret is split between prefix and message', () => {
    const out = sink();
    const log = createLogger({ destination: out.destination });
    log.child({}, { msgPrefix: 'token=LEAKPFX1 ' }).info('pushed');
    log.child({}, { msgPrefix: 'password=' }).info('LEAKPFX2');
    log.child({}, { msgPrefix: 'pass' }).child({}, { msgPrefix: 'word=' }).warn('LEAKPFX3');
    log.child({}, { msgPrefix: 'token=' }).error(new Error('abc123'));
    expect(out.text()).not.toMatch(/LEAKPFX/);
    expect(out.records().map((record) => record.msg)).toEqual([
      `token=${REDACTED}`,
      `password=${REDACTED}`,
      `password=${REDACTED}`,
      `token=${REDACTED}`,
    ]);
  });

  it('[DEP-050] keeps an ordinary msgPrefix and reports it', () => {
    const out = sink();
    const child = createLogger({ destination: out.destination })
      .child({}, { msgPrefix: '[run] ' })
      .child({}, { msgPrefix: '[push] ' });
    child.info('done');
    expect(out.records()[0]?.msg).toBe('[run] [push] done');
    expect(child.msgPrefix).toBe('[run] [push] ');
  });

  it('[DEP-050] scrubs setBindings on the root logger, a child and a grandchild', () => {
    const out = sink();
    const root = createLogger({ destination: out.destination });
    const child = root.child({ component: 'c' });
    const grandchild = child.child({ step: 's' });
    root.setBindings({ token: 'LEAKSB1' });
    child.setBindings({ note: 'password=LEAKSB2', nested: { secret: 'LEAKSB3' } });
    grandchild.setBindings({ remote: 'https://bob:LEAKSB4@host/x.git' });
    root.info('a');
    child.info('b');
    grandchild.info('c');
    expect(out.text()).not.toMatch(/LEAKSB/);
    expect(out.records()[1]).toMatchObject({ component: 'c', note: `password=${REDACTED}` });
  });

  it('[DEP-050] logs a 1 MB error made of a command-line user and colons within the time budget', () => {
    for (const head of ['-u "', "-u '", '--user=']) {
      const out = sink();
      const log = createLogger({ destination: out.destination });
      const started = performance.now();
      log.error(new Error(head + ':'.repeat(1024 * 1024)));
      expect(performance.now() - started, head).toBeLessThan(1000);
    }
  });
});
