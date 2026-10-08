/**
 * Test-environment host allowlist (TST-006): when `GM_ENVIRONMENT=test` (or, with it unset,
 * `NODE_ENV=test` or Vitest), the provider HTTP client refuses every host except loopback and the
 * hosts listed in `GM_TEST_ALLOWED_HOSTS` (comma separated), so a test cannot reach a real
 * provider by accident.
 */
import { AdapterError } from './errors.ts';

const LOOPBACK: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isTestEnvironment(
  environment: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  // An explicitly configured environment decides. Only when none is set does a test runner
  // (NODE_ENV=test or Vitest) count as the test environment.
  if (environment !== undefined && environment !== '') return environment === 'test';
  return env.NODE_ENV === 'test' || env.VITEST !== undefined;
}

/** Hosts from `GM_TEST_ALLOWED_HOSTS` plus the explicit extras, lower-cased. */
export function testAllowedHosts(extra: readonly string[] = []): ReadonlySet<string> {
  const fromEnv = (process.env.GM_TEST_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host !== '');
  return new Set([...LOOPBACK, ...fromEnv, ...extra.map((host) => host.toLowerCase())]);
}

/** Throws a non-retryable `invalid` AdapterError when `url` is not allowed in the test environment. */
export function assertHostAllowed(url: URL, provider: string, extra: readonly string[] = []): void {
  const allowed = testAllowedHosts(extra);
  if (allowed.has(url.hostname.toLowerCase()) || allowed.has(url.host.toLowerCase())) return;
  throw new AdapterError({
    code: 'invalid',
    provider,
    message: `Host ${url.hostname} is not on the test allowlist (GM_ENVIRONMENT=test, TST-006)`,
  });
}
