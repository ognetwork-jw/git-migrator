import { describe, expect, it } from 'vitest';
import { redactAtPath, redactFacetValue } from './redact.ts';

describe('parity redaction', () => {
  it('[LIF-060] strings under a sensitive key are replaced, booleans and numbers stay', () => {
    const out = redactFacetValue('variables', {
      variables: [{ name: 'API_TOKEN', value: 'hunter2-fake', secured: true }],
      password: 'pw-fake',
      count: 3,
    }) as { variables: { value: string; secured: boolean }[]; password: string; count: number };
    expect(out.variables[0]?.value).toBe('[REDACTED]');
    expect(out.variables[0]?.secured).toBe(true);
    expect(out.password).toBe('[REDACTED]');
    expect(out.count).toBe(3);
  });

  it('[LIF-060] a diff side at a sensitive path or selector is redacted', () => {
    expect(redactAtPath('variables', '/variables/password', 'hunter2-fake')).toBe('[REDACTED]');
    expect(redactAtPath('variables', '/headers[name=Authorization]/value', 'Bearer abc.def')).toBe(
      '[REDACTED]',
    );
    expect(redactAtPath('repository-settings', '/description', 'a plain description')).toBe(
      'a plain description',
    );
  });

  it('[LIF-060] webhook URLs reduce to their origin; credentials in other strings are scrubbed', () => {
    expect(
      redactAtPath('webhooks', '/hooks[key=k]/url', 'https://h.example/path?token=s3cr3t'),
    ).toBe('https://h.example/…');
    const scrubbed = redactAtPath(
      'repository-settings',
      '/homepage',
      'https://u:pw-fake@h.example/x',
    );
    expect(String(scrubbed)).not.toContain('pw-fake');
  });

  it('[FAC-SEC-001] names-only facets keep secret names, and still hide a value field', () => {
    expect(redactAtPath('secrets', '/secrets[name=API_TOKEN]/present', true)).toBe(true);
    expect(redactAtPath('secrets', '/secrets[name=API_TOKEN]', { name: 'API_TOKEN' })).toEqual({
      name: 'API_TOKEN',
    });
    expect(redactAtPath('secrets', '/secrets[name=X]/value', 'plain-fake')).toBe('[REDACTED]');
  });
});
