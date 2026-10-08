import { describe, expect, it } from 'vitest';
import {
  backgroundLimit,
  bucketKey,
  DEFAULT_TUNING,
  effectiveLimit,
  estimateBackgroundEtaSeconds,
  parseBucketKey,
  poolCeiling,
} from './bucket.ts';

describe('bucket keys', () => {
  it('[JOB-040] builds <endpointId>:<accountKey>:<resourceGroup> so one account shares one bucket', () => {
    const a = bucketKey('ep1', 'acct-1', 'repository-data');
    const b = bucketKey('ep1', 'acct-1', 'repository-data');
    expect(a).toBe('ep1:acct-1:repository-data');
    expect(b).toBe(a);
    expect(bucketKey('ep1', 'acct-2', 'repository-data')).not.toBe(a);
  });

  it('[JOB-040] round-trips through parseBucketKey and rejects separators in a part', () => {
    expect(parseBucketKey('ep1:acct:git')).toEqual({
      endpointId: 'ep1',
      accountKey: 'acct',
      resourceGroup: 'git',
    });
    expect(parseBucketKey('a:b')).toBeUndefined();
    expect(() => bucketKey('e:p', 'a', 'g')).toThrow(/Invalid bucket key part/);
    expect(() => bucketKey('ep', 'a#b', 'g')).toThrow(/Invalid bucket key part/);
    expect(() => bucketKey('ep', '', 'g')).toThrow(/Invalid bucket key part/);
  });
});

describe('pool arithmetic', () => {
  it('[JOB-041] effectiveLimit = floor(limit x 0.95) and background = floor(effective x 0.9)', () => {
    expect(effectiveLimit(1000, 0.95)).toBe(950);
    expect(backgroundLimit(1000, DEFAULT_TUNING)).toBe(855);
    expect(poolCeiling(1000, 'interactive', DEFAULT_TUNING)).toBe(950);
    expect(poolCeiling(1000, 'background', DEFAULT_TUNING)).toBe(855);
  });

  it('[JOB-041] interactive work always has at least 10% headroom over background', () => {
    for (const limit of [60, 1000, 5000, 60000]) {
      const interactive = poolCeiling(limit, 'interactive', DEFAULT_TUNING);
      const background = poolCeiling(limit, 'background', DEFAULT_TUNING);
      expect(interactive - background).toBeGreaterThanOrEqual(Math.floor(interactive * 0.1));
    }
  });
});

describe('background ETA', () => {
  it('[JOB-047] ETA = backlog x avgCallsPerAnalysis / background rate', () => {
    expect(
      estimateBackgroundEtaSeconds({
        backlog: 10,
        avgCallsPerAnalysis: 30,
        backgroundRatePerSecond: 2,
      }),
    ).toBe(150);
  });

  it('[JOB-047] ETA is null when there is no background capacity', () => {
    expect(
      estimateBackgroundEtaSeconds({
        backlog: 10,
        avgCallsPerAnalysis: 30,
        backgroundRatePerSecond: 0,
      }),
    ).toBeNull();
  });
});
