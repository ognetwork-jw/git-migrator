/** Endpoint options and credential shapes of the Bitbucket Cloud adapter (ADR-0220). */
import { z } from 'zod';

export const PROVIDER = 'bitbucket-cloud';

/** Resource groups of JOB-043. */
export const RESOURCE_GROUPS = [
  'repository-data',
  'webhooks',
  'raw-files',
  'app-properties',
  'git',
] as const;
export type ResourceGroup = (typeof RESOURCE_GROUPS)[number];

/** Default git HTTPS username for API tokens (unverified, ADR-0036 item 1). */
export const DEFAULT_GIT_USERNAME = 'x-bitbucket-api-token-auth';

/**
 * `config` handed to `connect`: the endpoint's `options`, plus `gitBaseUrl` and `quota`
 * (`endpoints[].quota`) which the runner copies in (ADR-0220).
 */
export const configSchema = z.strictObject({
  workspace: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/, 'must be a workspace slug'),
  gitBaseUrl: z.url().prefault('https://bitbucket.org'),
  quota: z
    .strictObject({
      overrides: z.partialRecord(z.enum(RESOURCE_GROUPS), z.number().int().positive()).prefault({}),
    })
    .prefault({}),
});
export type BitbucketConfig = z.output<typeof configSchema>;

/** One entry of `BITBUCKET_CREDENTIALS` (the runner picks one per job, JOB-042). */
export const credentialSchema = z.strictObject({
  id: z.string().min(1).optional(),
  accountId: z.string().min(1),
  email: z.string().min(3),
  apiToken: z.string().min(4),
  /** Git HTTPS username; defaults to `x-bitbucket-api-token-auth`. */
  gitUsername: z.string().min(1).optional(),
});
export type BitbucketCredential = z.output<typeof credentialSchema>;
