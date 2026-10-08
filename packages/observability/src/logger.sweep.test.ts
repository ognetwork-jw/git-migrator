import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.ts';

/*
 * Adversarial sweep (DEP-050, ADR-0052): every leak shape reported in the T-004 reviews (rounds 1
 * to 4), written through createLogger as the message, as a field value and as an error message.
 * Each entry lists the fragments that must not appear in the written line. Secret-shaped values are
 * assembled from fragments so that no secret-shaped literal is committed (gitleaks).
 */
const j = (...parts: string[]): string => parts.join('');
const BODY = j('Q2x7Rk9Lm3', 'Np8Qr1St6U', 'v4Wx0Yz5Ab2Cd9Ef');

const SWEEP: [string, string[]][] = [
  // Round 1: header values, token shapes, escaped JSON, unquoted values with spaces.
  [j('Authorization: tok', 'en abcdefSECRET'), ['abcdefSECRET']],
  [j('Authorization: Dig', 'est username=bob response=SECRETx'), ['SECRETx']],
  ['Cookie: a=SECRETA; b=SECRETB', ['SECRETA', 'SECRETB']],
  ['{\\"token\\":\\"LEAKR1A\\"}', ['LEAKR1A']],
  ['{\\"password\\":\\"a\\"LEAKR1B\\"}', ['LEAKR1B']],
  [j('pass', 'word=hunter 2 TAIL'), ['hunter', 'TAIL']],
  [j('gh', 'p_', BODY), [BODY]],
  [j('github', '_pat_', BODY), [BODY]],
  // Round 2: spaced words, quoted newlines, percent-encoded separators, folded headers.
  ['login with password LEAKR2A now', ['LEAKR2A']],
  ['bad password LEAKR2B', ['LEAKR2B']],
  ['password="abc\nLEAKR2C" tail', ['abc', 'LEAKR2C']],
  ['token%3DLEAKR2D', ['LEAKR2D']],
  ['?a=1&password%3DLEAKR2E&b=2', ['LEAKR2E']],
  ['client_secret%3DLEAKR2F%26grant_type%3Dx', ['LEAKR2F']],
  ['Authorization%3A%20Bearer%20LEAKR2G', ['LEAKR2G']],
  ['redirect=https%3A%2F%2Fh%2F%3Faccess_token%3DLEAKR2H', ['LEAKR2H']],
  ['Authorization: Digest a,\r\n  response="LEAKR2I"', ['LEAKR2I']],
  ['Cookie: a=1;\r\n b=LEAKR2J', ['LEAKR2J']],
  ['run --password LEAKR2K --dry', ['LEAKR2K']],
  ['run --token=LEAKR2L', ['LEAKR2L']],
  // Round 3: encoded delimiters inside a value, fullwidth colon, plus as space, is/was, curl -u.
  ['username=bob&password=p%26ss%26LEAKR3A&next=/', ['LEAKR3A', 'p%26ss']],
  ['password=ab%3BLEAKR3B&x=1', ['LEAKR3B']],
  ['{"password":"ab%22LEAKR3C"}', ['LEAKR3C']],
  ['password=a%2526LEAKR3D&x=1', ['LEAKR3D']],
  ['password=ab%0ALEAKR3E', ['LEAKR3E']],
  ['Cookie: a=1%0D%0ALEAKR3F', ['LEAKR3F']],
  ['password：LEAKR3G', ['LEAKR3G']],
  ['password： LEAKR3H', ['LEAKR3H']],
  ['password%EF%BC%9ALEAKR3I', ['LEAKR3I']],
  ['password+is+LEAKR3J', ['LEAKR3J']],
  ['Bearer+LEAKR3K', ['LEAKR3K']],
  ['the password is: LEAKR3L', ['LEAKR3L']],
  ['password was = LEAKR3M', ['LEAKR3M']],
  ['curl -u bob:LEAKR3N https://h/x', ['LEAKR3N']],
  ['curl --user bob:LEAKR3O -s', ['LEAKR3O']],
  ['the pin is 4931', ['4931']],
  ['api_key LEAKR3P', ['LEAKR3P']],
  [`cred ${Buffer.from('user:se>cret???>valu~e').toString('base64url')}`, ['c2U-Y3JldD8_P']],
  // Round 4: a redaction made only before decoding, encoded JSON, nested escaped quotes, spaces.
  ['git clone https://bob:ab%2FcdLEAKR4A@host.example/a/b.git', ['LEAKR4A', 'ab%2Fcd']],
  ['ssh://git:tok%2BLEAKR4B%2Fx@h/x', ['LEAKR4B']],
  ['https://bob:ab%3FLEAKR4C@h/x', ['LEAKR4C']],
  ['https://bob:a%2FLEAKR4D%2F@h/x', ['LEAKR4D']],
  ['curl -u bob:pa%20ssLEAKR4E', ['LEAKR4E']],
  ['password hunter2%20LEAKR4F', ['LEAKR4F']],
  ['payload=%7B%22password%22%3A%22LEAKR4G%22%7D', ['LEAKR4G']],
  ['payload=%7B%22token%22%3A%22LEAKR4H%22%7D', ['LEAKR4H']],
  ['x=%7B%22client_secret%22%3A%22LEAKR4I%22%7D', ['LEAKR4I']],
  ['body=%7B%22access_token%22%3A+%22LEAKR4J%22%7D', ['LEAKR4J']],
  ['d=%7B%27password%27%3A%27LEAKR4K%27%7D', ['LEAKR4K']],
  ['d=%7B%22user%22%3A%22bob%22%2C%22pwd%22%3A%22LEAKR4L%22%7D', ['LEAKR4L']],
  ['{\\"password\\":\\"a\\\\\\"LEAKR4M\\"}', ['LEAKR4M']],
  ['"{\\"password\\":\\"a\\\\\\"LEAKR4N\\"}"', ['LEAKR4N']],
  ['{\\"password\\":\\"a\\\\\\\\\\\\\\"LEAKR4O\\"}', ['LEAKR4O']],
  ['password LEAKR4P', ['LEAKR4P']],
  ['password LEAKR4Q', ['LEAKR4Q']],
  ['password = LEAKR4R', ['LEAKR4R']],
  // Beyond the reports: the same classes in neighbouring forms.
  [j('%22gh', 'p_', BODY, '%22'), [BODY.slice(0, 16)]],
  ['{%22url%22:%22https://bob:ab/cdLEAKX1@h%22}', ['LEAKX1']],
  ['url=https%3A%2F%2Fbob%3Aab%252FcdLEAKX2%40h%2Fx', ['LEAKX2']],
  ['url=https%3A%2F%2Fbob%3Am1%2520LEAKX3%40h%2Fx', ['LEAKX3']],
  ['%22Bearer%20LEAKX4%22', ['LEAKX4']],
  ['%22password%20LEAKX5%22', ['LEAKX5']],
  ['password %22hunter LEAKX6%22', ['LEAKX6']],
  ['%5C%22password%5C%22%3A%5C%22LEAKX7%5C%22', ['LEAKX7']],
  ['{\\\\\\"password\\\\\\":\\\\\\"a b LEAKX8\\\\\\"}', ['LEAKX8']],
  ['password: \\"a b LEAKX9\\"', ['LEAKX9']],
  ['{"password":"a\\"b LEAKY1"}', ['LEAKY1']],
  ['{"password":"a"LEAKY2"}', ['LEAKY2']],
  ['x%253Dtoken%25253DLEAKY3', ['LEAKY3']], // triple encoding, the deepest level handled
];

describe('logger redaction sweep over every reported leak shape (DEP-050)', () => {
  const forms = {
    message: (log: ReturnType<typeof createLogger>, text: string) => log.info(text),
    field: (log: ReturnType<typeof createLogger>, text: string) => log.info({ body: text }, 'm'),
    error: (log: ReturnType<typeof createLogger>, text: string) => log.error(new Error(text)),
  };
  for (const [input, secrets] of SWEEP) {
    for (const [form, write] of Object.entries(forms)) {
      it(`[DEP-050] never writes ${JSON.stringify(input)} as ${form}`, () => {
        const lines: string[] = [];
        write(createLogger({ destination: { write: (line: string) => lines.push(line) } }), input);
        const written = lines.join('');
        // The JSON line escapes quotes and backslashes; check the parsed values too.
        const parsed = JSON.stringify(JSON.parse(written), null, 0);
        for (const secret of secrets) {
          expect(written).not.toContain(secret);
          expect(JSON.parse(written).msg ?? '').not.toContain(secret);
          expect(parsed).not.toContain(secret);
        }
        expect(written).toContain('REDACTED');
      });
    }
  }
});
