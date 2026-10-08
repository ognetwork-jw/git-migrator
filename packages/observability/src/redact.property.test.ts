import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.ts';
import { redactString, scrubPlain } from './redact.ts';

/*
 * Property test for the chained scrub (DEP-050, ADR-0052). fast-check is not a dependency, so the
 * inputs come from a seeded generator: the same seed gives the same cases on every run, and a failing
 * case is printed whole. Secret-shaped values are assembled at run time (gitleaks).
 */

/** mulberry32: a small, seeded PRNG. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const j = (...parts: string[]): string => parts.join('');
const ALNUM = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

interface Case {
  readonly text: string;
  /** Fragments that must not be written. */
  readonly secrets: readonly string[];
}

function generator(seed: number) {
  const next = random(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
  const run = (length: number): string => Array.from({ length }, () => pick([...ALNUM])).join('');
  /** A marker: `Zx` and random characters, so it never spells a sensitive word by accident. */
  const marker = (): string => `Zx${run(10)}`;
  /** A two-part secret joined by a delimiter that must not split it in this shape. */
  const pair = (delimiters: readonly string[]) => {
    const head = marker();
    const tail = marker();
    return { value: head + pick(delimiters) + tail, secrets: [head, tail] };
  };
  const key = () =>
    pick(['password', 'token', 'client_secret', 'api_key', 'pwd', 'access_token', 'dbPassword']);

  const shapes: (() => Case)[] = [
    // key=value, unquoted: the value runs to the end of the line or a literal & or ;.
    () => {
      const s = pair(['', ' ', '%26', '%3B', '%0A', '%22', '%2526', '/', '%2F', '+', ',']);
      const sep = pick(['=', ': ', ' = ', '：', ' = ']);
      return { text: `${key()}${sep}${s.value}`, secrets: s.secrets };
    },
    // JSON object, plain quotes.
    () => {
      const s = pair(['', ' ', '\\"', '%22', '\n', ',', '}', "'", '\\\\']);
      return { text: `{"user":"bob","${key()}":"${s.value}","n":1}`, secrets: s.secrets };
    },
    // JSON inside a JSON string, at one or two levels of escaping.
    () => {
      const s = pair(['', ' ', '"', '\\', '\\"', ',', '}', "'"]);
      let text = JSON.stringify({ user: 'bob', [key()]: s.value });
      for (let depth = pick([1, 2]); depth > 0; depth -= 1) text = JSON.stringify(text);
      return { text, secrets: s.secrets };
    },
    // Whole header values.
    () => {
      const s = pair(['', ' ', ';', ',', '=', '%0D%0A']);
      const header = pick([
        `Authorization: Bearer ${s.value}`,
        j('Authorization: tok', 'en ', s.value),
        `Proxy-Authorization: Basic ${s.value}`,
        `Cookie: a=1; sid=${s.value}`,
        `X-Api-Key: ${s.value}`,
      ]);
      return { text: header, secrets: s.secrets };
    },
    // URL userinfo; the password may hold encoded or raw / ? # @.
    () => {
      const s = pair(['', '%2F', '%3F', '%23', '%40', '%20', '/', '?', '#', '@', '%252F']);
      const scheme = pick(['https', 'ssh', 'git+ssh', 'postgres']);
      return { text: `${scheme}://bob:${s.value}@host.example/a/b.git`, secrets: s.secrets };
    },
    // Command-line user.
    () => {
      const s = pair(['', '%20', '%2F', ':', '%26']);
      const flag = pick(['-u ', '--user ', '--user=', '--proxy-user=']);
      return { text: `curl ${flag}bob:${s.value} https://h.example/x`, secrets: s.secrets };
    },
    // A sensitive word, then spacing, then one value run.
    () => {
      const s = pair(['', '%20', '%26', '%2F', '-', '.', '%0A']);
      const lead = pick([
        'the password is ',
        'password: ',
        '--token ',
        'passcode ',
        'api key ',
        'password+is+',
        'password ',
        'secret was = ',
      ]);
      return { text: `${lead}${s.value} now`, secrets: s.secrets };
    },
    // Known token shapes; the random body must not be written.
    () => {
      const body = run(36);
      const token = pick([
        j('gh', 'p_', body),
        j('gh', 's_', body),
        j('github', '_pat_', body),
        j('AT', 'BB', body),
        j('acme', '_svc_', body),
      ]);
      return { text: `using ${token} for push`, secrets: [body.slice(0, 20)] };
    },
    // A base64 user:secret pair.
    () => {
      const blob = Buffer.from(`bob:${marker()}`).toString(pick(['base64', 'base64url'] as const));
      return { text: `cred ${blob} end`, secrets: [blob] };
    },
    // A private key block.
    () => {
      const s = pair(['\n', '']);
      const kind = pick(['RSA ', 'OPENSSH ', 'EC ', '']);
      return {
        text: j(
          '-----BEGIN ',
          kind,
          'PRIVATE KEY-----\n',
          s.value,
          '\n-----END ',
          kind,
          'PRIVATE KEY-----',
        ),
        secrets: s.secrets,
      };
    },
  ];

  const prefixes = ['', 'error: ', 'msg=', 'ok\n', 'request failed ', '{"note":"x"} '];
  const suffixes = ['', ' done', '&next=1', '\nstatus: 200', '"}', ';'];
  const encodings: ((text: string) => string)[] = [
    (text) => text,
    (text) => encodeURIComponent(text),
    (text) => encodeURIComponent(encodeURIComponent(text)),
    (text) => encodeURIComponent(text).replaceAll('%20', '+'),
    (text) => JSON.stringify(text),
    (text) => `payload=${encodeURIComponent(JSON.stringify({ body: text }))}`,
    (text) => text.replace(/[:=]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`),
  ];

  return (): Case => {
    const shape = pick(shapes)();
    const encode = pick(encodings);
    return {
      text: encode(pick(prefixes) + shape.text + pick(suffixes)),
      secrets: shape.secrets,
    };
  };
}

/** Cases per property. Raise REDACT_PROPERTY_RUNS (and change REDACT_PROPERTY_SEED) for a deeper search. */
const RUNS = Number(process.env.REDACT_PROPERTY_RUNS ?? 3000);
const TIMEOUT = Math.max(5000, RUNS * 2);
const SEED = Number(process.env.REDACT_PROPERTY_SEED ?? 0x5eed_0052);

describe('chained scrub properties (DEP-050)', () => {
  it(
    '[DEP-050] the output never holds a generated secret, in any supported shape or encoding',
    () => {
      const generate = generator(SEED);
      for (let i = 0; i < RUNS; i += 1) {
        const { text, secrets } = generate();
        const out = redactString(text);
        for (const secret of secrets) {
          if (out.includes(secret)) {
            expect.fail(
              `leaked ${secret}\n  input:  ${JSON.stringify(text)}\n  output: ${JSON.stringify(out)}`,
            );
          }
        }
      }
    },
    TIMEOUT,
  );

  it(
    '[DEP-050] the output removes every secret that the single scrub of the raw text removes',
    () => {
      const generate = generator(SEED + 1);
      for (let i = 0; i < RUNS; i += 1) {
        const { text, secrets } = generate();
        const single = scrubPlain(text);
        const out = redactString(text);
        for (const secret of secrets) {
          if (!single.includes(secret) && out.includes(secret)) {
            expect.fail(`chained scrub lost a redaction of ${secret}: ${JSON.stringify(text)}`);
          }
        }
        // Superset, also for text the generator did not mark: every [REDACTED] of the single scrub
        // is still there, so the chain never has fewer redactions.
        const count = (value: string): number => value.split('[REDACTED').length - 1;
        expect(count(out)).toBeGreaterThanOrEqual(count(single));
      }
    },
    TIMEOUT,
  );

  it(
    '[DEP-050] createLogger never writes a generated secret as message, field or error',
    () => {
      const generate = generator(SEED + 2);
      for (let i = 0; i < RUNS / 5; i += 1) {
        const { text, secrets } = generate();
        const lines: string[] = [];
        const log = createLogger({ destination: { write: (line: string) => lines.push(line) } });
        log.info(text);
        log.info({ body: text }, 'field');
        log.error(new Error(text));
        const written = lines.join('');
        for (const secret of secrets) {
          if (written.includes(secret))
            expect.fail(`logger wrote ${secret} for ${JSON.stringify(text)}`);
        }
      }
    },
    TIMEOUT,
  );
});
