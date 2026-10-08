/** The workspace package name (ARC-011). */
export const PACKAGE_NAME = '@git-migrator/quota';

export {
  type BucketLimit,
  backgroundLimit,
  bucketKey,
  DEFAULT_TUNING,
  effectiveLimit,
  estimateBackgroundEtaSeconds,
  parseBucketKey,
  poolCeiling,
  type QuotaPool,
  type QuotaTuning,
} from './bucket.ts';
export { type CredentialCandidate, selectCredential } from './credentials.ts';
export { LOCK_TIMEOUT_MS, type PgPool, QuotaLockTimeoutError } from './db.ts';
export { LEASE_TTL_SECONDS, type LeaseOptions, QuotaLeases } from './leases.ts';
export {
  type AcquireResult,
  type BucketGrant,
  type BucketSnapshot,
  type BucketSpec,
  MAX_RETRY_AFTER_SECONDS,
  type QuotaFeedback,
  type QuotaMetricsSink,
  QuotaService,
  type QuotaServiceOptions,
  SECONDARY_BASE_SECONDS,
  SECONDARY_CAP_SECONDS,
} from './ledger.ts';
