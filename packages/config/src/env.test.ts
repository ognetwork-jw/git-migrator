import { describe, expect, it } from 'vitest';
import { applyEnvOverrides, envOverrideKeys, envVarFor } from './env.ts';

const envVars = () => envOverrideKeys().map((key) => key.envVar);

describe('GM_* environment overrides (ARC-030)', () => {
  it('[ARC-030] maps a key path to GM_ plus SCREAMING_SNAKE_CASE segments', () => {
    expect(envVarFor(['environment'])).toBe('GM_ENVIRONMENT');
    expect(envVarFor(['publicUrl'])).toBe('GM_PUBLIC_URL');
    expect(envVarFor(['quota', 'safetyFactor'])).toBe('GM_QUOTA_SAFETY_FACTOR');
    expect(envVarFor(['sizeClass', 'largeThresholdBytes'])).toBe(
      'GM_SIZE_CLASS_LARGE_THRESHOLD_BYTES',
    );
    expect(envVarFor(['worker', 'standard', 'concurrency', 'runs'])).toBe(
      'GM_WORKER_STANDARD_CONCURRENCY_RUNS',
    );
    expect(envVarFor(['secretspec', 'profile'])).toBe('GM_SECRETSPEC_PROFILE');
  });

  it('[ARC-030] lists every scalar key of the schema, with the spec names', () => {
    const names = envVars();
    for (const expected of [
      'GM_ENVIRONMENT',
      'GM_PUBLIC_URL',
      'GM_AUTH_ENTRA_TENANT_ID',
      'GM_AUTH_TEST_SIGN_IN_ENABLED',
      'GM_GIT_MAX_PUSH_BYTES',
      'GM_GIT_MAX_CONCURRENT_LFS_TRANSFERS',
      'GM_SIZE_CLASS_LARGE_THRESHOLD_BYTES',
      'GM_QUOTA_SAFETY_FACTOR',
      'GM_QUOTA_BACKGROUND_SHARE',
      'GM_GITHUB_MAX_CONCURRENT_REQUESTS',
      'GM_SCHEDULES_INVENTORY',
      'GM_SCHEDULES_ANALYSIS_STALE_AFTER',
      'GM_SCHEDULES_DRIFT_READS_SOURCE',
      'GM_POSTGRES_HOST',
      'GM_POSTGRES_SSLMODE',
      'GM_POSTGRES_POOL_APP',
      'GM_WORKER_LARGE_CONCURRENCY_RUNS',
      'GM_OBSERVABILITY_LOG_LEVEL',
      'GM_OBSERVABILITY_OTLP_ENDPOINT',
      'GM_METRICS_PORT',
      'GM_SECRETSPEC_PROFILE',
    ]) {
      expect(names, expected).toContain(expected);
    }
  });

  it('[ARC-030] lists no list or map key, because one variable cannot address it', () => {
    const names = envVars();
    for (const excluded of [
      'GM_ENDPOINTS',
      'GM_ROUTES',
      'GM_AUTH_ROLE_MAPPINGS',
      'GM_ENDPOINTS_0_QUOTA_OVERRIDES',
      'GM_QUOTA_OVERRIDES',
    ]) {
      expect(names).not.toContain(excluded);
    }
    expect(envOverrideKeys().some((key) => key.path.includes('acceptLossy'))).toBe(false);
  });

  it('[ARC-030] every override variable name is unique', () => {
    const names = envVars();
    expect(new Set(names).size).toBe(names.length);
  });

  it('[ARC-030] sets a value over the document, coerced to the type the key expects', () => {
    const { value, applied } = applyEnvOverrides(
      { quota: { safetyFactor: 0.5 } },
      {
        GM_QUOTA_SAFETY_FACTOR: '0.8',
        GM_AUTH_TEST_SIGN_IN_ENABLED: 'true',
        GM_PUBLIC_URL: 'https://override.example',
        GM_WORKER_LARGE_CONCURRENCY_RUNS: '3',
        GM_SCHEDULES_ANALYSIS_STALE_AFTER: '2d',
      },
    );
    expect(value).toMatchObject({
      quota: { safetyFactor: 0.8 },
      auth: { testSignIn: { enabled: true } },
      publicUrl: 'https://override.example',
      worker: { large: { concurrency: { runs: 3 } } },
      schedules: { analysisStaleAfter: '2d' },
    });
    expect(applied.get('quota.safetyFactor')).toBe('GM_QUOTA_SAFETY_FACTOR');
    expect(applied.get('auth.testSignIn.enabled')).toBe('GM_AUTH_TEST_SIGN_IN_ENABLED');
  });

  it('[ARC-030] keeps text that is not a number or boolean, so the schema reports it', () => {
    const { value } = applyEnvOverrides(
      {},
      { GM_GIT_MAX_PUSH_BYTES: 'lots', GM_QUOTA_SAFETY_FACTOR: 'maybe' },
    );
    expect(value).toEqual({ git: { maxPushBytes: 'lots' }, quota: { safetyFactor: 'maybe' } });
  });

  it('[ARC-030] a numeric value of the wrong size is kept numeric, so the schema states the rule', () => {
    const { value } = applyEnvOverrides(
      {},
      { GM_GIT_MAX_PUSH_BYTES: '-5', GM_QUOTA_SAFETY_FACTOR: 'true' },
    );
    expect(value).toEqual({ git: { maxPushBytes: -5 }, quota: { safetyFactor: true } });
  });

  it('[ARC-030] treats an unset or empty variable as no override', () => {
    const document = { publicUrl: 'https://file.example' };
    const { value, applied } = applyEnvOverrides(document, {
      GM_PUBLIC_URL: '',
      GM_METRICS_PORT: undefined,
    });
    expect(value).toEqual(document);
    expect(applied.size).toBe(0);
  });

  it('[ARC-030] ignores GM_ variables that are not configuration keys', () => {
    const { value, applied } = applyEnvOverrides(
      {},
      {
        GM_CONFIG_FILE: '/etc/git-migrator/config.yaml',
        GM_WORKER_ROLE: 'standard',
        GM_SCRATCH_DIR: '/scratch',
        GM_ENDPOINTS: '[]',
      },
    );
    expect(value).toEqual({});
    expect(applied.size).toBe(0);
  });

  it('[ARC-030] does not modify the document it is given', () => {
    const document = { quota: { safetyFactor: 0.5 } };
    applyEnvOverrides(document, { GM_QUOTA_SAFETY_FACTOR: '0.9' });
    expect(document).toEqual({ quota: { safetyFactor: 0.5 } });
  });

  it('[ARC-030] leaves a section alone when the file gave it a non-mapping value', () => {
    const { value, applied } = applyEnvOverrides(
      { quota: 'fast' },
      { GM_QUOTA_SAFETY_FACTOR: '0.9' },
    );
    expect(value).toEqual({ quota: 'fast' });
    expect(applied.size).toBe(0);
  });
});
