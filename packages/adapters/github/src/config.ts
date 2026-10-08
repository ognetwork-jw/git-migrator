/** Endpoint options and credential shapes of the GitHub adapter (ADR-0230). */
import { AdapterError } from '@git-migrator/adapter-sdk';
import { z } from 'zod';

export const PROVIDER = 'github';

const positive = z.number().int().positive();

export const configSchema = z.strictObject({
  org: z.string().min(1),
  /** 0 is the DEP-040 placeholder and counts as unset (ADR-0051). */
  appId: z.number().int().min(0),
  installationId: z.number().int().min(0),
  /** Web host used for git and the LFS batch API. */
  gitBaseUrl: z.string().url().default('https://github.com'),
  /** `github.maxConcurrentRequests` (JOB-045). */
  maxConcurrentRequests: positive.default(10),
  /** `endpoints[].quota.overrides`: resource group to limit. */
  quotaOverrides: z.record(z.string(), positive).default({}),
});
export type GitHubConfig = z.output<typeof configSchema>;

/** The App private key from secretspec `GITHUB_APP_PRIVATE_KEY`, as PEM. */
export const credentialSchema = z.union([
  z
    .string()
    .min(1)
    .transform((privateKey) => ({ privateKey })),
  z.strictObject({ privateKey: z.string().min(1) }),
]);
export type GitHubCredential = z.output<typeof credentialSchema>;

function invalid(message: string): AdapterError {
  return new AdapterError({ code: 'invalid', provider: PROVIDER, message });
}

/** Parses the runtime config and refuses placeholder App ids. */
export function parseConfig(config: unknown): GitHubConfig {
  const parsed = configSchema.safeParse(config);
  if (!parsed.success) throw invalid('Invalid GitHub endpoint options');
  if (parsed.data.appId === 0 || parsed.data.installationId === 0) {
    throw invalid('The GitHub App id and installation id are not configured (0 means unset)');
  }
  return parsed.data;
}

export function parseCredential(credential: unknown): GitHubCredential {
  const parsed = credentialSchema.safeParse(credential);
  if (!parsed.success) throw invalid('Invalid GitHub credential');
  return parsed.data;
}
