import { describe, expect, it } from 'vitest';
import { redactAtPath, redactFacetValue } from './redact.ts';

describe('[AUTH-022] diff redaction (ADR-0331)', () => {
  it('[AUTH-022] replaces strings under sensitive keys, at any depth, and keeps booleans and numbers', () => {
    const out = redactFacetValue('variables', {
      password: 'p-fake',
      nested: { apiKey: 'k-fake', count: 3, flag: true },
      deep: { credentials: { user: 'u-fake' } },
      plain: 'visible',
    });
    expect(out).toEqual({
      password: '[REDACTED]',
      nested: { apiKey: '[REDACTED]', count: 3, flag: true },
      deep: { credentials: { user: '[REDACTED]' } },
      plain: 'visible',
    });
  });

  it('[AUTH-022] webhook URLs reduce to their origin and hasSecret stays a boolean', () => {
    const out = redactFacetValue('webhooks', {
      hooks: [{ url: 'https://hooks.example/a/b?c=d', hasSecret: true }],
    });
    expect(out).toEqual({ hooks: [{ url: 'https://hooks.example/…', hasSecret: true }] });
  });

  it('[AUTH-022] secret names are kept (the secrets Facet holds names only) and URL userinfo is scrubbed elsewhere', () => {
    expect(redactFacetValue('secrets', { secrets: [{ name: 'DEPLOY' }] })).toEqual({
      secrets: [{ name: 'DEPLOY' }],
    });
    const text = JSON.stringify(
      redactFacetValue('repository-settings', { remote: 'https://u:pw-fake@h.example/x.git' }),
    );
    expect(text).not.toContain('pw-fake');
  });

  it('[AUTH-022] does not change its input and cuts runaway depth', () => {
    const input = { password: 'p-fake' };
    redactFacetValue('variables', input);
    expect(input.password).toBe('p-fake');
    let deep: unknown = 'leaf';
    for (let i = 0; i < 50; i++) deep = { next: deep };
    expect(JSON.stringify(redactFacetValue('variables', deep))).toContain('[too deep]');
  });

  it('[AUTH-022] a diff side is judged by the last segment of its path', () => {
    expect(redactAtPath('variables', '/variables/password', 'p-fake')).toBe('[REDACTED]');
    expect(redactAtPath('variables', '/variables[key=a]/value', 'v')).toBe('v');
    expect(redactAtPath('webhooks', '/hooks[key=k]/url', 'https://h.example/secret-path')).toBe(
      'https://h.example/…',
    );
    expect(redactAtPath('variables', '/x/password', true)).toBe(true);
  });

  it('[AUTH-022] a value under a sensitive ancestor path is redacted, however deep, with bracket indices stripped', () => {
    expect(redactAtPath('variables', '/credentials/foo/bar', 'clear-fake')).toBe('[REDACTED]');
    expect(redactAtPath('variables', '/authorization[0]/value', 'clear-fake')).toBe('[REDACTED]');
    expect(redactAtPath('variables', '/a/b/c/d/credentials[2]/x/y', 'clear-fake')).toBe(
      '[REDACTED]',
    );
    expect(redactAtPath('variables', '/items[0]/label', 'plain')).toBe('plain');
  });

  it('[AUTH-022] a bracket selector that names a sensitive key redacts the value', () => {
    expect(redactAtPath('variables', '/headers[name=Authorization]/value', 'clear-fake')).toBe(
      '[REDACTED]',
    );
    expect(redactAtPath('variables', '/headers[name=Accept]/value', 'text/html')).toBe('text/html');
  });

  it('[AUTH-022] the value of a {name, value} pair follows a sensitive name', () => {
    expect(
      redactFacetValue('variables', {
        headers: [
          { name: 'Authorization', value: 'clear-fake' },
          { name: 'Accept', value: 'text/html' },
        ],
      }),
    ).toEqual({
      headers: [
        { name: 'Authorization', value: '[REDACTED]' },
        { name: 'Accept', value: 'text/html' },
      ],
    });
  });

  it('[FAC-SEC-001] secrets Facets keep names but redact any value-like key', () => {
    expect(
      redactFacetValue('secrets', {
        secrets: [{ key: 'repo/A', name: 'A', value: 'clear-fake', encrypted_value: 'enc-fake' }],
      }),
    ).toEqual({
      secrets: [{ key: 'repo/A', name: 'A', value: '[REDACTED]', encrypted_value: '[REDACTED]' }],
    });
  });
});
