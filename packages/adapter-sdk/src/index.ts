/** @git-migrator/adapter-sdk: adapter and Facet driver contracts, provider HTTP client. */
export const PACKAGE_NAME = '@git-migrator/adapter-sdk';

/** Quota vocabulary adapters need for classifiers and feedback; adapters may not import `quota` (ARC-012). */
export {
  type BucketSpec,
  bucketKey,
  type QuotaFeedback,
  type QuotaPool,
} from '@git-migrator/quota';
export * from './errors.ts';
export * from './host-allowlist.ts';
export * from './http.ts';
export * from './logger.ts';
export * from './pagination.ts';
export * from './redact.ts';
export * from './types.ts';
