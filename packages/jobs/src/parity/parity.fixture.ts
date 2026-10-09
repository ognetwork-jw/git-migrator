/**
 * Test harness of the Parity Check: a Bitbucket-to-GitHub Route in a throw-away database and a stub
 * connector whose Facet documents the test sets. The real registry translates and compares, so the
 * desired documents are the ones production computes. Not part of the package API.
 */
import { AdapterError } from '@git-migrator/adapter-sdk';
import { resolveRoutePolicies, translateFacet } from '@git-migrator/core';
import type { Db } from '@git-migrator/db';
import { createLogger, type Logger } from '@git-migrator/observability';
import { createBuiltinRegistry } from '@git-migrator/registry';
import type { EndpointConnector } from '../inventory/connector.ts';
import type { ParityDeps } from './compute.ts';

export const silent: Logger = createLogger({ level: 'silent' });
export const registry = createBuiltinRegistry();
export const NOW = new Date('2026-10-09T12:00:00.000Z');
export const never = new AbortController();

export const SHA_A = 'a'.repeat(40);
export const SHA_B = 'b'.repeat(40);
export const SHA_C = 'c'.repeat(40);

export const SETTINGS = {
  description: 'a repository',
  homepage: null,
  visibility: 'private',
  features: { issues: true, wiki: false },
  forking: 'allowed',
};
export const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyMaterialForTests';
export const KEYS = { keys: [{ publicKey: KEY, title: 'ci', readOnly: true }] };
export const REFS = {
  defaultBranch: 'main',
  refs: [{ name: 'refs/heads/main', kind: 'branch', target: SHA_A }],
  ignoredRefs: [],
  lfs: {},
};

const env = {
  identities: { resolve: () => ({ status: 'unmapped' as const }) },
  groups: { resolve: () => ({ status: 'team_missing' as const }) },
  policies: resolveRoutePolicies({}),
  route: {},
  routeIndex: {},
};

/** The desired target document the registry derives from a source document. */
export function desiredOf(key: string, source: unknown): unknown {
  return translateFacet(registry.facets, key, source, {
    env,
    pair: { source: 'bitbucket-cloud', target: 'github' },
  }).desired;
}

type Reader = () => unknown | Promise<unknown>;

/** What the stub providers answer. Every Facet document is a function, so a test can make it throw. */
export class Sim {
  readonly source = new Map<string, Reader>();
  readonly target = new Map<string, Reader>();
  targetExists = true;
  /** Provider id the target lookup answers with (the migrated repository is `tgt-1`). */
  targetProviderId = 'tgt-1';
  /** Units acquired in the source's git bucket; `denyGit` makes the grant fail (rate limited). */
  readonly gitUnits: number[] = [];
  denyGit = false;
  /** `compare(base, head)` of the target (FAC-GIT-006). */
  relation: (base: string, head: string) => Promise<string> = async () => 'identical';
  /** Object ids the target cannot serve (FAC-GIT-005). */
  lfsMissing: string[] = [];
  readonly compareCalls: string[] = [];
  readonly lfsCalls: string[][] = [];
  connects = 0;

  /** A Facet the source holds; the target gets the translated desired document (an equal target). */
  both(key: string, source: unknown): this {
    this.source.set(key, () => source);
    this.target.set(key, () => desiredOf(key, source));
    return this;
  }

  /** Source and target documents that differ by the given target document. */
  differ(key: string, source: unknown, target: unknown): this {
    this.source.set(key, () => source);
    this.target.set(key, () => target);
    return this;
  }

  private connection(side: 'source' | 'target') {
    const docs = side === 'source' ? this.source : this.target;
    const facets: Record<string, unknown> = {};
    for (const [key, reader] of docs) {
      facets[key] = {
        async read(_ctx: unknown, target?: { frameworkResources?: { publicKey?: string }[] }) {
          const data = (await reader()) as { keys?: { publicKey: string }[] };
          // Like an adapter: leave out the resources the framework names (LIF-045, by identity).
          const own = new Set((target?.frameworkResources ?? []).map((f) => f.publicKey));
          const kept =
            own.size > 0 && Array.isArray(data?.keys)
              ? { ...data, keys: data.keys.filter((k) => !own.has(k.publicKey)) }
              : data;
          return { data: kept, unreadable: [], warnings: [], rawResponseIds: [] };
        },
      };
    }
    const sim = this;
    return {
      facets,
      http: { request: async () => ({ status: 200, body: {} }) },
      limits: { repositoryName: { maxLength: 100, pattern: /^[A-Za-z0-9._-]+$/ } },
      inventory: {
        async getRepository() {
          return side === 'target' && sim.targetExists
            ? { providerId: sim.targetProviderId, slug: 'plat-r', name: 'plat-r' }
            : null;
        },
      },
      refs: {
        async compare(_ref: unknown, base: string, head: string) {
          sim.compareCalls.push(`${base}...${head}`);
          return sim.relation(base, head);
        },
      },
      lfs: {
        async missing(_ref: unknown, oids: string[]) {
          sim.lfsCalls.push(oids);
          return oids.filter((o) => sim.lfsMissing.includes(o));
        },
      },
      git: { remoteUrl: () => 'https://git.example/x.git', credential: async () => ({}) },
    };
  }

  connector(): EndpointConnector {
    return {
      gitQuota: () => ({
        acquire: async (units: number) => {
          if (this.denyGit) throw rateLimitedError();
          this.gitUnits.push(units);
        },
      }),
      connect: async (endpointId) => {
        this.connects++;
        return this.connection(endpointId.startsWith('src') ? 'source' : 'target') as never;
      },
    };
  }
}

export const transientError = (): AdapterError =>
  new AdapterError({ code: 'transient', provider: 'x', message: 'upstream 503', retryable: true });
export const rateLimitedError = (): AdapterError =>
  new AdapterError({
    code: 'rate_limited',
    provider: 'x',
    message: 'slow down',
    retryAfterMs: 5000,
  });

export interface ParityWorld {
  readonly routeId: string;
  readonly actorId: string;
  readonly migrationId: string;
  readonly sourceEndpointId: string;
  readonly targetEndpointId: string;
  readonly sourceRepositoryId: string;
  readonly targetRepositoryId: string;
}

let counter = 0;

/** A Route with a source repository, a target repository and a Migration at `status`. */
export async function seedParityWorld(
  db: Db,
  status:
    | 'analyzed'
    | 'migrated'
    | 'partial'
    | 'verified'
    | 'manually_completed'
    | 'drifted' = 'migrated',
  extra: {
    sourceReadOnlyApplied?: boolean;
    lfsBytes?: bigint | null;
    scope?: 'repository' | 'endpoint';
  } = {},
): Promise<ParityWorld> {
  const n = ++counter;
  const actor = await db.actor.create({
    data: { kind: 'service', role: 'operator', displayName: `p${n}`, email: `p${n}@test.local` },
  });
  const endpoint = (id: string, providerType: string) =>
    db.endpoint.create({
      data: {
        id,
        providerType,
        displayName: id,
        baseUrl: `http://${id}.test`,
        status: 'active',
        configHash: 'h',
      },
    });
  const source = await endpoint(`src-p${n}`, 'bitbucket-cloud');
  const target = await endpoint(`dst-p${n}`, 'github');
  const targetNs = await db.namespace.create({
    data: {
      endpointId: target.id,
      providerId: 'org',
      kind: 'organization',
      slug: 'acme',
      name: 'acme',
    },
  });
  const route = await db.route.create({
    data: {
      id: `route-p${n}`,
      sourceEndpointId: source.id,
      targetEndpointId: target.id,
      targetNamespaceId: targetNs.id,
      targetNamespacePath: 'acme',
      policies: {},
      defaults: {},
      configHash: 'h',
      sourcePostAction: 'read-only',
    },
  });
  const sourceNs = await db.namespace.create({
    data: {
      endpointId: source.id,
      providerId: `ns-${n}`,
      kind: 'project',
      slug: 'PLAT',
      key: 'PLAT',
      name: 'Plat',
    },
  });
  const sourceRepository = await db.repository.create({
    data: {
      endpointId: source.id,
      namespaceId: sourceNs.id,
      providerId: `uuid-r-${n}`,
      slug: 'r',
      name: 'r',
      fullPath: 'acme/PLAT/r',
      isPrivate: true,
      lfsBytes: extra.lfsBytes ?? null,
      lastInventoriedAt: new Date(),
    },
  });
  const targetRepository = await db.repository.create({
    data: {
      endpointId: target.id,
      namespaceId: targetNs.id,
      providerId: 'tgt-1',
      slug: 'plat-r',
      name: 'plat-r',
      fullPath: 'acme/plat-r',
      isPrivate: true,
      lastInventoriedAt: new Date(),
    },
  });
  const migration =
    extra.scope === 'endpoint'
      ? await db.migration.create({
          data: { scope: 'endpoint', routeId: route.id, status, readiness: 'ready' },
        })
      : await db.migration.create({
          data: {
            scope: 'repository',
            routeId: route.id,
            sourceRepositoryId: sourceRepository.id,
            targetRepositoryId: targetRepository.id,
            status,
            readiness: 'ready',
            sourceReadOnlyApplied: extra.sourceReadOnlyApplied ?? false,
            ...(status === 'drifted' ? { statusBeforeDrift: 'verified' } : {}),
          },
        });
  return {
    routeId: route.id,
    actorId: actor.id,
    migrationId: migration.id,
    sourceEndpointId: source.id,
    targetEndpointId: target.id,
    sourceRepositoryId: sourceRepository.id,
    targetRepositoryId: targetRepository.id,
  };
}

export function parityDeps(
  db: Db,
  pool: ParityDeps['appPool'],
  sim: Sim,
  extra: Partial<ParityDeps> = {},
): ParityDeps {
  return {
    db,
    appPool: pool,
    connector: sim.connector(),
    registry,
    git: { lsRemote: async () => ({ refs: [] }) },
    log: silent,
    now: () => NOW,
    ...extra,
  };
}
