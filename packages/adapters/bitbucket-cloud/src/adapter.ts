/** The Bitbucket Cloud `ProviderAdapter` (ADP-010). */
import {
  type AdapterContext,
  AdapterError,
  type EndpointConnection,
  type EndpointRuntime,
  type ProviderAdapter,
  type ProviderCapabilities,
  type ProviderLimits,
} from '@git-migrator/adapter-sdk';
import { FACET_KEYS, type FacetKey } from '@git-migrator/canonical';
import type { FacetCapability } from '@git-migrator/core';
import type { z } from 'zod';
import { envelope, getOne } from './api.ts';
import { createClient } from './client.ts';
import {
  type BitbucketConfig,
  type BitbucketCredential,
  configSchema,
  credentialSchema,
  PROVIDER,
} from './config.ts';
import { createFacetDrivers } from './facets.ts';
import { createGitAccess } from './git-access.ts';
import { createInventory } from './inventory.ts';
import { type Ctx, Reader } from './reader.ts';
import { createSourceLock } from './source-lock.ts';

/**
 * Every Facet is readable and none is writable: Bitbucket is the source (ADP-014). Fields default
 * to `supported`. Statically unreadable values are declared (FAC-WEB-003 webhook secrets,
 * FAC-VAR-001 and FAC-END secured values). What cannot be read for one repository is reported
 * per read through `FacetRead.capabilities` / `unreadable`, not here (for example merge-settings
 * `/allowed` and `/deleteBranchOnMerge`, FAC-MRG-002).
 */
const UNREADABLE: FacetCapability['fields'][string] = { kind: 'unreadable' };
const STATIC_UNREADABLE: Partial<Record<FacetKey, FacetCapability['fields']>> = {
  webhooks: { '/hooks/secret': UNREADABLE },
  'org-webhooks': { '/hooks/secret': UNREADABLE },
  secrets: { '/secrets/value': UNREADABLE },
  'org-secrets': { '/secrets/value': UNREADABLE },
};

export const capabilities: ProviderCapabilities = {
  facets: Object.fromEntries(
    FACET_KEYS.map((key) => [
      key,
      { read: true, write: false, fields: STATIC_UNREADABLE[key] ?? {} },
    ]),
  ),
};

/** Unverified provider limits (ADR-0036); only relevant if Bitbucket is ever a target. */
export const limits: ProviderLimits = {
  repositoryName: {
    maxLength: 62,
    pattern: /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/,
    caseInsensitiveUnique: true,
  },
  hiddenRefPrefixes: [],
};

function parseOrThrow<S extends z.ZodType>(schema: S, value: unknown, what: string): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  // Paths only: a credential value must never reach an error message.
  const paths = [...new Set(result.error.issues.map((i) => i.path.join('.') || '(root)'))].join(
    ', ',
  );
  throw new AdapterError({
    code: 'invalid',
    provider: PROVIDER,
    message: `Invalid ${what}: ${paths}`,
  });
}

const unsupported = (what: string) => async (): Promise<never> => {
  throw new AdapterError({
    code: 'unsupported',
    provider: PROVIDER,
    message: `${what} is not supported: Bitbucket Cloud is a source provider`,
  });
};

export const bitbucketCloudAdapter: ProviderAdapter = {
  type: PROVIDER,
  displayName: 'Bitbucket Cloud',
  namespaceLevels: [
    { kind: 'workspace', label: 'Workspace', holdsRepositories: false },
    { kind: 'project', label: 'Project', holdsRepositories: true },
  ],
  capabilities,
  configSchema,
  credentialSchema,

  async connect(endpoint: EndpointRuntime, ctx: AdapterContext): Promise<EndpointConnection> {
    const config: BitbucketConfig = parseOrThrow(configSchema, endpoint.config, 'endpoint config');
    const credential: BitbucketCredential = parseOrThrow(
      credentialSchema,
      endpoint.credential,
      'credential',
    );
    const { client } = createClient({
      endpointId: endpoint.id,
      baseUrl: endpoint.baseUrl,
      config,
      credential,
      accountKey: endpoint.accountKey,
      ctx,
    });
    const git = createGitAccess({
      workspace: config.workspace,
      gitBaseUrl: config.gitBaseUrl,
      credential,
    });
    const reader = new Reader({ workspace: config.workspace, git });
    const ctxOf = (): Ctx => ({
      http: client,
      git: ctx.git,
      logger: ctx.logger,
      pool: ctx.pool,
      signal: ctx.signal,
    });
    const inventory = createInventory(reader, ctxOf);
    return {
      inventory,
      repositories: {
        create: unsupported('Creating a repository'),
        delete: unsupported('Deleting a repository'),
        // An empty repository has no main branch.
        isEmpty: async (ref) => {
          const repo = await inventory.getRepository(ref);
          if (repo === null) {
            throw new AdapterError({
              code: 'not_found',
              provider: PROVIDER,
              message: 'The repository does not exist',
            });
          }
          if (repo.defaultBranch != null) return false;
          // No main branch: empty only if there are no branches at all.
          const c = ctxOf();
          const { data } = await getOne(
            { http: client, ctx: c },
            `${reader.repoPath(ref.slug)}/refs/branches`,
            envelope,
            'branches',
            { query: { pagelen: 1 }, capture: false },
          );
          return (data?.values.length ?? 0) === 0;
        },
      },
      git,
      facets: createFacetDrivers(reader),
      refs: {
        setDefaultBranch: unsupported('Setting the default branch'),
        compare: unsupported('Comparing refs'),
      },
      lfs: { missing: unsupported('Checking LFS objects') },
      sourceLock: createSourceLock({ reader, http: client, ctxOf, logger: ctx.logger }),
      limits,
      http: client,
    };
  },
};
