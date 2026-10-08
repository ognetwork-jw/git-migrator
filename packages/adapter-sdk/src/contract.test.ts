import type { QuotaLeases, QuotaService } from '@git-migrator/quota';
import { bucketKey } from '@git-migrator/quota';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { LeaseGate, QuotaGate } from './http.ts';
import { ProviderHttpClient } from './http.ts';
import { noopLogger } from './logger.ts';
import type {
  AdapterContext,
  DriverContext,
  EndpointConnection,
  EndpointRuntime,
  FacetDriver,
  FacetRead,
  GitAccess,
  GitClient,
  MutationRecord,
  ProviderAdapter,
  RepositoryRef,
} from './types.ts';

// The real services satisfy the gates the client needs (compile-time check).
const _quota: (service: QuotaService) => QuotaGate = (service) => service;
const _leases: (leases: QuotaLeases) => LeaseGate = (leases) => leases;
void _quota;
void _leases;

const repo: RepositoryRef = {
  providerId: 'r1',
  namespace: { providerId: 'n1', slug: 'ns' },
  slug: 'r',
};

const git: GitClient = {
  lsRemote: async () => ({ refs: [{ name: 'refs/heads/main', sha: 'a'.repeat(40) }] }),
};

function http(): ProviderHttpClient {
  return new ProviderHttpClient({
    provider: 'fake',
    endpointId: 'ep',
    baseUrl: 'http://127.0.0.1:1/',
    classify: () => ({
      endpoint: 'e',
      buckets: [{ key: bucketKey('ep', 'a', 'core'), limit: 1, windowSeconds: 1 }],
    }),
    authorize: async () => ({ headers: {} }),
    quota: {
      acquire: async () => ({ granted: true, at: new Date(), buckets: [] }),
      recordFeedback: async () => {},
      recordRateLimited: async () => new Date(),
      recordSecondaryLimit: async () => new Date(),
      adjust: async () => {},
    },
    logger: noopLogger,
    environment: 'test',
  });
}

/** A minimal adapter written only against the SDK exports. */
function stubAdapter(): ProviderAdapter {
  const readOnly: FacetDriver<{ description: string }> = {
    read: async () => ({
      data: { description: 'd' },
      unreadable: [],
      warnings: [],
      rawResponseIds: ['raw-1'],
    }),
  };
  const writable: FacetDriver<{ description: string }> = {
    ...readOnly,
    async *apply(_ctx, _target, desired, current) {
      if (current?.description === desired.description) return;
      const record: MutationRecord = {
        facetKey: 'repository-settings',
        action: 'update',
        resourceRef: { repo: repo.providerId },
        paths: ['/description'],
        before: current,
        after: desired,
      };
      yield record;
    },
  };
  const gitAccess: GitAccess = {
    remoteUrl: (r) => `https://git.example.test/${r.namespace.slug}/${r.slug}.git`,
    credential: async () => ({ username: 'x', password: 'y' }),
  };
  return {
    type: 'fake',
    displayName: 'Fake',
    namespaceLevels: [{ kind: 'org', label: 'Organization', holdsRepositories: true }],
    capabilities: {
      facets: {
        'repository-settings': {
          read: true,
          write: true,
          fields: {
            '/description': { kind: 'supported' },
            '/topics': { kind: 'constrained', constraint: 'max 20' },
          },
        },
        'git-refs': { read: true, write: false, fields: {} },
      },
    },
    configSchema: z.object({}),
    credentialSchema: z.object({ token: z.string() }),
    async connect(_endpoint: EndpointRuntime, ctx: AdapterContext): Promise<EndpointConnection> {
      void ctx;
      return {
        inventory: {
          listNamespaces: async () => ({ items: [] }),
          listRepositories: async () => ({ items: [], nextCursor: 'c' }),
          getRepository: async () => null,
          findRepository: async () => null,
          listIdentities: async () => ({ items: [] }),
          listGroups: async () => ({ items: [] }),
        },
        repositories: {
          create: async () => {
            throw new Error('not used');
          },
          delete: async () => {},
          isEmpty: async () => true,
        },
        git: gitAccess,
        facets: {
          'repository-settings': writable as FacetDriver<unknown>,
          'git-refs': readOnly as FacetDriver<unknown>,
        },
        refs: {
          setDefaultBranch: async () => ({
            facetKey: null,
            action: 'update',
            resourceRef: {},
            paths: [],
            before: null,
            after: null,
          }),
          compare: async () => 'identical',
        },
        lfs: { missing: async (_ref, oids) => oids },
        limits: {
          repositoryName: { maxLength: 100, pattern: /^[a-z]+$/, caseInsensitiveUnique: true },
          hiddenRefPrefixes: [],
        },
        http: http(),
      };
    },
  };
}

describe('adapter SDK contract', () => {
  const ctx: AdapterContext = {
    quota: {
      acquire: async () => ({ granted: true, at: new Date(), buckets: [] }),
      recordFeedback: async () => {},
      recordRateLimited: async () => new Date(),
      recordSecondaryLimit: async () => new Date(),
      adjust: async () => {},
    },
    logger: noopLogger,
    git,
    pool: 'background',
    signal: new AbortController().signal,
  };
  const endpoint: EndpointRuntime = {
    id: 'ep',
    baseUrl: 'http://127.0.0.1:1/',
    config: {},
    credential: { token: 't' },
    accountKey: 'a',
  };

  it('[ADP-010] an adapter built only from SDK exports connects and exposes the connection surface', async () => {
    const adapter = stubAdapter();
    const connection = await adapter.connect(endpoint, ctx);
    expect(adapter.type).toBe('fake');
    expect(adapter.namespaceLevels[0]).toEqual({
      kind: 'org',
      label: 'Organization',
      holdsRepositories: true,
    });
    expect(adapter.credentialSchema.safeParse({ token: 't' }).success).toBe(true);
    expect(adapter.credentialSchema.safeParse({}).success).toBe(false);
    expect((await connection.inventory.listRepositories(repo.namespace)).nextCursor).toBe('c');
    expect(await connection.refs.compare(repo, 'a', 'b')).toBe('identical');
    expect(await connection.lfs.missing(repo, ['o1'])).toEqual(['o1']);
    expect(connection.http).toBeInstanceOf(ProviderHttpClient);
    expect(connection.changeRequests).toBeUndefined();
  });

  it('[ADP-011] a driver without apply is read-only, one with apply yields nothing when already equal', async () => {
    const connection = await stubAdapter().connect(endpoint, ctx);
    const driverCtx: DriverContext = {
      http: connection.http,
      git,
      logger: noopLogger,
      pool: 'interactive',
      signal: ctx.signal,
    };
    const target = { scope: 'repository', repository: repo, namespace: repo.namespace } as const;
    const readOnly = connection.facets['git-refs'] as FacetDriver<unknown>;
    expect(readOnly.apply).toBeUndefined();
    const writable = connection.facets['repository-settings'] as FacetDriver<{
      description: string;
    }>;
    const read: FacetRead<{ description: string }> = await writable.read(driverCtx, target);
    expect(read.rawResponseIds).toEqual(['raw-1']);
    expect(read.unreadable).toEqual([]);
    expect(read.warnings).toEqual([]);
    const apply = writable.apply;
    expect(apply).toBeDefined();
    const mutations: MutationRecord[] = [];
    for await (const m of (apply as NonNullable<typeof apply>).call(
      writable,
      driverCtx,
      target,
      { description: 'new' },
      { description: 'old' },
      [],
    )) {
      mutations.push(m);
    }
    expect(mutations).toHaveLength(1);
    const again: MutationRecord[] = [];
    for await (const m of (apply as NonNullable<typeof apply>).call(
      writable,
      driverCtx,
      target,
      { description: 'same' },
      { description: 'same' },
      [],
    )) {
      again.push(m);
    }
    expect(again).toEqual([]);
  });

  it('[ADP-012] a MutationRecord names the facet, action, resource, canonical paths and before/after', () => {
    const record: MutationRecord = {
      facetKey: 'branch-rules',
      action: 'create',
      resourceRef: { id: 1 },
      paths: ['/rules[pattern=main]'],
      before: null,
      after: { pattern: 'main' },
    };
    expect(Object.keys(record).sort()).toEqual(
      ['action', 'after', 'before', 'facetKey', 'paths', 'resourceRef'].sort(),
    );
  });

  it('[ADP-013] driver contexts and reads carry warnings for relevant unknown provider fields', async () => {
    const driver: FacetDriver<{ a: number }> = {
      read: async () => ({
        data: { a: 1 },
        unreadable: ['/secret'],
        warnings: [{ code: 'x.unknown-field', paths: ['/extra'], params: { field: 'extra' } }],
        rawResponseIds: [],
      }),
    };
    const result = await driver.read(
      {
        http: http(),
        git,
        logger: noopLogger,
        pool: 'background',
        signal: ctx.signal,
      },
      { scope: 'endpoint', namespace: repo.namespace },
    );
    expect(result.warnings[0]?.code).toBe('x.unknown-field');
    expect(result.unreadable).toEqual(['/secret']);
  });

  it('[ADP-014] capabilities declare read, write and per-field support', () => {
    const caps = stubAdapter().capabilities.facets['repository-settings'];
    expect(caps).toMatchObject({ read: true, write: true });
    expect(caps?.fields['/topics']).toEqual({ kind: 'constrained', constraint: 'max 20' });
    expect(stubAdapter().capabilities.facets['git-refs']?.write).toBe(false);
  });

  it('[ADP-070] git access gives a credential-free remote URL and a separate credential', async () => {
    const connection = await stubAdapter().connect(endpoint, ctx);
    const url = connection.git.remoteUrl(repo);
    expect(url).toBe('https://git.example.test/ns/r.git');
    expect(new URL(url).username).toBe('');
    expect(new URL(url).password).toBe('');
    expect(await connection.git.credential(repo)).toEqual({ username: 'x', password: 'y' });
  });

  it('[ADP-070] the GitClient interface returns refs with annotated tag peeling and the HEAD symref', async () => {
    const client: GitClient = {
      lsRemote: async () => ({
        refs: [{ name: 'refs/tags/v1', sha: 'b'.repeat(40), peeled: 'c'.repeat(40) }],
        headSymref: 'refs/heads/main',
      }),
    };
    const result = await client.lsRemote({
      url: 'https://git.example.test/x.git',
      credential: { username: 'u', password: 'p' },
    });
    expect(result.refs[0]?.peeled).toBe('c'.repeat(40));
    expect(result.headSymref).toBe('refs/heads/main');
  });
});
