import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertHostAllowed, isTestEnvironment, testAllowedHosts } from './host-allowlist.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('test host allowlist', () => {
  it('[TST-006] is on only for GM_ENVIRONMENT=test', () => {
    expect(isTestEnvironment('test')).toBe(true);
    expect(isTestEnvironment('production')).toBe(false);
    expect(isTestEnvironment(undefined, {})).toBe(false);
    expect(isTestEnvironment('', {})).toBe(false);
  });

  it('[TST-006] allows loopback and refuses real provider hosts', () => {
    expect(() => assertHostAllowed(new URL('http://127.0.0.1:9000/x'), 'p')).not.toThrow();
    expect(() => assertHostAllowed(new URL('http://localhost/x'), 'p')).not.toThrow();
    expect(() => assertHostAllowed(new URL('http://[::1]:80/x'), 'p')).not.toThrow();
    expect(() => assertHostAllowed(new URL('https://api.provider.example/x'), 'p')).toThrow(
      /allowlist/,
    );
  });

  it('[TST-006] adds hosts from GM_TEST_ALLOWED_HOSTS and explicit extras', () => {
    vi.stubEnv('GM_TEST_ALLOWED_HOSTS', ' Fake.Test , other.test:8080 ,');
    expect(testAllowedHosts(['Extra.test']).has('fake.test')).toBe(true);
    expect(() => assertHostAllowed(new URL('https://fake.test/x'), 'p')).not.toThrow();
    expect(() => assertHostAllowed(new URL('http://other.test:8080/x'), 'p')).not.toThrow();
    expect(() =>
      assertHostAllowed(new URL('http://extra.test/x'), 'p', ['extra.test']),
    ).not.toThrow();
    expect(() => assertHostAllowed(new URL('http://other.test:9/x'), 'p')).toThrow();
  });
});
