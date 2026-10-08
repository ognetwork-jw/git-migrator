/** The two pools of JOB-041. */
export type QuotaPool = 'background' | 'interactive';

/** Whole-window numbers of one bucket: its limit and the window it applies to (JOB-041). */
export interface BucketLimit {
  readonly limit: number;
  readonly windowSeconds: number;
}

/** The tunables of JOB-041 (`quota.safetyFactor`, `quota.backgroundShare`). */
export interface QuotaTuning {
  /** Default 0.95. */
  readonly safetyFactor: number;
  /** Default 0.9. */
  readonly backgroundShare: number;
}

export const DEFAULT_TUNING: QuotaTuning = { safetyFactor: 0.95, backgroundShare: 0.9 };

const PART = /^[^:#\s]+$/;

/**
 * Builds a bucket key, `<endpointId>:<accountKey>:<resourceGroup>` (JOB-040). `accountKey`
 * identifies whose limit is consumed: credentials of one account pass the same value and so share
 * one bucket. Parts may not contain `:`, `#` or whitespace, so a key can be split unambiguously and
 * `#` stays free for internal bookkeeping rows.
 */
export function bucketKey(endpointId: string, accountKey: string, resourceGroup: string): string {
  for (const [name, value] of [
    ['endpointId', endpointId],
    ['accountKey', accountKey],
    ['resourceGroup', resourceGroup],
  ] as const) {
    if (!PART.test(value)) {
      throw new Error(
        `Invalid bucket key part ${name}: it must be non-empty with no ':', '#' or whitespace.`,
      );
    }
  }
  return `${endpointId}:${accountKey}:${resourceGroup}`;
}

/** Splits a key built by `bucketKey`; returns undefined when it does not have three parts. */
export function parseBucketKey(
  key: string,
): { endpointId: string; accountKey: string; resourceGroup: string } | undefined {
  const parts = key.split(':');
  if (parts.length !== 3 || !parts.every((part) => PART.test(part))) return undefined;
  const [endpointId, accountKey, resourceGroup] = parts as [string, string, string];
  return { endpointId, accountKey, resourceGroup };
}

/** `floor(limit x safetyFactor)` (JOB-041). */
export function effectiveLimit(limit: number, safetyFactor: number): number {
  return Math.floor(limit * safetyFactor);
}

/** `floor(effectiveLimit x backgroundShare)`: the most that background work may use (JOB-041). */
export function backgroundLimit(limit: number, tuning: QuotaTuning): number {
  return Math.floor(effectiveLimit(limit, tuning.safetyFactor) * tuning.backgroundShare);
}

/** The ceiling that applies to `pool`. */
export function poolCeiling(limit: number, pool: QuotaPool, tuning: QuotaTuning): number {
  return pool === 'background'
    ? backgroundLimit(limit, tuning)
    : effectiveLimit(limit, tuning.safetyFactor);
}

/**
 * Background ETA (JOB-047): `backlog x avgCallsPerAnalysis / background rate`, in seconds.
 * Returns null when there is no background capacity.
 */
export function estimateBackgroundEtaSeconds(input: {
  readonly backlog: number;
  readonly avgCallsPerAnalysis: number;
  readonly backgroundRatePerSecond: number;
}): number | null {
  if (input.backgroundRatePerSecond <= 0) return null;
  return (input.backlog * input.avgCallsPerAnalysis) / input.backgroundRatePerSecond;
}
