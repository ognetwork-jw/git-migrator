import { resolveConfig } from '@git-migrator/config';
import { describe, expect, it } from 'vitest';

describe('cookie security rests on the configuration rule (AUTH-003)', () => {
  it('[AUTH-003] production with an http public URL fails config validation, so Secure cookies are always on there', () => {
    const text =
      'environment: production\npublicUrl: http://gm.example.test\nauth:\n  entra: { tenantId: 00000000-0000-4000-8000-000000000001 }\n';
    expect(() => resolveConfig({ text, env: {} })).toThrow(/https/);
  });
});
