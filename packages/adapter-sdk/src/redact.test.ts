import { describe, expect, it } from 'vitest';
import {
  isSensitiveKey,
  REDACTED,
  stripBody,
  stripForm,
  stripHeaders,
  stripText,
  stripUrl,
} from './redact.ts';

// Built from parts so no PEM header literal sits in the repository.
const DASHES = '-----';
const BEGIN = `${DASHES}BEGIN PRIVATE KEY${DASHES}`;
const BEGIN_RSA = `${DASHES}BEGIN RSA PRIVATE KEY${DASHES}`;
const END_RSA = `${DASHES}END RSA PRIVATE KEY${DASHES}`;
const SHAPES = [/\bprov_[A-Za-z0-9]{20,}\b/g, /\bpat_[A-Za-z0-9_]{20,}\b/];

describe('raw capture secret stripping', () => {
  it('[ADP-061] replaces authorization, cookie and token headers and keeps the rest', () => {
    const out = stripHeaders(
      new Headers({
        Authorization: 'Bearer abc123456789',
        'Set-Cookie': 'sid=1',
        'X-Api-Key': 'k',
        'Content-Type': 'application/json',
        'X-RateLimit-Remaining': '10',
      }),
    );
    expect(out.authorization).toBe(REDACTED);
    expect(out['set-cookie']).toBe(REDACTED);
    expect(out['x-api-key']).toBe(REDACTED);
    expect(out['content-type']).toBe('application/json');
    expect(out['x-ratelimit-remaining']).toBe('10');
  });

  it('[ADP-061] strips URL userinfo, fragment and secret query values', () => {
    const out = stripUrl(
      'https://user:pw@api.example.test/v1/x?access_token=s3cretvalue&page=2&sig=zzz#frag',
    );
    expect(out).not.toContain('user');
    expect(out).not.toContain('pw@');
    expect(out).not.toContain('s3cretvalue');
    expect(out).not.toContain('zzz');
    expect(out).not.toContain('frag');
    expect(out).toContain('page=2');
    expect(out).toContain(`access_token=${REDACTED}`);
  });

  it('[ADP-061] scrubs an unparseable URL as text, with adapter shapes', () => {
    expect(stripUrl('not a url prov_abcdefghijklmnopqrstuvwxyz', { shapes: SHAPES })).toBe(
      `not a url ${REDACTED}`,
    );
  });

  it('[ADP-061] scrubs declared secrets, adapter shapes and generic shapes inside strings', () => {
    const text =
      'a prov_abcdefghijklmnopqrstuvwxyz0123 b pat_abcdefghijklmnopqrstuvwx c Bearer abcd1234efgh d mysecretvalue https://u:p@h.test/ e eyJhbGciOiJI.eyJzdWIiOiIx.sig-part';
    const out = stripText(text, { secrets: ['mysecretvalue'], shapes: SHAPES });
    expect(out).not.toMatch(/prov_|pat_|abcd1234efgh|mysecretvalue|u:p@|eyJ/);
  });

  it('[ADP-061] provider-specific shapes are scrubbed only when the adapter supplies them', () => {
    const text = 'x prov_abcdefghijklmnopqrstuvwxyz0123';
    expect(stripText(text)).toBe(text);
    expect(stripText(text, { shapes: SHAPES })).toBe(`x ${REDACTED}`);
  });

  it('[ADP-061] scrubs private key blocks, even unterminated ones', () => {
    const out = stripText(`x ${BEGIN_RSA}\nMIIabc\n${END_RSA} y`);
    expect(out).toBe(`x ${REDACTED} y`);
    expect(stripText(`${BEGIN}\nMIIabc`)).toBe(REDACTED);
  });

  it('[ADP-061] scrubs overlapping secrets longest first, and their encoded forms', () => {
    const out = stripText('a abcd1234 b abcd c YWJjZDEyMzQ= d', {
      secrets: ['abcd', 'abcd1234'],
    });
    expect(out).not.toContain('1234');
    expect(out).not.toContain('abcd');
    const encoded = stripText('q=p%40ss%2Fword&b64=cEBzcy93b3Jk', { secrets: ['p@ss/word'] });
    expect(encoded).toBe(`q=${REDACTED}&b64=${REDACTED}`);
  });

  it('[ADP-061] redacts the whole value of sensitive keys: camelCase, nested, arrays, any type', () => {
    const out = stripBody({
      name: 'repo',
      accessToken: 'a',
      refresh_token: 'b',
      idToken: 'c',
      clientSecret: 'd',
      apiKey: 'e',
      privateKey: 'f',
      passphrase: 'g',
      token: { value: 'h', expires: 1 },
      tokens: ['i', 'j'],
      credentials: { user: 'u', pass: 'p' },
      nested: [{ Authorization: 'Bearer zzzzzzzzzz', password: 12345, cookie: true, count: 1 }],
      note: 'ok',
    });
    expect(out).toEqual({
      name: 'repo',
      accessToken: REDACTED,
      refresh_token: REDACTED,
      idToken: REDACTED,
      clientSecret: REDACTED,
      apiKey: REDACTED,
      privateKey: REDACTED,
      passphrase: REDACTED,
      token: REDACTED,
      tokens: REDACTED,
      credentials: REDACTED,
      nested: [{ Authorization: REDACTED, password: REDACTED, cookie: REDACTED, count: 1 }],
      note: 'ok',
    });
  });

  it('[ADP-061] recognises sensitive keys by word, ignoring case and separators', () => {
    for (const key of ['accessToken', 'ACCESS_TOKEN', 'x-api-key', 'privateKey', 'Passwd']) {
      expect(isSensitiveKey(key)).toBe(true);
    }
    for (const key of ['name', 'description', 'url', 'count']) {
      expect(isSensitiveKey(key)).toBe(false);
    }
  });

  it('[ADP-061] scrubs string values and passes null and numbers through, capping depth', () => {
    expect(stripBody(null)).toBeNull();
    expect(stripBody(7)).toBe(7);
    expect(
      stripBody({ note: 'x prov_abcdefghijklmnopqrstuvwxyz0123' }, { shapes: SHAPES }),
    ).toEqual({ note: `x ${REDACTED}` });
    let deep: unknown = 'leaf';
    for (let i = 0; i < 40; i++) deep = { a: deep };
    expect(JSON.stringify(stripBody(deep))).toContain(REDACTED);
  });

  it('[ADP-061] redacts sensitive fields of form-encoded bodies and scrubs the other values', () => {
    const out = stripForm(
      'password=hunter2&access_token=abc&grant_type=x&note=hello%20mysecretvalue',
      {
        secrets: ['mysecretvalue'],
      },
    );
    const params = new URLSearchParams(out);
    expect(params.get('password')).toBe(REDACTED);
    expect(params.get('access_token')).toBe(REDACTED);
    expect(params.get('grant_type')).toBe('x');
    expect(params.get('note')).toBe(`hello ${REDACTED}`);
    expect(out).not.toContain('hunter2');
  });
});
