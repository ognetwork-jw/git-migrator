import { resolveConfig } from '@git-migrator/config';
import { describe, expect, it } from 'vitest';
import { assertTestSignInAllowed } from './test-sign-in.ts';

const config = (yaml: string, env: Record<string, string> = {}) =>
  resolveConfig({ text: yaml, env });

describe('test sign-in production guard (AUTH-012)', () => {
  it('[AUTH-012] aborts startup when test sign-in is enabled and the environment is production', () => {
    const production = config(
      'environment: production\npublicUrl: https://gm.example.test\nauth:\n  entra: { tenantId: 00000000-0000-4000-8000-000000000001 }\n',
    );
    // The configuration itself is valid for production; the guard is about the flag below.
    expect(() => assertTestSignInAllowed(production, {})).not.toThrow();
    const bad = { ...production, auth: { ...production.auth, testSignIn: { enabled: true } } };
    expect(() => assertTestSignInAllowed(bad, {})).toThrow(/AUTH-012/);
  });

  it('[AUTH-012] aborts when GM_ENVIRONMENT says production even if the config lost its environment key', () => {
    const lost = config('auth:\n  testSignIn: { enabled: true }\n');
    expect(lost.environment).toBe('development');
    expect(() => assertTestSignInAllowed(lost, { GM_ENVIRONMENT: 'production' })).toThrow(
      /AUTH-012/,
    );
  });

  it('[AUTH-012] allows test sign-in in development, test and e2e', () => {
    for (const environment of ['development', 'test', 'e2e']) {
      const c = config(`environment: ${environment}\nauth:\n  testSignIn: { enabled: true }\n`);
      expect(() => assertTestSignInAllowed(c, { GM_ENVIRONMENT: environment })).not.toThrow();
    }
  });

  it('[AUTH-012] does nothing while test sign-in is disabled, even in production', () => {
    const production = config(
      'environment: production\npublicUrl: https://gm.example.test\nauth:\n  entra: { tenantId: 00000000-0000-4000-8000-000000000001 }\n',
    );
    expect(() =>
      assertTestSignInAllowed(production, { GM_ENVIRONMENT: 'production' }),
    ).not.toThrow();
  });
});
