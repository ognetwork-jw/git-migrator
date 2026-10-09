import { describe, expect, it } from 'vitest';
import {
  CI_VARIABLES,
  liveRefusals,
  RefusedError,
  resolveConfigFile,
  resolveTarget,
  withAbsoluteConfig,
} from './target.ts';

const exists = () => true;

describe('the e2e target (TST-030, TST-006)', () => {
  it('[TST-030] has no default: an unset or unknown GM_E2E_TARGET is refused', () => {
    expect(() => resolveTarget({}, exists)).toThrow(RefusedError);
    expect(() => resolveTarget({ GM_E2E_TARGET: 'Live' }, exists)).toThrow(/"Live"/);
    expect(() => resolveTarget({ GM_E2E_TARGET: '' }, exists)).toThrow(RefusedError);
  });

  it('[TST-030] accepts the dry mode without any configuration', () => {
    expect(resolveTarget({ GM_E2E_TARGET: 'fakes' }, () => false)).toBe('fakes');
  });

  it('[TST-006] refuses the live mode in CI, whatever the value of the CI variable', () => {
    for (const name of ['CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'TF_BUILD']) {
      for (const value of ['true', '1', 'false', '0']) {
        const env = { GM_E2E_TARGET: 'live', GM_CONFIG_FILE: 'x.yaml', [name]: value };
        expect(() => resolveTarget(env, exists), `${name}=${value}`).toThrow(/never runs in CI/);
      }
    }
  });

  it('[TST-006] refuses the live mode under GM_ENVIRONMENT=test or production', () => {
    for (const environment of ['test', 'production', 'development']) {
      const env = { GM_E2E_TARGET: 'live', GM_CONFIG_FILE: 'x.yaml', GM_ENVIRONMENT: environment };
      expect(() => resolveTarget(env, exists)).toThrow(/GM_ENVIRONMENT/);
    }
    const env = { GM_E2E_TARGET: 'live', GM_CONFIG_FILE: 'x.yaml', GM_ENVIRONMENT: 'e2e' };
    expect(resolveTarget(env, exists)).toBe('live');
  });

  it('[TST-031] names the missing configuration file in an actionable message', () => {
    expect(liveRefusals({ GM_E2E_TARGET: 'live' }, exists)[0]).toMatch(/GM_CONFIG_FILE is not set/);
    expect(liveRefusals({ GM_CONFIG_FILE: 'nope.yaml' }, () => false)[0]).toMatch(
      /nope\.yaml.*does not exist.*config\.e2e\.example\.yaml/,
    );
  });

  it('[TST-031] reports every reason at once', () => {
    const reasons = liveRefusals({ CI: 'true', GM_ENVIRONMENT: 'test' }, exists);
    expect(reasons).toHaveLength(3);
  });

  it.each(CI_VARIABLES)('[TST-006] refuses the live mode when %s is set', (name) => {
    const env = { GM_E2E_TARGET: 'live', GM_CONFIG_FILE: 'x.yaml', [name]: '1' };
    expect(() => resolveTarget(env, exists)).toThrow(/never runs in CI/);
  });

  it('[TST-030] makes a relative GM_CONFIG_FILE absolute, from the working directory or the repository root', () => {
    const seen = new Set(['/work/testing/e2e/live/config.e2e.yaml']);
    const has = (path: string) =>
      seen.has(path) || path.endsWith('/testing/e2e/live/config.e2e.yaml');
    expect(resolveConfigFile('live/config.e2e.yaml', has, '/work/testing/e2e')).toBe(
      '/work/testing/e2e/live/config.e2e.yaml',
    );
    // The repository-root form of TST-030 resolves from the checkout, whatever the working directory.
    const fromRoot = resolveConfigFile('testing/e2e/live/config.e2e.yaml', has, '/elsewhere');
    expect(fromRoot?.startsWith('/')).toBe(true);
    expect(fromRoot?.endsWith('/testing/e2e/live/config.e2e.yaml')).toBe(true);
    expect(resolveConfigFile('/abs/c.yaml', (p) => p === '/abs/c.yaml')).toBe('/abs/c.yaml');
    expect(resolveConfigFile('nope.yaml', () => false)).toBeUndefined();
    const env = withAbsoluteConfig(
      { GM_CONFIG_FILE: 'live/config.e2e.yaml', OTHER: 'x' },
      has,
      '/work/testing/e2e',
    );
    expect(env).toEqual({
      GM_CONFIG_FILE: '/work/testing/e2e/live/config.e2e.yaml',
      OTHER: 'x',
    });
    expect(withAbsoluteConfig({ GM_CONFIG_FILE: 'nope.yaml' }, () => false).GM_CONFIG_FILE).toBe(
      'nope.yaml',
    );
  });
});
